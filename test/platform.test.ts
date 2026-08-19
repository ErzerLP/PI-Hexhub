import assert from "node:assert/strict";
import test from "node:test";

import type { FetchLike } from "../extensions/hexhub/mcp-client.js";
import type { HexHubConfig } from "../extensions/hexhub/contracts.js";
import {
  assertHexHubUrlPolicy,
  createHexHubFetchResolver,
  createHexHubLocalPathHook,
  detectHexHubPlatform,
  isHexHubLoopbackHost,
  type PlatformCommandSpawn,
} from "../extensions/hexhub/platform.js";
import { FakePowerShellChild } from "./helpers/fake-powershell.js";

function config(
  transport: HexHubConfig["transport"],
  url = "http://127.0.0.1:17321/mcp",
): HexHubConfig {
  return {
    version: 1,
    url,
    transport,
    timeoutMs: 2_000,
    auth: { type: "none" },
    initialGroups: [],
  };
}

const directFetch = (async () => new Response("direct")) as FetchLike;
const helperFetch = (async () => new Response("helper")) as FetchLike;

const WSL = { platform: "linux" as const, isWindows: false, isWsl: true };
const WINDOWS = { platform: "win32" as const, isWindows: true, isWsl: false };
const LINUX = { platform: "linux" as const, isWindows: false, isWsl: false };
const allowWindowsPath = async (): Promise<void> => {};

test("detects Windows and WSL without trusting WSL variables on Windows", () => {
  assert.deepEqual(
    detectHexHubPlatform({
      platform: "win32",
      env: { WSL_DISTRO_NAME: "fake" },
      release: "Windows",
    }),
    WINDOWS,
  );
  assert.deepEqual(
    detectHexHubPlatform({
      platform: "linux",
      env: {},
      release: "6.1-microsoft-standard-WSL2",
    }),
    WSL,
  );
  assert.deepEqual(
    detectHexHubPlatform({
      platform: "linux",
      env: {},
      release: "6.8-generic",
    }),
    LINUX,
  );
});

test("loopback and URL policy allow local HTTP but require HTTPS for network hosts", () => {
  for (const host of [
    "localhost",
    "127.0.0.1",
    "127.99.1.2",
    "::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isHexHubLoopbackHost(host), true, host);
  }
  assert.equal(isHexHubLoopbackHost("localhost.example"), false);
  assert.equal(
    assertHexHubUrlPolicy("http://127.0.0.1:17321/mcp").protocol,
    "http:",
  );
  assert.equal(
    assertHexHubUrlPolicy("https://hexhub.example/mcp").protocol,
    "https:",
  );
  assert.throws(
    () => assertHexHubUrlPolicy("http://192.168.1.10:17321/mcp"),
    /HTTPS/,
  );
  assert.throws(
    () => assertHexHubUrlPolicy("ftp://127.0.0.1/mcp"),
    /HTTP or HTTPS/,
  );
});

test("resolver honors auto, direct, helper capability, and non-loopback selection", async () => {
  let probes = 0;
  const resolver = createHexHubFetchResolver({
    platformInfo: WSL,
    directFetch,
    probe: () => {
      probes += 1;
    },
    windowsFetchFactory: () => helperFetch,
  });
  assert.deepEqual(await resolver(config("auto")), {
    fetch: helperFetch,
    kind: "windows-helper",
  });
  assert.deepEqual(await resolver(config("direct")), {
    fetch: directFetch,
    kind: "direct",
  });
  assert.deepEqual(
    await resolver(config("auto", "https://hexhub.example/mcp")),
    { fetch: directFetch, kind: "direct" },
  );
  assert.deepEqual(
    await resolver(config("windows-helper", "https://hexhub.example/mcp")),
    { fetch: helperFetch, kind: "windows-helper" },
  );
  assert.equal(probes, 1, "the successful capability result is cached");

  const windowsAuto = createHexHubFetchResolver({
    platformInfo: WINDOWS,
    directFetch,
  });
  assert.equal((await windowsAuto(config("auto"))).kind, "direct");

  let directProbed = false;
  const explicitDirect = createHexHubFetchResolver({
    platformInfo: WSL,
    directFetch,
    probe: () => {
      directProbed = true;
      throw new Error("must not run");
    },
  });
  assert.equal((await explicitDirect(config("direct"))).kind, "direct");
  assert.equal(directProbed, false);

  const unavailable = createHexHubFetchResolver({
    platformInfo: WSL,
    probe: () => {
      throw new Error("secret diagnostic");
    },
  });
  await assert.rejects(
    () => Promise.resolve(unavailable(config("windows-helper"))),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "PowerShell helper is unavailable",
  );
});

test("WSL local path conversion uses one literal argv element and validates output", async () => {
  const calls: Array<{
    command: string;
    args: readonly string[];
    options: unknown;
  }> = [];
  const spawn = ((
    command: string,
    args: readonly string[],
    options: unknown,
  ) => {
    const child = new FakePowerShellChild();
    calls.push({ command, args, options });
    queueMicrotask(() => {
      child.stdout.write("D:\\work\\name; touch C:\\bad\r\n");
      child.close(0);
    });
    return child;
  }) as unknown as PlatformCommandSpawn;
  const hook = createHexHubLocalPathHook({
    platformInfo: WSL,
    commandSpawn: spawn,
    windowsPathProbe: allowWindowsPath,
  });
  const supplied = "name; touch /tmp/not-run";
  const converted = await hook(supplied, { cwd: "/work", direction: "upload" });
  assert.equal(converted, "//?/D:/work/name; touch C:/bad");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, "wslpath");
  assert.deepEqual(calls[0]?.args, ["-w", "--", `/work/${supplied}`]);
  assert.deepEqual(calls[0]?.options, {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.equal(
    await hook("C:\\Temp\\already.txt", {
      cwd: "/work",
      direction: "download",
    }),
    "//?/C:/Temp/already.txt",
  );
  assert.equal(calls.length, 1, "Windows absolute paths do not invoke wslpath");
});

test("WSL native paths become forward-slash UNC wire paths after preflight", async () => {
  const spawn = (() => {
    const child = new FakePowerShellChild();
    queueMicrotask(() => {
      child.stdout.write("\\\\wsl.localhost\\Ubuntu\\tmp\\file.txt\r\n");
      child.close(0);
    });
    return child;
  }) as unknown as PlatformCommandSpawn;
  const probes: Array<{ path: string; direction: string }> = [];
  const hook = createHexHubLocalPathHook({
    platformInfo: WSL,
    commandSpawn: spawn,
    windowsPathProbe: async (path, context) => {
      probes.push({ path, direction: context.direction });
    },
  });
  assert.equal(
    await hook("/tmp/file.txt", { cwd: "/work", direction: "download" }),
    "//wsl.localhost/Ubuntu/tmp/file.txt",
  );
  assert.deepEqual(probes, [
    {
      path: "\\\\wsl.localhost\\Ubuntu\\tmp\\file.txt",
      direction: "download",
    },
  ]);
});

test("local path conversion handles Windows relatives, invalid wslpath output, and abort", async () => {
  const windowsHook = createHexHubLocalPathHook({
    platformInfo: WINDOWS,
    windowsPathProbe: allowWindowsPath,
  });
  assert.equal(
    await windowsHook("@folder\\file.txt", {
      cwd: "D:\\work",
      direction: "upload",
    }),
    "//?/D:/work/folder/file.txt",
  );
  assert.equal(
    await windowsHook("C:\\raw.txt", { cwd: "D:\\work", direction: "upload" }),
    "//?/C:/raw.txt",
  );

  const invalidSpawn = (() => {
    const child = new FakePowerShellChild();
    queueMicrotask(() => {
      child.stdout.write("/still/linux\n");
      child.close(0);
    });
    return child;
  }) as unknown as PlatformCommandSpawn;
  const invalidHook = createHexHubLocalPathHook({
    platformInfo: WSL,
    commandSpawn: invalidSpawn,
    windowsPathProbe: allowWindowsPath,
  });
  await assert.rejects(
    () =>
      Promise.resolve(
        invalidHook("file", { cwd: "/work", direction: "upload" }),
      ),
    /invalid Windows path/,
  );

  let abortedChild: FakePowerShellChild | undefined;
  const hangingSpawn = (() => {
    abortedChild = new FakePowerShellChild();
    return abortedChild;
  }) as unknown as PlatformCommandSpawn;
  const abortingHook = createHexHubLocalPathHook({
    platformInfo: WSL,
    commandSpawn: hangingSpawn,
    windowsPathProbe: allowWindowsPath,
  });
  const controller = new AbortController();
  const pending = abortingHook("file", {
    cwd: "/work",
    direction: "download",
    signal: controller.signal,
  });
  controller.abort(new DOMException("cancel path", "AbortError"));
  await assert.rejects(
    () => Promise.resolve(pending),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(abortedChild?.killed, true);
});
