import {
  spawn as nodeSpawn,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";

export const POWERSHELL_EXECUTABLE = "powershell.exe";
export const POWERSHELL_FIXED_ARGS = [
  "-NoProfile",
  "-NonInteractive",
  "-EncodedCommand",
] as const;
export const DEFAULT_POWERSHELL_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
export const DEFAULT_MAX_PROTOCOL_LINE_BYTES = 512 * 1024;

export interface PowerShellChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly killed?: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "error", listener: (error: Error) => void): this;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export type PowerShellSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"] },
) => PowerShellChild;

export interface SpawnPowerShellOptions {
  readonly spawn?: PowerShellSpawn;
  readonly executable?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export function encodePowerShellScript(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function spawnPowerShellScript(
  script: string,
  options: SpawnPowerShellOptions = {},
): PowerShellChild {
  const spawnImpl = options.spawn ?? (nodeSpawn as unknown as PowerShellSpawn);
  const args = [...POWERSHELL_FIXED_ARGS, encodePowerShellScript(script)];
  return spawnImpl(options.executable ?? POWERSHELL_EXECUTABLE, args, {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
}

export function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  return new DOMException("The operation was aborted", "AbortError");
}

export function timeoutError(label: string): Error {
  return new DOMException(`${label} timed out`, "TimeoutError");
}

export function terminatePowerShell(child: PowerShellChild): void {
  if (child.killed) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // The process may already have exited.
  }
}

export class BoundedTextCollector {
  private readonly decoder = new StringDecoder("utf8");
  private bytes = 0;
  private text = "";

  constructor(readonly maxBytes = DEFAULT_MAX_STDERR_BYTES) {}

  push(chunk: Buffer | Uint8Array | string): void {
    const buffer =
      typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    this.bytes += buffer.byteLength;
    if (this.bytes > this.maxBytes)
      throw new Error("PowerShell stderr exceeded its size limit");
    this.text += this.decoder.write(buffer);
  }

  finish(): string {
    this.text += this.decoder.end();
    return this.text;
  }

  get byteLength(): number {
    return this.bytes;
  }
}

export class PowerShellLineDecoder {
  private pending = Buffer.alloc(0);

  constructor(
    private readonly onLine: (line: string) => void,
    readonly maxLineBytes = DEFAULT_MAX_PROTOCOL_LINE_BYTES,
  ) {}

  push(chunk: Buffer | Uint8Array | string): void {
    const next =
      typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    this.pending =
      this.pending.length === 0 ? next : Buffer.concat([this.pending, next]);
    while (true) {
      const newline = this.pending.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > this.maxLineBytes)
        throw new Error("PowerShell protocol line exceeded its size limit");
      let lineBytes = this.pending.subarray(0, newline);
      this.pending = this.pending.subarray(newline + 1);
      if (lineBytes.at(-1) === 0x0d) lineBytes = lineBytes.subarray(0, -1);
      if (lineBytes.some((byte) => byte > 0x7f))
        throw new Error("PowerShell protocol emitted a non-ASCII line");
      this.onLine(lineBytes.toString("ascii"));
    }
    if (this.pending.length > this.maxLineBytes) {
      throw new Error("PowerShell protocol line exceeded its size limit");
    }
  }

  finish(): void {
    if (this.pending.length !== 0)
      throw new Error("PowerShell protocol ended with an incomplete line");
  }
}

const PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::Out.Write('ok')
`;

export interface ProbePowerShellOptions extends SpawnPowerShellOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export async function probePowerShell(
  options: ProbePowerShellOptions = {},
): Promise<void> {
  if (options.signal?.aborted) throw abortError(options.signal.reason);
  const child = spawnPowerShellScript(PROBE_SCRIPT, options);
  const timeoutMs = options.timeoutMs ?? 3_000;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let output = "";
    const stderr = new BoundedTextCollector(4 * 1024);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const fail = (error: Error): void => {
      terminatePowerShell(child);
      finish(error);
    };
    const onAbort = (): void => fail(abortError(options.signal?.reason));
    const timer = setTimeout(
      () => fail(timeoutError("PowerShell capability check")),
      timeoutMs,
    );

    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdin.end();
    child.stdout.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
      if (Buffer.byteLength(output) > 16)
        fail(new Error("PowerShell capability check returned invalid output"));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      try {
        stderr.push(chunk);
      } catch {
        fail(
          new Error(
            "PowerShell capability check produced excessive error output",
          ),
        );
      }
    });
    child.once("error", () =>
      finish(new Error("PowerShell helper is unavailable")),
    );
    child.once("close", (code) => {
      try {
        stderr.finish();
      } catch {
        // Its content is deliberately never included in the error.
      }
      if (code === 0 && output === "ok") finish();
      else
        finish(
          new Error(
            `PowerShell helper capability check failed${code === null ? "" : ` (exit ${code})`}`,
          ),
        );
    });
  });
}
