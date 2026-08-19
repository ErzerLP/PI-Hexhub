import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { analyzeHexHubCatalog } from "./catalog-compat.js";
import { HEXHUB_TOOL_LOADER } from "./catalog.js";
import {
  runHexHubConfigCommand,
  type HexHubCommandReport,
} from "./config-ui.js";
import { loadHexHubConfig } from "./config.js";
import type {
  HexHubCallResult,
  HexHubCatalogSnapshot,
  HexHubConfig,
  HexHubConnectionStatus,
  LoadedHexHubConfig,
} from "./contracts.js";
import { HexHubMcpClient } from "./mcp-client.js";
import {
  createHexHubPlatformAdapters,
  type HexHubPlatformAdapters,
  type HexHubPlatformInfo,
} from "./platform.js";
import {
  registerHexHubTools,
  type HexHubControllerClient,
  type HexHubToolController,
} from "./tool-controller.js";

const HEXHUB_STATUS_KEY = "hexhub";
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000;
const COMMAND_ARGUMENTS = [
  "show",
  "test",
  "reconnect",
  "tools",
  "reset-tools",
  "clear",
] as const;

const COMMAND_DESCRIPTIONS: Record<(typeof COMMAND_ARGUMENTS)[number], string> =
  {
    show: "显示当前配置、默认值和连接状态",
    test: "使用独立会话测试连接和资产读取",
    reconnect: "重新连接并刷新工具权限目录",
    tools: "显示工具组、权限和兼容性状态",
    "reset-tools": "恢复引导工具和初始工具组",
    clear: "清除全局连接配置并停用工具",
  };

type RuntimeUiContext = Pick<ExtensionContext, "hasUI" | "ui"> & {
  readonly signal?: AbortSignal;
};

export interface HexHubRuntimeClient extends HexHubControllerClient {
  configure(config?: HexHubConfig): Promise<void>;
  connect(signal?: AbortSignal): Promise<HexHubConnectionStatus>;
  reconnect(signal?: AbortSignal): Promise<HexHubConnectionStatus>;
  getStatus(): HexHubConnectionStatus;
  getCatalog(): HexHubCatalogSnapshot;
  getGeneration(): number;
  callTool(
    name: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<HexHubCallResult>;
  close(): Promise<void>;
}

export interface HexHubRuntimePlatform {
  readonly info: HexHubPlatformInfo;
  readonly fetchResolver: HexHubPlatformAdapters["fetchResolver"];
  readonly localPath: HexHubPlatformAdapters["localPath"];
  readonly tunnelResult: HexHubPlatformAdapters["tunnelResult"];
  readonly tunnelManager: Pick<
    HexHubPlatformAdapters["tunnelManager"],
    "reset"
  >;
  close(): Promise<void>;
}

export interface HexHubRuntimeDependencies {
  loadConfig?: (
    cwd: string,
    projectTrusted: boolean,
  ) => Promise<LoadedHexHubConfig>;
  createPlatform?: () => HexHubRuntimePlatform;
  createClient?: (
    config: HexHubConfig | undefined,
    platform: HexHubRuntimePlatform,
  ) => HexHubRuntimeClient;
  shutdownTimeoutMs?: number;
}

interface ResolvedRuntimeDependencies {
  loadConfig(cwd: string, projectTrusted: boolean): Promise<LoadedHexHubConfig>;
  createPlatform(): HexHubRuntimePlatform;
  createClient(
    config: HexHubConfig | undefined,
    platform: HexHubRuntimePlatform,
  ): HexHubRuntimeClient;
  shutdownTimeoutMs: number;
}

function resolveDependencies(
  dependencies: HexHubRuntimeDependencies,
): ResolvedRuntimeDependencies {
  return {
    loadConfig:
      dependencies.loadConfig ??
      ((cwd, projectTrusted) => loadHexHubConfig({ cwd, projectTrusted })),
    createPlatform:
      dependencies.createPlatform ?? (() => createHexHubPlatformAdapters()),
    createClient:
      dependencies.createClient ??
      ((config, platform) =>
        new HexHubMcpClient(config, { fetchResolver: platform.fetchResolver })),
    shutdownTimeoutMs:
      dependencies.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
  };
}

function isPreBindRuntimeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /Extension runtime not initialized/i.test(error.message)
  );
}

function createControllerApi(pi: ExtensionAPI): ExtensionAPI {
  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property !== "getAllTools")
        return Reflect.get(target, property, receiver);
      return () => {
        try {
          return target.getAllTools();
        } catch (error) {
          if (isPreBindRuntimeError(error)) return [];
          throw error;
        }
      };
    },
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function redactValue(message: string, value: string | undefined): string {
  if (!value) return message;
  let result = message;
  for (const secret of [value, encodeURIComponent(value)]) {
    if (secret) result = result.split(secret).join("[redacted]");
  }
  return result;
}

function boundedText(message: string): string {
  const singleLine = message
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return singleLine.length > 240
    ? `${singleLine.slice(0, 237)}...`
    : singleLine;
}

function withTimeout(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    promise.then(finish, finish);
  });
}

async function closeRuntimeClient(
  client: Pick<HexHubRuntimeClient, "close">,
): Promise<void> {
  await client.close();
}

async function closeRuntimePlatform(
  platform: Pick<HexHubRuntimePlatform, "close">,
): Promise<void> {
  await platform.close();
}

function availableReviewedCount(controller: HexHubToolController): number {
  const status = controller.getStatus();
  return Math.max(
    0,
    status.registered - status.unavailable.length - status.incompatible.length,
  );
}

export class HexHubRuntime {
  readonly platform: HexHubRuntimePlatform;
  readonly client: HexHubRuntimeClient;
  readonly controller: HexHubToolController;

  private readonly dependencies: ResolvedRuntimeDependencies;
  private mutationTail: Promise<void> = Promise.resolve();
  private currentConfig: HexHubConfig | undefined;
  private currentContext: RuntimeUiContext | undefined;
  private changeVersion = 0;
  private deprecatedWarningShown = false;
  private readonly redactionValues = new Set<string>();
  private stopped = false;
  private shutdownPromise: Promise<void> | undefined;

  constructor(pi: ExtensionAPI, dependencies: HexHubRuntimeDependencies = {}) {
    this.dependencies = resolveDependencies(dependencies);
    this.platform = this.dependencies.createPlatform();
    this.client = this.dependencies.createClient(undefined, this.platform);
    this.controller = registerHexHubTools({
      pi: createControllerApi(pi),
      client: this.client,
      localPath: this.platform.localPath,
      tunnelResult: this.platform.tunnelResult,
    });
    // Registration is valid pre-bind, while Pi action methods become available just before session events.
    try {
      this.controller.disable();
    } catch (error) {
      if (!isPreBindRuntimeError(error)) throw error;
    }
  }

  async start(ctx: ExtensionContext): Promise<void> {
    this.controller.disable();
    this.rememberContext(ctx);
    let loaded = false;
    try {
      const config = await this.loadForContext(
        ctx.cwd,
        ctx.isProjectTrusted(),
        ctx,
      );
      loaded = true;
      await this.reload(config, ctx);
    } catch (error) {
      if (!loaded) await this.deactivateAfterLoadFailure(ctx);
      this.setErrorStatus(ctx);
      this.notifyError(ctx, error, "warning");
    }
  }

  async loadForContext(
    cwd: string,
    projectTrusted: boolean,
    ctx?: Pick<ExtensionContext, "hasUI" | "ui">,
  ): Promise<LoadedHexHubConfig> {
    const loaded = await this.dependencies.loadConfig(cwd, projectTrusted);
    this.rememberSecrets(loaded.config);
    if (ctx) this.warnDeprecatedOnce(loaded, ctx);
    return loaded;
  }

  reload(loaded: LoadedHexHubConfig, ctx: RuntimeUiContext): Promise<void> {
    this.assertRunning();
    this.rememberContext(ctx);
    this.warnDeprecatedOnce(loaded, ctx);
    const version = ++this.changeVersion;
    const config = loaded.config;
    this.rememberSecrets(config);
    this.currentConfig = config;
    this.controller.disable();
    this.setConnectingStatus(ctx);

    return this.enqueue(async () => {
      if (!this.isCurrent(version)) return;
      let bridgeError: unknown;
      try {
        try {
          await this.platform.tunnelManager.reset();
        } catch (error) {
          bridgeError = error;
        }
        if (!this.isCurrent(version)) return;
        await this.client.configure(config);
        if (!this.isCurrent(version)) return;
        await this.client.connect(ctx.signal);
        if (!this.isCurrent(version)) return;
        this.controller.configure(config);
        this.setConnectedStatus(ctx);
        if (bridgeError !== undefined && ctx.hasUI) {
          ctx.ui.notify(
            `HexHub 隧道清理警告：${this.safeError(bridgeError)}`,
            "warning",
          );
        }
      } catch (error) {
        if (!this.isCurrent(version)) return;
        try {
          this.controller.configure(config);
        } catch {
          this.controller.disable();
        }
        this.setErrorStatus(ctx);
        throw error;
      }
    });
  }

  reconnect(
    ctx: RuntimeUiContext,
    signal?: AbortSignal,
  ): Promise<HexHubCommandReport> {
    this.assertRunning();
    this.rememberContext(ctx);
    const version = this.changeVersion;
    this.setConnectingStatus(ctx);
    return this.enqueue(async () => {
      if (!this.isCurrent(version))
        return "HexHub 重新连接已被更新的配置替代。";
      if (!this.currentConfig)
        throw new Error("HexHub 尚未配置，请先运行 /hexhub-config。");
      try {
        await this.controller.refreshAfterReconnect(signal);
        if (!this.isCurrent(version)) {
          this.controller.disable();
          return "HexHub 重新连接已被更新的配置替代。";
        }
        this.setConnectedStatus(ctx);
        return this.controller.toolsReport();
      } catch (error) {
        if (this.isCurrent(version)) {
          try {
            this.controller.configure(this.currentConfig);
          } catch {
            this.controller.disable();
          }
          this.setErrorStatus(ctx);
        }
        throw error;
      }
    });
  }

  async testConnection(
    loaded: LoadedHexHubConfig,
    signal?: AbortSignal,
  ): Promise<HexHubCommandReport> {
    this.assertRunning();
    const temporary = this.dependencies.createClient(
      loaded.config,
      this.platform,
    );
    try {
      const status = await temporary.connect(signal);
      const diagnostics = analyzeHexHubCatalog(temporary.getCatalog());
      const compatibilities = [...diagnostics.tools.values()];
      const available = compatibilities.filter(
        (item) => item.status === "available",
      ).length;
      const unavailable = compatibilities.filter(
        (item) => item.status === "unavailable",
      ).length;
      const incompatible = compatibilities.filter(
        (item) => item.status === "incompatible",
      ).length;
      if (diagnostics.tools.get("list_assets")?.status === "available") {
        const probe = await temporary.callTool(
          "list_assets",
          { pattern: "" },
          signal,
        );
        if (probe.isError) throw new Error("HexHub 资产读取探测失败");
      }
      const server = [status.serverName ?? "unknown", status.serverVersion]
        .filter(Boolean)
        .join(" ");
      return {
        summary: "HexHub 连接测试通过。",
        details: [
          `服务端：${boundedText(server)}`,
          `传输方式：${status.transport ?? "未知"}`,
          `已审查工具：可用 ${available}；无权限或不存在 ${unavailable}；不兼容 ${incompatible}；未知 ${diagnostics.unknown.length}`,
          `运行平台：${this.platform.info.platform}；Windows ${this.platform.info.isWindows ? "是" : "否"}；WSL ${this.platform.info.isWsl ? "是" : "否"}`,
        ],
      };
    } finally {
      await withTimeout(
        closeRuntimeClient(temporary),
        this.dependencies.shutdownTimeoutMs,
      );
    }
  }

  clear(ctx: RuntimeUiContext): Promise<void> {
    this.assertRunning();
    this.rememberContext(ctx);
    const version = ++this.changeVersion;
    this.currentConfig = undefined;
    this.controller.disable();
    this.clearStatus(ctx);
    return this.enqueue(async () => {
      let failure: unknown;
      try {
        await this.client.configure(undefined);
      } catch (error) {
        failure = error;
      }
      try {
        await this.platform.tunnelManager.reset();
      } catch (error) {
        failure ??= error;
      }
      if (this.isCurrent(version)) this.clearStatus(ctx);
      if (failure !== undefined) throw failure;
    });
  }

  shutdown(ctx?: RuntimeUiContext): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopped = true;
    this.changeVersion += 1;
    if (ctx) this.rememberContext(ctx);
    this.controller.disable();
    this.clearStatus(ctx ?? this.currentContext);
    const cleanup = Promise.allSettled([
      closeRuntimeClient(this.client),
      closeRuntimePlatform(this.platform),
    ]);
    this.shutdownPromise = withTimeout(
      cleanup,
      this.dependencies.shutdownTimeoutMs,
    );
    return this.shutdownPromise;
  }

  getStatus(): HexHubConnectionStatus {
    return { ...this.client.getStatus() };
  }

  tools(): HexHubCommandReport {
    return [...this.controller.toolsReport()];
  }

  resetTools(): HexHubCommandReport {
    return [...this.controller.resetTools()];
  }

  notifyError(
    ctx: RuntimeUiContext,
    error: unknown,
    type: "warning" | "error" = "error",
  ): void {
    if (!ctx.hasUI) return;
    ctx.ui.notify(`HexHub：${this.safeError(error)}`, type);
  }

  private async deactivateAfterLoadFailure(
    ctx: RuntimeUiContext,
  ): Promise<void> {
    const version = ++this.changeVersion;
    this.currentConfig = undefined;
    this.controller.disable();
    await this.enqueue(async () => {
      try {
        await this.client.configure(undefined);
      } catch {
        // The original configuration error is more useful to the user.
      }
      try {
        await this.platform.tunnelManager.reset();
      } catch {
        // Cleanup failures are bounded again during session shutdown.
      }
      if (this.isCurrent(version)) this.setErrorStatus(ctx);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private isCurrent(version: number): boolean {
    return !this.stopped && version === this.changeVersion;
  }

  private assertRunning(): void {
    if (this.stopped) throw new Error("HexHub 运行时已关闭");
  }

  private rememberContext(ctx: RuntimeUiContext): void {
    this.currentContext = ctx;
  }

  private setConnectingStatus(ctx: RuntimeUiContext): void {
    ctx.ui.setStatus(HEXHUB_STATUS_KEY, "HexHub：正在连接");
  }

  private setConnectedStatus(ctx: RuntimeUiContext): void {
    ctx.ui.setStatus(
      HEXHUB_STATUS_KEY,
      `HexHub：已连接 · ${availableReviewedCount(this.controller)} 个工具`,
    );
  }

  private setErrorStatus(ctx: RuntimeUiContext): void {
    ctx.ui.setStatus(HEXHUB_STATUS_KEY, "HexHub：连接错误");
  }

  private clearStatus(ctx: RuntimeUiContext | undefined): void {
    ctx?.ui.setStatus(HEXHUB_STATUS_KEY, undefined);
  }

  private warnDeprecatedOnce(
    loaded: LoadedHexHubConfig,
    ctx: RuntimeUiContext,
  ): void {
    if (this.deprecatedWarningShown || loaded.deprecatedKeys.length === 0)
      return;
    this.deprecatedWarningShown = true;
    if (ctx.hasUI) {
      ctx.ui.notify(
        `HexHub 已忽略旧版配置项：${loaded.deprecatedKeys.join(", ")}`,
        "warning",
      );
    }
  }

  private rememberSecrets(config: HexHubConfig): void {
    if (config.auth.type === "token" && config.auth.token) {
      this.redactionValues.add(config.auth.token);
    }
    if (config.auth.type === "env") {
      const value = process.env[config.auth.env];
      if (value) this.redactionValues.add(value);
    }
  }

  private safeError(error: unknown): string {
    let message = errorMessage(error);
    for (const value of this.redactionValues)
      message = redactValue(message, value);
    const auth = this.currentConfig?.auth;
    if (auth?.type === "token") message = redactValue(message, auth.token);
    if (auth?.type === "env")
      message = redactValue(message, process.env[auth.env]);
    message = message
      .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [redacted]")
      .replace(
        /(["']?(?:asset_ref|session_id|sessionId|token)["']?\s*[:=]\s*)["']?[^\s,"';}]+["']?/giu,
        "$1[redacted]",
      );
    return boundedText(message || "操作失败");
  }
}

export function installHexHubExtension(
  pi: ExtensionAPI,
  dependencies: HexHubRuntimeDependencies = {},
): HexHubRuntime {
  const runtime = new HexHubRuntime(pi, dependencies);

  pi.registerCommand("hexhub-config", {
    description: "配置、测试并检查 HexHub MCP 连接",
    getArgumentCompletions(prefix) {
      const matches = COMMAND_ARGUMENTS.filter((value) =>
        value.startsWith(prefix),
      );
      return matches.length > 0
        ? matches.map((value) => ({
            value,
            label: value,
            description: COMMAND_DESCRIPTIONS[value],
          }))
        : null;
    },
    handler: async (args, ctx) => {
      try {
        await runHexHubConfigCommand(args, ctx, {
          load: async (commandContext) =>
            runtime.loadForContext(
              commandContext.cwd,
              commandContext.isProjectTrusted?.() ?? false,
              ctx,
            ),
          reload: (loaded) => runtime.reload(loaded, ctx),
          getStatus: () => runtime.getStatus(),
          test: (loaded, signal) => runtime.testConnection(loaded, signal),
          reconnect: (signal) => runtime.reconnect(ctx, signal),
          tools: () => runtime.tools(),
          resetTools: async () => runtime.resetTools(),
          clear: () => runtime.clear(ctx),
        });
      } catch (error) {
        runtime.notifyError(ctx, error, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await runtime.start(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await runtime.shutdown(ctx);
  });

  return runtime;
}

export { HEXHUB_TOOL_LOADER };
