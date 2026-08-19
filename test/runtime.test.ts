import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  HEXHUB_MANAGED_TOOL_NAMES,
  HEXHUB_TOOL_SPECS,
} from "../extensions/hexhub/catalog.js";
import type {
  HexHubCallResult,
  HexHubCatalogSnapshot,
  HexHubConfig,
  HexHubConnectionStatus,
  LoadedHexHubConfig,
  RemoteToolDefinition,
} from "../extensions/hexhub/contracts.js";
import {
  installHexHubExtension,
  type HexHubRuntimeClient,
  type HexHubRuntimeDependencies,
  type HexHubRuntimePlatform,
} from "../extensions/hexhub/runtime.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function catalog(
  epoch = 1,
  omitted: readonly string[] = [],
): HexHubCatalogSnapshot {
  const tools: RemoteToolDefinition[] = HEXHUB_TOOL_SPECS.filter(
    (spec) => !omitted.includes(spec.remoteName),
  ).map((spec) => ({
    name: spec.remoteName,
    inputSchema: clone(spec.reviewedRemoteSchema),
  }));
  tools.push({
    name: "future_tool",
    inputSchema: { type: "object", properties: {} },
  });
  return {
    epoch,
    tools,
    names: new Set(tools.map((tool) => tool.name)),
    unknownNames: [],
    incompatible: new Map(),
  };
}

function emptyCatalog(epoch = 0): HexHubCatalogSnapshot {
  return {
    epoch,
    tools: [],
    names: new Set(),
    unknownNames: [],
    incompatible: new Map(),
  };
}

function config(overrides: Partial<HexHubConfig> = {}): HexHubConfig {
  return {
    version: 1,
    url: "http://127.0.0.1:17321/mcp",
    transport: "direct",
    timeoutMs: 1_000,
    auth: { type: "none" },
    initialGroups: [],
    ...overrides,
  };
}

function loaded(
  value: HexHubConfig,
  deprecatedKeys: string[] = [],
): LoadedHexHubConfig {
  return {
    config: value,
    globalPath: "/isolated/agent/hexhub.json",
    projectPath: "/isolated/project/.pi/hexhub.json",
    globalLoaded: true,
    projectLoaded: true,
    deprecatedKeys,
  };
}

class FakePi {
  readonly tools: Array<Record<string, any>> = [];
  readonly commands = new Map<string, Record<string, any>>();
  readonly handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  active = ["read"];

  getAllTools(): Array<Record<string, any>> {
    return this.tools;
  }
  getActiveTools(): string[] {
    return [...this.active];
  }
  setActiveTools(names: string[]): void {
    this.active = [...names];
  }
  registerTool(tool: Record<string, any>): void {
    this.tools.push(tool);
    this.active = [...new Set([...this.active, String(tool.name)])];
  }
  registerCommand(name: string, command: Record<string, any>): void {
    this.commands.set(name, command);
  }
  on(name: string, handler: (...args: any[]) => unknown): void {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler);
    this.handlers.set(name, handlers);
  }
  async emit(
    name: string,
    event: unknown,
    ctx: ExtensionContext,
  ): Promise<void> {
    for (const handler of this.handlers.get(name) ?? [])
      await handler(event, ctx);
  }
  asApi(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }
}

interface FakeContextState {
  readonly statuses: Map<string, string | undefined>;
  readonly notices: Array<{ message: string; type?: string }>;
  readonly context: ExtensionContext;
}

function createContext(cwd = "/isolated/project"): FakeContextState {
  const statuses = new Map<string, string | undefined>();
  const notices: Array<{ message: string; type?: string }> = [];
  const ui = {
    setStatus: (key: string, value: string | undefined) =>
      statuses.set(key, value),
    notify: (message: string, type?: string) => notices.push({ message, type }),
    confirm: async () => true,
    select: async () => undefined,
    input: async () => undefined,
  } as unknown as ExtensionContext["ui"];
  return {
    statuses,
    notices,
    context: {
      cwd,
      hasUI: true,
      ui,
      isProjectTrusted: () => true,
    } as unknown as ExtensionContext,
  };
}

class FakeClientFactory {
  readonly instances: FakeClient[] = [];
  connectCatalog = catalog();
  reconnectCatalog: HexHubCatalogSnapshot | undefined;
  connectDelay: Promise<void> | undefined;
  onConnect: ((url: string) => void) | undefined;
  probeError = false;

  create(configValue?: HexHubConfig): FakeClient {
    const client = new FakeClient(this, configValue);
    this.instances.push(client);
    return client;
  }
}

class FakeClient implements HexHubRuntimeClient {
  private configValue: HexHubConfig | undefined;
  private generation = 0;
  private currentCatalog = emptyCatalog();
  private status: HexHubConnectionStatus;
  readonly configureCalls: Array<HexHubConfig | undefined> = [];
  readonly toolCalls: Array<{ name: string; args: Record<string, unknown> }> =
    [];
  connectCount = 0;
  reconnectCount = 0;
  closeCount = 0;

  constructor(
    private readonly factory: FakeClientFactory,
    initial?: HexHubConfig,
  ) {
    this.configValue = initial;
    this.status = initial
      ? {
          state: "ready",
          connected: false,
          endpoint: initial.url,
          catalogEpoch: 0,
          remoteToolCount: 0,
        }
      : {
          state: "unconfigured",
          connected: false,
          catalogEpoch: 0,
          remoteToolCount: 0,
        };
  }

  get configuredUrl(): string | undefined {
    return this.configValue?.url;
  }
  getCatalog(): HexHubCatalogSnapshot {
    return this.currentCatalog;
  }
  getGeneration(): number {
    return this.generation;
  }
  getStatus(): HexHubConnectionStatus {
    return { ...this.status };
  }

  async configure(next?: HexHubConfig): Promise<void> {
    this.configureCalls.push(next);
    this.generation += 1;
    this.configValue = next;
    this.currentCatalog = emptyCatalog(this.currentCatalog.epoch + 1);
    this.status = next
      ? {
          state: "ready",
          connected: false,
          endpoint: next.url,
          catalogEpoch: this.currentCatalog.epoch,
          remoteToolCount: 0,
        }
      : {
          state: "unconfigured",
          connected: false,
          catalogEpoch: this.currentCatalog.epoch,
          remoteToolCount: 0,
        };
  }

  async connect(signal?: AbortSignal): Promise<HexHubConnectionStatus> {
    signal?.throwIfAborted();
    this.connectCount += 1;
    const current = this.configValue;
    if (!current) throw new Error("HexHub is not configured");
    this.status = { ...this.status, state: "connecting", connected: false };
    this.factory.onConnect?.(current.url);
    await this.factory.connectDelay;
    if (current.url.includes("offline")) {
      const token = current.auth.type === "token" ? current.auth.token : "none";
      const message = `connection failed with ${token}; asset_ref=private-ref`;
      this.status = {
        ...this.status,
        state: "error",
        connected: false,
        lastError: message,
      };
      throw new Error(message);
    }
    this.currentCatalog = cloneCatalog(
      this.factory.connectCatalog,
      this.currentCatalog.epoch + 1,
    );
    this.status = {
      state: "connected",
      connected: true,
      endpoint: current.url,
      transport: "direct",
      serverName: "fake-hexhub",
      serverVersion: "5.3.9",
      sessionId: "private-session",
      catalogEpoch: this.currentCatalog.epoch,
      remoteToolCount: this.currentCatalog.tools.length,
    };
    return this.getStatus();
  }

  async reconnect(signal?: AbortSignal): Promise<HexHubConnectionStatus> {
    signal?.throwIfAborted();
    this.reconnectCount += 1;
    this.generation += 1;
    const current = this.configValue;
    if (!current) throw new Error("HexHub is not configured");
    this.currentCatalog = cloneCatalog(
      this.factory.reconnectCatalog ?? this.factory.connectCatalog,
      this.currentCatalog.epoch + 1,
    );
    this.status = {
      state: "connected",
      connected: true,
      endpoint: current.url,
      transport: "direct",
      serverName: "fake-hexhub",
      serverVersion: "5.3.9",
      catalogEpoch: this.currentCatalog.epoch,
      remoteToolCount: this.currentCatalog.tools.length,
    };
    return this.getStatus();
  }

  async refreshCatalog(): Promise<HexHubCatalogSnapshot> {
    return this.currentCatalog;
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<HexHubCallResult> {
    this.toolCalls.push({ name, args: clone(args) });
    if (this.factory.probeError) {
      return {
        isError: true,
        content: [{ type: "text", text: "private-ref" }],
      };
    }
    return {
      structuredContent: {
        assets: [
          { asset_ref: "private-ref", asset_id: "private-id", name: "host" },
        ],
      },
    };
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

function cloneCatalog(
  source: HexHubCatalogSnapshot,
  epoch: number,
): HexHubCatalogSnapshot {
  const tools = source.tools.map((tool) => clone(tool));
  return {
    epoch,
    tools,
    names: new Set(tools.map((tool) => tool.name)),
    unknownNames: [],
    incompatible: new Map(),
  };
}

class FakePlatform implements HexHubRuntimePlatform {
  readonly info = { platform: "linux" as const, isWindows: false, isWsl: true };
  readonly fetchResolver: HexHubRuntimePlatform["fetchResolver"] =
    async () => ({
      fetch: globalThis.fetch.bind(globalThis),
      kind: "direct",
    });
  readonly localPath: HexHubRuntimePlatform["localPath"] = async (path) => path;
  readonly tunnelResult: HexHubRuntimePlatform["tunnelResult"] = async ({
    result,
  }) => result;
  readonly tunnelManager = {
    reset: async () => {
      this.resetCount += 1;
    },
  };
  resetCount = 0;
  closeCount = 0;
  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

function dependencies(
  factory: FakeClientFactory,
  platform: FakePlatform,
  load: HexHubRuntimeDependencies["loadConfig"],
): HexHubRuntimeDependencies {
  return {
    loadConfig: load,
    createPlatform: () => platform,
    createClient: (initial) => factory.create(initial),
    shutdownTimeoutMs: 100,
  };
}

function managedActive(pi: FakePi): string[] {
  return pi.active.filter((name) => HEXHUB_MANAGED_TOOL_NAMES.has(name));
}

function assertToolRegistration(pi: FakePi): void {
  assert.equal(pi.tools.length, 25);
  assert.equal(new Set(pi.tools.map((tool) => tool.name)).size, 25);
  assert.deepEqual(
    pi.active,
    ["read"],
    "load-time disable preserves non-HexHub tools",
  );
}

function assertCommandRegistration(pi: FakePi): void {
  assert.equal(pi.commands.size, 1);
  const command = pi.commands.get("hexhub-config")!;
  assert.match(command.description, /配置.*HexHub MCP/u);
  const completions = command.getArgumentCompletions("") as Array<{
    value: string;
    description?: string;
  }>;
  assert.deepEqual(
    completions.map((item) => item.value),
    ["show", "test", "reconnect", "tools", "reset-tools", "clear"],
  );
  assert.equal(
    completions.every((item) =>
      /[\p{Script=Han}]/u.test(item.description ?? ""),
    ),
    true,
  );
}

function assertStartedEntry(
  pi: FakePi,
  state: FakeContextState,
  loads: ReadonlyArray<{ cwd: string; trusted: boolean }>,
): void {
  assert.deepEqual(loads, [{ cwd: "/isolated/project", trusted: true }]);
  assert.ok(pi.active.includes("read"));
  assert.deepEqual(managedActive(pi), [
    "hexhub_tools",
    "hexhub_assets",
    "hexhub_shell",
  ]);
  assert.equal(state.statuses.get("hexhub"), "HexHub：已连接 · 24 个工具");
  assert.equal(
    state.notices.filter((notice) => notice.message.includes("旧版配置项"))
      .length,
    1,
  );
}

async function exerciseManagementCommands(
  command: Record<string, any>,
  pi: FakePi,
  platform: FakePlatform,
  factory: FakeClientFactory,
  state: FakeContextState,
): Promise<void> {
  await command.handler("tools", state.context);
  assert.match(
    state.notices.at(-1)?.message ?? "",
    /已注册并审查的远端工具：24 项/u,
  );
  await command.handler("reset-tools", state.context);
  assert.ok(pi.active.includes("hexhub_shell"));
  await command.handler("clear", state.context);
  assert.deepEqual(pi.active, ["read"]);
  assert.equal(factory.instances[0]?.configuredUrl, undefined);
  assert.equal(state.statuses.get("hexhub"), undefined);
  assert.ok(platform.resetCount >= 2);
}

async function verifyIdempotentShutdown(
  runtime: ReturnType<typeof installHexHubExtension>,
  value: LoadedHexHubConfig,
  pi: FakePi,
  platform: FakePlatform,
  factory: FakeClientFactory,
  state: FakeContextState,
): Promise<void> {
  await runtime.reload(value, state.context);
  const firstShutdown = runtime.shutdown(state.context);
  const secondShutdown = runtime.shutdown(state.context);
  assert.equal(secondShutdown, firstShutdown);
  await firstShutdown;
  assert.equal(factory.instances[0]?.closeCount, 1);
  assert.equal(platform.closeCount, 1);
  assert.deepEqual(pi.active, ["read"]);
  assert.equal(state.statuses.get("hexhub"), undefined);
  assert.throws(() => runtime.reload(value, state.context), /已关闭/u);
}

test("entry registers 25 static tools and one command, then session_start connects safely", async () => {
  const pi = new FakePi();
  const factory = new FakeClientFactory();
  const platform = new FakePlatform();
  const state = createContext();
  const value = loaded(config({ initialGroups: ["shell"] }), ["project.url"]);
  const loads: Array<{ cwd: string; trusted: boolean }> = [];
  const runtime = installHexHubExtension(
    pi.asApi(),
    dependencies(factory, platform, async (cwd, trusted) => {
      loads.push({ cwd, trusted });
      return value;
    }),
  );

  assertToolRegistration(pi);
  assertCommandRegistration(pi);

  await pi.emit("session_start", { reason: "startup" }, state.context);
  assertStartedEntry(pi, state, loads);

  await runtime.reload(value, state.context);
  assert.equal(
    state.notices.filter((notice) => notice.message.includes("旧版配置项"))
      .length,
    1,
  );
});

test("connection failure leaves only the loader and does not poison later reloads", async () => {
  const pi = new FakePi();
  const factory = new FakeClientFactory();
  const platform = new FakePlatform();
  const state = createContext();
  const token = "top-secret-token";
  const offline = loaded(
    config({
      url: "http://127.0.0.1:17322/offline",
      auth: { type: "token", token, header: "authorization" },
    }),
  );
  const runtime = installHexHubExtension(
    pi.asApi(),
    dependencies(factory, platform, async () => offline),
  );

  await pi.emit("session_start", { reason: "startup" }, state.context);
  assert.equal(runtime.getStatus().state, "error");
  assert.deepEqual(managedActive(pi), ["hexhub_tools"]);
  assert.equal(state.statuses.get("hexhub"), "HexHub：连接错误");
  const warning = state.notices.at(-1)?.message ?? "";
  assert.doesNotMatch(warning, /top-secret-token|private-ref/);
  assert.match(warning, /\[redacted\]/);

  const online = loaded(
    config({
      url: "http://127.0.0.1:17323/mcp",
      initialGroups: ["files-read"],
    }),
  );
  await runtime.reload(online, state.context);
  assert.equal(runtime.getStatus().state, "connected");
  assert.equal(factory.instances[0]?.configuredUrl, online.config.url);
  assert.ok(pi.active.includes("hexhub_read"));
  assert.equal(state.statuses.get("hexhub"), "HexHub：已连接 · 24 个工具");
});

test("concurrent reloads stay serialized and only the latest config activates tools", async () => {
  const pi = new FakePi();
  const factory = new FakeClientFactory();
  const platform = new FakePlatform();
  const state = createContext();
  const runtime = installHexHubExtension(
    pi.asApi(),
    dependencies(factory, platform, async () => loaded(config())),
  );
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  factory.connectDelay = new Promise<void>((resolve) => {
    release = resolve;
  });
  factory.onConnect = () => started();

  const first = loaded(
    config({ url: "http://127.0.0.1:17331/mcp", initialGroups: ["shell"] }),
  );
  const latest = loaded(
    config({
      url: "http://127.0.0.1:17332/mcp",
      initialGroups: ["files-read"],
    }),
  );
  const staleReload = runtime.reload(first, state.context);
  await startedPromise;
  const latestReload = runtime.reload(latest, state.context);
  assert.deepEqual(managedActive(pi), []);
  release();
  await Promise.all([staleReload, latestReload]);

  const main = factory.instances[0]!;
  assert.deepEqual(
    main.configureCalls.map((item) => item?.url),
    [first.config.url, latest.config.url],
  );
  assert.equal(main.configuredUrl, latest.config.url);
  assert.equal(pi.active.includes("hexhub_shell"), false);
  assert.equal(pi.active.includes("hexhub_read"), true);
  assert.equal(state.statuses.get("hexhub"), "HexHub：已连接 · 24 个工具");
});

test("reconnect preserves valid loaded groups and revokes newly unavailable tools", async () => {
  const pi = new FakePi();
  const factory = new FakeClientFactory();
  const platform = new FakePlatform();
  const state = createContext();
  const value = loaded(config());
  const runtime = installHexHubExtension(
    pi.asApi(),
    dependencies(factory, platform, async () => value),
  );
  await runtime.start(state.context);
  runtime.controller.activateGroups(["shell", "files-read"]);
  assert.ok(pi.active.includes("hexhub_shell"));
  assert.ok(pi.active.includes("hexhub_read"));

  factory.reconnectCatalog = catalog(2, ["shell"]);
  const report = await runtime.reconnect(state.context);
  assert.equal(factory.instances[0]?.reconnectCount, 1);
  assert.equal(pi.active.includes("hexhub_shell"), false);
  assert.equal(pi.active.includes("hexhub_read"), true);
  assert.ok(pi.active.includes("hexhub_tools"));
  assert.match(JSON.stringify(report), /shell/);
  assert.equal(state.statuses.get("hexhub"), "HexHub：已连接 · 23 个工具");
});

test("connection test uses an independent client and performs one minimal assets probe", async () => {
  const pi = new FakePi();
  const factory = new FakeClientFactory();
  const platform = new FakePlatform();
  const state = createContext();
  const value = loaded(config());
  const runtime = installHexHubExtension(
    pi.asApi(),
    dependencies(factory, platform, async () => value),
  );
  await runtime.start(state.context);
  const main = factory.instances[0]!;
  const generation = main.getGeneration();
  const mainConnects = main.connectCount;

  const report = await runtime.testConnection(value);
  assert.equal(factory.instances.length, 2);
  const temporary = factory.instances[1]!;
  assert.equal(temporary.closeCount, 1);
  assert.deepEqual(temporary.toolCalls, [
    { name: "list_assets", args: { pattern: "" } },
  ]);
  assert.equal(main.getGeneration(), generation);
  assert.equal(main.connectCount, mainConnects);
  const serialized = JSON.stringify(report);
  assert.match(serialized, /服务端：fake-hexhub 5\.3\.9/u);
  assert.match(serialized, /传输方式：direct/u);
  assert.match(serialized, /可用 24；无权限或不存在 0；不兼容 0；未知 1/u);
  assert.match(serialized, /WSL 是/u);
  assert.doesNotMatch(serialized, /private-ref|private-id|asset_ref|session/);

  factory.probeError = true;
  await assert.rejects(runtime.testConnection(value), /资产读取探测失败/u);
  assert.equal(factory.instances[2]?.closeCount, 1);
});

test("command hooks expose reports, clear safely, and shutdown is bounded and idempotent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-hexhub-runtime-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  const pi = new FakePi();
  const factory = new FakeClientFactory();
  const platform = new FakePlatform();
  const state = createContext(root);
  const value = loaded(config({ initialGroups: ["shell"] }));
  const runtime = installHexHubExtension(
    pi.asApi(),
    dependencies(factory, platform, async () => value),
  );
  await runtime.start(state.context);
  const command = pi.commands.get("hexhub-config")!;

  await exerciseManagementCommands(command, pi, platform, factory, state);
  await verifyIdempotentShutdown(runtime, value, pi, platform, factory, state);
});
