import { spawn as nodeSpawn } from "node:child_process";
import { isIP } from "node:net";
import { release as osRelease } from "node:os";
import { posix, resolve as resolvePath, win32 } from "node:path";
import type { Readable, Writable } from "node:stream";

import type { HexHubConfig } from "./contracts.js";
import type { HexHubLocalPathHook } from "./input-adapters.js";
import type { FetchLike, HexHubFetchResolver } from "./mcp-client.js";
import { probePowerShell, type PowerShellSpawn } from "./powershell.js";
import {
  TunnelBridgeManager,
  createTunnelResultHook,
  type TunnelBridgeManagerOptions,
} from "./tunnel-bridge.js";
import type { HexHubTunnelResultHook } from "./tool-controller.js";
import { createWindowsFetch as defaultCreateWindowsFetch } from "./windows-fetch.js";

export interface HexHubPlatformInfo {
  readonly platform: NodeJS.Platform;
  readonly isWindows: boolean;
  readonly isWsl: boolean;
}

export interface DetectHexHubPlatformOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly release?: string;
}

export function detectHexHubPlatform(
  options: DetectHexHubPlatformOptions = {},
): HexHubPlatformInfo {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const release = options.release ?? osRelease();
  const isWindows = platform === "win32";
  const isWsl =
    platform === "linux" &&
    (Boolean(env.WSL_DISTRO_NAME?.trim()) ||
      Boolean(env.WSL_INTEROP?.trim()) ||
      /microsoft|wsl/i.test(release));
  return { platform, isWindows, isWsl };
}

export function isHexHubLoopbackHost(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "");
  if (host === "localhost" || host === "::1") return true;
  if (host.startsWith("::ffff:")) return isHexHubLoopbackHost(host.slice(7));
  if (isIP(host) === 4) return host.split(".")[0] === "127";
  return false;
}

export function assertHexHubUrlPolicy(value: string | URL): URL {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value) : new URL(value);
  } catch {
    throw new TypeError("HexHub URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("HexHub URL must use HTTP or HTTPS");
  }
  if (url.username || url.password)
    throw new TypeError("HexHub URL must not contain credentials");
  if (url.protocol === "http:" && !isHexHubLoopbackHost(url.hostname)) {
    throw new TypeError(
      "HexHub HTTP is allowed only for loopback endpoints; use HTTPS for network hosts",
    );
  }
  return url;
}

export interface HexHubFetchResolverOptions
  extends DetectHexHubPlatformOptions {
  readonly platformInfo?: HexHubPlatformInfo;
  readonly directFetch?: FetchLike;
  readonly spawn?: PowerShellSpawn;
  readonly powerShellExecutable?: string;
  readonly probe?: () => void | Promise<void>;
  readonly windowsFetchFactory?: (config: HexHubConfig) => FetchLike;
}

export function createHexHubFetchResolver(
  options: HexHubFetchResolverOptions = {},
): HexHubFetchResolver {
  const platform = options.platformInfo ?? detectHexHubPlatform(options);
  const directFetch =
    options.directFetch ?? (globalThis.fetch.bind(globalThis) as FetchLike);
  let capability: Promise<void> | undefined;
  const checkCapability = (): Promise<void> => {
    capability ??= Promise.resolve()
      .then(() =>
        options.probe
          ? options.probe()
          : probePowerShell({
              ...(options.spawn ? { spawn: options.spawn } : {}),
              ...(options.powerShellExecutable
                ? { executable: options.powerShellExecutable }
                : {}),
            }),
      )
      .catch((error: unknown) => {
        capability = undefined;
        const message =
          error instanceof Error && error.name === "TimeoutError"
            ? "PowerShell helper capability check timed out"
            : "PowerShell helper is unavailable";
        throw new Error(message);
      });
    return capability;
  };

  return async (config) => {
    const url = assertHexHubUrlPolicy(config.url);
    const useHelper =
      config.transport === "windows-helper" ||
      (config.transport === "auto" &&
        platform.isWsl &&
        isHexHubLoopbackHost(url.hostname));
    if (!useHelper) return { fetch: directFetch, kind: "direct" };
    await checkCapability();
    const fetch =
      options.windowsFetchFactory?.(config) ??
      defaultCreateWindowsFetch({
        timeoutMs: config.timeoutMs,
        ...(options.spawn ? { spawn: options.spawn } : {}),
        ...(options.powerShellExecutable
          ? { executable: options.powerShellExecutable }
          : {}),
      });
    return { fetch, kind: "windows-helper" };
  };
}

interface PlatformCommandChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly killed?: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export interface PlatformCommandSpawnOptions {
  readonly shell: false;
  readonly windowsHide: true;
  readonly stdio: readonly ["ignore", "pipe", "pipe"];
}

export type PlatformCommandSpawn = (
  command: string,
  args: readonly string[],
  options: PlatformCommandSpawnOptions,
) => PlatformCommandChild;

export interface HexHubLocalPathOptions extends DetectHexHubPlatformOptions {
  readonly platformInfo?: HexHubPlatformInfo;
  readonly commandSpawn?: PlatformCommandSpawn;
  readonly timeoutMs?: number;
}

function windowsAbsolute(path: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\(?:\?\\|\.\\|[^\\])/u.test(path)
  );
}

function stripPathSigil(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

function terminateCommand(child: PlatformCommandChild): void {
  if (child.killed) return;
  try {
    child.kill("SIGTERM");
  } catch {
    /* It may already have exited. */
  }
}

function runWslPath(
  path: string,
  signal: AbortSignal | undefined,
  options: HexHubLocalPathOptions,
): Promise<string> {
  if (signal?.aborted)
    return Promise.reject(
      signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The operation was aborted", "AbortError"),
    );
  const spawn =
    options.commandSpawn ?? (nodeSpawn as unknown as PlatformCommandSpawn);
  let child: PlatformCommandChild;
  try {
    child = spawn("wslpath", ["-w", "--", path], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return Promise.reject(
      new Error("Could not start wslpath for the HexHub local path"),
    );
  }
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    const finish = (error?: Error, result?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result!);
    };
    const fail = (error: Error): void => {
      terminateCommand(child);
      finish(error);
    };
    const onAbort = (): void =>
      fail(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException("The operation was aborted", "AbortError"),
      );
    const timer = setTimeout(
      () => fail(new DOMException("wslpath timed out", "TimeoutError")),
      options.timeoutMs ?? 10_000,
    );

    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
      if (stdout.byteLength > 64 * 1024)
        fail(new Error("wslpath output exceeded its size limit"));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > 16 * 1024)
        fail(new Error("wslpath error output exceeded its size limit"));
    });
    child.once("error", () => finish(new Error("wslpath is unavailable")));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(
          new Error(`wslpath failed${code === null ? "" : ` (exit ${code})`}`),
        );
        return;
      }
      const decoded = stdout.toString("utf8");
      const result = decoded.trim();
      if (!result || /[\r\n\0]/u.test(result) || !windowsAbsolute(result)) {
        finish(new Error("wslpath returned an invalid Windows path"));
        return;
      }
      finish(undefined, result);
    });
  });
}

export function createHexHubLocalPathHook(
  options: HexHubLocalPathOptions = {},
): HexHubLocalPathHook {
  const platform = options.platformInfo ?? detectHexHubPlatform(options);
  return async (suppliedPath, context) => {
    const path = stripPathSigil(suppliedPath);
    if (!path) throw new Error("HexHub SCP local_path must not be empty");
    if (platform.isWsl) {
      if (windowsAbsolute(path)) return path;
      const absolute = posix.isAbsolute(path)
        ? posix.normalize(path)
        : posix.resolve(context.cwd, path);
      return runWslPath(absolute, context.signal, options);
    }
    if (platform.isWindows)
      return windowsAbsolute(path) ? path : win32.resolve(context.cwd, path);
    return resolvePath(context.cwd, path);
  };
}

export interface HexHubPlatformAdaptersOptions
  extends HexHubFetchResolverOptions,
    HexHubLocalPathOptions {
  readonly tunnel?: Omit<
    TunnelBridgeManagerOptions,
    "isWsl" | "spawn" | "executable"
  >;
}

export interface HexHubPlatformAdapters {
  readonly info: HexHubPlatformInfo;
  readonly fetchResolver: HexHubFetchResolver;
  readonly localPath: HexHubLocalPathHook;
  readonly tunnelManager: TunnelBridgeManager;
  readonly tunnelResult: HexHubTunnelResultHook;
  close(): Promise<void>;
}

export function createHexHubPlatformAdapters(
  options: HexHubPlatformAdaptersOptions = {},
): HexHubPlatformAdapters {
  const info = options.platformInfo ?? detectHexHubPlatform(options);
  const fetchResolver = createHexHubFetchResolver({
    ...options,
    platformInfo: info,
  });
  const localPath = createHexHubLocalPathHook({
    ...options,
    platformInfo: info,
  });
  const tunnelManager = new TunnelBridgeManager({
    ...options.tunnel,
    isWsl: info.isWsl,
    probe: options.tunnel?.probe ?? options.probe,
    ...(options.spawn ? { spawn: options.spawn } : {}),
    ...(options.powerShellExecutable
      ? { executable: options.powerShellExecutable }
      : {}),
  });
  return {
    info,
    fetchResolver,
    localPath,
    tunnelManager,
    tunnelResult: createTunnelResultHook(tunnelManager),
    close: () => tunnelManager.closeAll(),
  };
}
