import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  HEXHUB_DIRECT_TOOL_NAMES,
  HEXHUB_MANAGED_TOOL_NAMES,
  HEXHUB_SPEC_BY_NAME,
  HEXHUB_TOOL_LOADER,
  HEXHUB_TOOL_SPECS,
  hexHubToolsInGroups,
  type HexHubToolSpec,
} from "./catalog.js";
import {
  analyzeHexHubCatalog,
  type HexHubCatalogDiagnostics,
} from "./catalog-compat.js";
import type {
  HexHubCallResult,
  HexHubCatalogSnapshot,
  HexHubConfig,
  HexHubToolGroup,
} from "./contracts.js";
import { HEXHUB_TOOL_GROUPS } from "./contracts.js";
import { HexHubAssetRegistry } from "./asset-registry.js";
import {
  HexHubFileReadEvidence,
  prepareHexHubInput,
  type HexHubLocalPathHook,
  type HexHubPreparedInput,
} from "./input-adapters.js";
import { KeyedMutationQueue } from "./mutation-queue.js";
import {
  formatHexHubResult,
  type FormattedHexHubToolResult,
} from "./result-formatters.js";

export interface HexHubControllerClient {
  getCatalog(): HexHubCatalogSnapshot;
  getGeneration(): number;
  callTool(
    name: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<HexHubCallResult>;
  refreshCatalog?(signal?: AbortSignal): Promise<HexHubCatalogSnapshot>;
  reconnect?(signal?: AbortSignal): Promise<unknown>;
}

export interface HexHubTunnelResultContext {
  readonly remoteTool: "open_ssh_tunnel" | "close_ssh_tunnel";
  readonly result: HexHubCallResult;
  readonly remoteArgs: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

export type HexHubTunnelResultHook = (
  context: HexHubTunnelResultContext,
) => HexHubCallResult | Promise<HexHubCallResult>;

export interface HexHubToolControllerOptions {
  readonly pi: ExtensionAPI;
  readonly client: HexHubControllerClient;
  readonly config?: HexHubConfig;
  readonly registry?: HexHubAssetRegistry;
  readonly localPath?: HexHubLocalPathHook;
  readonly tunnelResult?: HexHubTunnelResultHook;
}

export interface HexHubActivationReport {
  readonly groups: readonly HexHubToolGroup[];
  readonly activated: readonly string[];
  readonly active: readonly string[];
  readonly unavailable: readonly string[];
  readonly incompatible: readonly string[];
  readonly unknown: readonly string[];
}

export interface HexHubControllerStatus {
  readonly configured: boolean;
  readonly registered: number;
  readonly active: readonly string[];
  readonly activeGroups: readonly HexHubToolGroup[];
  readonly epoch: number;
  readonly fingerprint: string;
  readonly unavailable: readonly string[];
  readonly incompatible: readonly string[];
  readonly unknown: readonly string[];
}

export interface HexHubControllerConfigHooks {
  tools(): readonly string[];
  resetTools(): readonly string[];
  reconnect(signal?: AbortSignal): Promise<readonly string[]>;
}

const FILE_MUTATION_NAMES = new Set(["write", "edit", "multi_edit", "delete"]);

function uniqueGroups(groups: readonly HexHubToolGroup[]): HexHubToolGroup[] {
  const result: HexHubToolGroup[] = [];
  for (const group of groups) {
    if (!HEXHUB_TOOL_GROUPS.includes(group))
      throw new Error(`Unknown HexHub tool group: ${String(group)}`);
    if (!result.includes(group)) result.push(group);
  }
  return result;
}

function includesAny(query: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(query));
}

export function routeHexHubToolGroups(query: string): HexHubToolGroup[] {
  const value = query.trim().toLocaleLowerCase();
  if (!value) return [];
  const groups = new Set<HexHubToolGroup>();
  const docker = includesAny(value, [/\bdocker\b/i, /容器/u]);
  const file = includesAny(value, [/\bfiles?\b/i, /文件/u]);

  if (includesAny(value, [/\bredis\b/i])) groups.add("redis");
  if (
    includesAny(value, [
      /\b(?:scp|upload|download|transfer)\b/i,
      /上传|下载|传输/u,
    ])
  )
    groups.add("transfer");
  if (includesAny(value, [/\b(?:tunnel|forward(?:ing)?)\b/i, /隧道|端口转发/u]))
    groups.add("tunnel");
  if (includesAny(value, [/\b(?:terminal|interactive|tty)\b/i, /终端|交互/u]))
    groups.add("terminal");

  const sql = includesAny(value, [/\bsql\b/i, /数据库查询|执行查询/u]);
  const database =
    sql ||
    includesAny(value, [
      /\b(?:database|schema|table|ddl)\b/i,
      /数据库|表结构|元数据/u,
    ]);
  if (database) groups.add("database-meta");
  if (sql) groups.add("database-sql");

  if (docker) groups.add("docker-read");
  if (
    docker &&
    includesAny(value, [
      /\b(?:start|stop|restart|pause|control)\b/i,
      /启动|停止|重启|暂停|控制/u,
    ])
  ) {
    groups.add("docker-control");
  }

  const writeFile =
    file &&
    includesAny(value, [
      /\b(?:write|edit|replace|delete|remove|modify)\b/i,
      /写|编辑|修改|替换|删除/u,
    ]);
  if (writeFile) {
    groups.add("files-read");
    groups.add("files-write");
  } else if (file || includesAny(value, [/\bread\b/i, /读取/u])) {
    groups.add("files-read");
  }

  if (
    includesAny(value, [/\b(?:shell|command|ssh|exec)\b/i, /命令|执行|服务器/u])
  )
    groups.add("shell");
  if (docker && file) groups.add(writeFile ? "files-write" : "files-read");
  return [...groups];
}

function isErrorResult(result: HexHubCallResult): boolean {
  return result.isError === true;
}

export class HexHubToolController {
  private readonly pi: ExtensionAPI;
  private readonly client: HexHubControllerClient;
  private readonly registry: HexHubAssetRegistry;
  private readonly evidence = new HexHubFileReadEvidence();
  private readonly mutationQueue = new KeyedMutationQueue();
  private readonly localPath: HexHubLocalPathHook | undefined;
  private readonly tunnelResult: HexHubTunnelResultHook | undefined;
  private config: HexHubConfig | undefined;
  private registered = false;
  private lastGeneration = -1;
  private lastEpoch = -1;
  private diagnostics: HexHubCatalogDiagnostics | undefined;
  private readonly desiredGroups = new Set<HexHubToolGroup>();

  constructor(options: HexHubToolControllerOptions) {
    this.pi = options.pi;
    this.client = options.client;
    this.registry = options.registry ?? new HexHubAssetRegistry();
    this.localPath = options.localPath;
    this.tunnelResult = options.tunnelResult;
    this.config = options.config;
    for (const group of options.config?.initialGroups ?? [])
      this.desiredGroups.add(group);
  }

  register(): void {
    if (this.registered) return;
    const collisions = this.pi
      .getAllTools()
      .map((tool) => tool.name)
      .filter((name) => HEXHUB_MANAGED_TOOL_NAMES.has(name));
    if (collisions.length > 0)
      throw new Error(
        `HexHub fixed tool name collision: ${collisions.join(", ")}`,
      );

    for (const spec of HEXHUB_TOOL_SPECS) this.registerRemoteTool(spec);
    this.registerLoaderTool();
    this.registered = true;
    if (this.config) this.applyInitialActivation();
  }

  configure(config: HexHubConfig): void {
    const wasConfigured = this.config !== undefined;
    this.config = config;
    this.desiredGroups.clear();
    for (const group of config.initialGroups) this.desiredGroups.add(group);
    this.observeCatalog();
    if (wasConfigured) this.reconcileActiveTools(true);
    else this.applyInitialActivation();
  }

  disable(): void {
    this.config = undefined;
    this.desiredGroups.clear();
    this.registry.clear();
    this.evidence.clear();
    this.pi.setActiveTools(this.externalTools());
  }

  resetTools(): readonly string[] {
    this.requireConfigured();
    this.desiredGroups.clear();
    for (const group of this.config?.initialGroups ?? [])
      this.desiredGroups.add(group);
    const diagnostics = this.observeCatalog();
    const names = this.initialAvailableNames(diagnostics);
    this.pi.setActiveTools([...this.externalTools(), ...names]);
    return names;
  }

  activateGroups(groups: readonly HexHubToolGroup[]): HexHubActivationReport {
    this.requireConfigured();
    const selected = uniqueGroups(groups);
    for (const group of selected) this.desiredGroups.add(group);
    const diagnostics = this.observeCatalog();
    const requested = hexHubToolsInGroups(selected);
    const activeBefore = new Set(this.pi.getActiveTools());
    const available = requested.filter(
      (spec) => diagnostics.tools.get(spec.remoteName)?.status === "available",
    );
    const activated = available
      .map((spec) => spec.name)
      .filter((name) => !activeBefore.has(name));
    if (activated.length > 0)
      this.pi.setActiveTools([...new Set([...activeBefore, ...activated])]);
    this.reconcileActiveTools(true);
    const activeSet = new Set(this.pi.getActiveTools());
    return {
      groups: selected,
      activated,
      active: available
        .map((spec) => spec.name)
        .filter((name) => activeSet.has(name)),
      unavailable: requested
        .filter(
          (spec) =>
            diagnostics.tools.get(spec.remoteName)?.status === "unavailable",
        )
        .map((spec) => spec.name),
      incompatible: requested
        .filter(
          (spec) =>
            diagnostics.tools.get(spec.remoteName)?.status === "incompatible",
        )
        .map((spec) => spec.name),
      unknown: diagnostics.unknown,
    };
  }

  async refreshCatalog(
    signal?: AbortSignal,
  ): Promise<HexHubCatalogDiagnostics> {
    await this.client.refreshCatalog?.(signal);
    const diagnostics = this.observeCatalog();
    this.reconcileActiveTools(true);
    return diagnostics;
  }

  async refreshAfterReconnect(
    signal?: AbortSignal,
  ): Promise<HexHubCatalogDiagnostics> {
    if (this.client.reconnect) await this.client.reconnect(signal);
    else await this.client.refreshCatalog?.(signal);
    const diagnostics = this.observeCatalog();
    this.reconcileActiveTools(true);
    return diagnostics;
  }

  getStatus(): HexHubControllerStatus {
    const diagnostics = this.observeCatalog();
    const active = this.pi
      .getActiveTools()
      .filter((name) => HEXHUB_MANAGED_TOOL_NAMES.has(name));
    const activeSet = new Set(active);
    return {
      configured: this.config !== undefined,
      registered: HEXHUB_TOOL_SPECS.length,
      active,
      activeGroups: HEXHUB_TOOL_GROUPS.filter((group) => {
        const groupTools = hexHubToolsInGroups([group]);
        return (
          groupTools.length > 0 &&
          groupTools.every((spec) => activeSet.has(spec.name))
        );
      }),
      epoch: diagnostics.epoch,
      fingerprint: diagnostics.fingerprint,
      unavailable: diagnostics.unavailable,
      incompatible: [...diagnostics.incompatible.keys()],
      unknown: diagnostics.unknown,
    };
  }

  toolsReport(): readonly string[] {
    const status = this.getStatus();
    return [
      `HexHub catalog epoch ${status.epoch}; fingerprint ${status.fingerprint}`,
      `Registered reviewed remote tools: ${status.registered}`,
      `Active HexHub tools: ${status.active.join(", ") || "none"}`,
      `Active groups: ${status.activeGroups.join(", ") || "none"}`,
      `Unavailable remote tools: ${status.unavailable.join(", ") || "none"}`,
      `Incompatible remote tools: ${status.incompatible.join(", ") || "none"}`,
      `Unknown remote tools (report only): ${status.unknown.join(", ") || "none"}`,
    ];
  }

  createConfigHooks(): HexHubControllerConfigHooks {
    return {
      tools: () => this.toolsReport(),
      resetTools: () => this.resetTools(),
      reconnect: async (signal) => {
        await this.refreshAfterReconnect(signal);
        return this.toolsReport();
      },
    };
  }

  private registerRemoteTool(spec: HexHubToolSpec): void {
    const controller = this;
    this.pi.registerTool({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: spec.parameters as never,
      executionMode: spec.executionMode,
      async execute(_toolCallId, params, signal, onUpdate, context) {
        onUpdate?.({
          content: [{ type: "text", text: `Calling ${spec.name}...` }],
          details: { tool: spec.name, policy: spec.resultPolicy },
        });
        return controller.executeRemote(
          spec,
          params as Record<string, unknown>,
          signal,
          context.cwd,
        );
      },
    });
  }

  private registerLoaderTool(): void {
    const controller = this;
    this.pi.registerTool({
      ...HEXHUB_TOOL_LOADER,
      parameters: HEXHUB_TOOL_LOADER.parameters as never,
      executionMode: "sequential",
      async execute(_toolCallId, params) {
        const input = params as { query?: unknown; groups?: unknown };
        const explicit = Array.isArray(input.groups) ? input.groups : [];
        if (
          !explicit.every(
            (value) =>
              typeof value === "string" &&
              HEXHUB_TOOL_GROUPS.includes(value as HexHubToolGroup),
          )
        ) {
          throw new Error("hexhub_tools groups contains an unknown group.");
        }
        const routed =
          typeof input.query === "string"
            ? routeHexHubToolGroups(input.query)
            : [];
        const groups = uniqueGroups([
          ...(explicit as HexHubToolGroup[]),
          ...routed,
        ]);
        if (groups.length === 0)
          throw new Error(
            "hexhub_tools needs a query that identifies a domain or an explicit groups list.",
          );
        const report = controller.activateGroups(groups);
        return {
          content: [
            {
              type: "text",
              text: [
                `HexHub groups: ${report.groups.join(", ")}`,
                `Activated: ${report.activated.join(", ") || "none"}`,
                `Unavailable: ${report.unavailable.join(", ") || "none"}`,
                `Incompatible: ${report.incompatible.join(", ") || "none"}`,
                `Unknown remote tools (report only): ${report.unknown.join(", ") || "none"}`,
              ].join("\n"),
            },
          ],
          details: report,
        };
      },
    });
  }

  private async executeRemote(
    spec: HexHubToolSpec,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    cwd: string,
  ): Promise<FormattedHexHubToolResult> {
    this.assertToolAvailable(spec);
    const prepared = await prepareHexHubInput({
      spec,
      params,
      registry: this.registry,
      cwd,
      ...(signal ? { signal } : {}),
      ...(this.localPath ? { localPath: this.localPath } : {}),
      evidence: this.evidence,
    });
    const invoke = () => this.invokePrepared(spec, prepared, signal);
    if (FILE_MUTATION_NAMES.has(spec.remoteName) && prepared.internal.fileKey) {
      return this.mutationQueue.run(prepared.internal.fileKey, invoke);
    }
    return invoke();
  }

  private assertToolAvailable(spec: HexHubToolSpec): void {
    this.requireConfigured();
    const diagnostics = this.observeCatalog();
    this.reconcileActiveTools(true);
    const compatibility = diagnostics.tools.get(spec.remoteName);
    if (!compatibility || compatibility.status === "unavailable") {
      throw new Error(
        `${spec.name} is unavailable under the current HexHub permission catalog.`,
      );
    }
    if (compatibility.status === "incompatible") {
      throw new Error(
        `${spec.name} is disabled because its remote schema is incompatible: ${compatibility.reason}`,
      );
    }
  }

  private async invokePrepared(
    spec: HexHubToolSpec,
    prepared: HexHubPreparedInput,
    signal: AbortSignal | undefined,
  ): Promise<FormattedHexHubToolResult> {
    const started = performance.now();
    let result = await this.client.callTool(
      spec.remoteName,
      prepared.remoteArgs,
      signal,
    );
    result = await this.applyTunnelResult(spec, prepared, result, signal);
    if (
      spec.remoteName === "read" &&
      prepared.internal.fileKey &&
      !isErrorResult(result)
    ) {
      this.evidence.mark(prepared.internal.fileKey);
    }
    return formatHexHubResult({
      result,
      spec,
      registry: this.registry,
      prepared,
      durationMs: performance.now() - started,
    });
  }

  private async applyTunnelResult(
    spec: HexHubToolSpec,
    prepared: HexHubPreparedInput,
    result: HexHubCallResult,
    signal: AbortSignal | undefined,
  ): Promise<HexHubCallResult> {
    if (
      !this.tunnelResult ||
      (spec.remoteName !== "open_ssh_tunnel" &&
        spec.remoteName !== "close_ssh_tunnel")
    ) {
      return result;
    }
    return this.tunnelResult({
      remoteTool: spec.remoteName,
      result,
      remoteArgs: prepared.remoteArgs,
      ...(signal ? { signal } : {}),
    });
  }

  private requireConfigured(): void {
    if (!this.config)
      throw new Error("HexHub is not configured. Run /hexhub-config.");
  }

  private observeCatalog(): HexHubCatalogDiagnostics {
    const catalog = this.client.getCatalog();
    const generation = this.client.getGeneration();
    if (
      generation !== this.lastGeneration ||
      catalog.epoch !== this.lastEpoch
    ) {
      this.registry.sync(generation, catalog.epoch);
      this.evidence.clear();
      this.lastGeneration = generation;
      this.lastEpoch = catalog.epoch;
    }
    this.diagnostics = analyzeHexHubCatalog(catalog);
    return this.diagnostics;
  }

  private applyInitialActivation(): void {
    const diagnostics = this.observeCatalog();
    this.pi.setActiveTools([
      ...this.externalTools(),
      ...this.initialAvailableNames(diagnostics),
    ]);
  }

  private initialAvailableNames(
    diagnostics: HexHubCatalogDiagnostics,
  ): string[] {
    const names: string[] = [HEXHUB_TOOL_LOADER.name];
    const assets = HEXHUB_SPEC_BY_NAME.get("hexhub_assets");
    if (
      assets &&
      diagnostics.tools.get(assets.remoteName)?.status === "available"
    )
      names.push(assets.name);
    for (const spec of hexHubToolsInGroups([...this.desiredGroups])) {
      if (diagnostics.tools.get(spec.remoteName)?.status === "available")
        names.push(spec.name);
    }
    return [...new Set(names)];
  }

  private reconcileActiveTools(activateDesired: boolean): void {
    if (!this.config) return;
    const diagnostics = this.diagnostics ?? this.observeCatalog();
    const active = this.pi.getActiveTools();
    const validManaged = active.filter((name) => {
      if (name === HEXHUB_TOOL_LOADER.name) return true;
      const spec = HEXHUB_SPEC_BY_NAME.get(name);
      return (
        spec !== undefined &&
        diagnostics.tools.get(spec.remoteName)?.status === "available"
      );
    });
    const desired = activateDesired
      ? this.initialAvailableNames(diagnostics)
      : [];
    const next = [
      ...new Set([...this.externalTools(), ...validManaged, ...desired]),
    ];
    if (
      next.length !== active.length ||
      next.some((name, index) => name !== active[index])
    )
      this.pi.setActiveTools(next);
  }

  private externalTools(): string[] {
    return this.pi
      .getActiveTools()
      .filter((name) => !HEXHUB_MANAGED_TOOL_NAMES.has(name));
  }
}

export function registerHexHubTools(
  options: HexHubToolControllerOptions,
): HexHubToolController {
  const controller = new HexHubToolController(options);
  controller.register();
  return controller;
}

export const HEXHUB_REGISTERED_REMOTE_TOOL_COUNT =
  HEXHUB_DIRECT_TOOL_NAMES.size;
