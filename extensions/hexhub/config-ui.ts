import type {
  HexHubAuthConfig,
  HexHubAuthHeader,
  HexHubConfig,
  HexHubConnectionStatus,
  HexHubToolGroup,
  HexHubTransportMode,
  LoadedHexHubConfig,
} from "./contracts.js";
import { HEXHUB_TOOL_GROUPS } from "./contracts.js";
import {
  clearHexHubConfig,
  DEFAULT_HEXHUB_CONFIG,
  loadHexHubConfig,
  normalizeHexHubUrl,
  parseHexHubConfig,
  parseHexHubToolGroups,
  saveGlobalHexHubConfig,
  summarizeHexHubConfig,
} from "./config.js";

export interface HexHubConfigCommandUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface HexHubConfigCommandContext {
  ui: HexHubConfigCommandUi;
  cwd: string;
  hasUI: boolean;
  isProjectTrusted?: () => boolean;
  signal?: AbortSignal;
}

export type HexHubCommandReport =
  | string
  | readonly string[]
  | {
      summary: string;
      details?: readonly string[];
    };

export interface HexHubConfigCommandHooks {
  load?: (ctx: HexHubConfigCommandContext) => Promise<LoadedHexHubConfig>;
  save?: (
    config: HexHubConfig,
    previous: LoadedHexHubConfig,
    ctx: HexHubConfigCommandContext,
  ) => Promise<LoadedHexHubConfig | void>;
  reload(loaded: LoadedHexHubConfig): Promise<void>;
  getStatus?: () => HexHubConnectionStatus;
  test?: (
    loaded: LoadedHexHubConfig,
    signal?: AbortSignal,
  ) => Promise<HexHubCommandReport | void>;
  reconnect?: (signal?: AbortSignal) => Promise<HexHubCommandReport | void>;
  tools?: () =>
    | Promise<HexHubCommandReport | void>
    | HexHubCommandReport
    | void;
  resetTools?: () => Promise<HexHubCommandReport | void>;
  clear?: () => Promise<void>;
}

const AUTH_ENV = "环境变量（推荐，不写入 token）";
const AUTH_NONE = "不使用认证";
const AUTH_TOKEN = "明文 Token（不推荐）";
const AUTH_KEEP = "保持当前认证设置";

const TRANSPORT_LABELS: Record<HexHubTransportMode, string> = {
  auto: "自动选择",
  direct: "直接连接",
  "windows-helper": "Windows PowerShell 辅助连接",
};

const GROUP_LABELS: Record<HexHubToolGroup, string> = {
  shell: "远程命令",
  "files-read": "远程文件读取",
  "files-write": "远程文件写入",
  "docker-read": "Docker 查询与日志",
  "docker-control": "Docker 启停控制",
  "database-meta": "数据库元数据",
  "database-sql": "SQL 执行",
  redis: "Redis 命令",
  transfer: "SCP 文件传输",
  tunnel: "SSH 隧道",
  terminal: "交互式 SSH 终端",
};

function markedLabel(label: string, markers: readonly string[]): string {
  return markers.length > 0 ? `${label}（${markers.join("、")}）` : label;
}

function formatTransport(mode: HexHubTransportMode): string {
  return `${TRANSPORT_LABELS[mode]}（${mode}）`;
}

function formatGroups(groups: readonly HexHubToolGroup[]): string {
  return groups.length > 0
    ? groups.map((group) => `${group}（${GROUP_LABELS[group]}）`).join("、")
    : "无";
}

function formatAuth(auth: HexHubAuthConfig): string {
  if (auth.type === "none") return "不使用认证";
  if (auth.type === "env") return `环境变量 ${auth.env}，请求头 ${auth.header}`;
  return `明文 Token [已隐藏]，请求头 ${auth.header}`;
}

function formatWizardGuide(current: HexHubConfig): string {
  return [
    "HexHub 配置向导",
    "按 Esc 可随时取消；文本输入留空会保留当前值。初始工具组输入 none 可清空。",
    "",
    "默认值：",
    `MCP 地址：${DEFAULT_HEXHUB_CONFIG.url}`,
    `传输方式：${formatTransport(DEFAULT_HEXHUB_CONFIG.transport)}`,
    `请求超时：${DEFAULT_HEXHUB_CONFIG.timeoutMs} 毫秒`,
    `认证方式：${formatAuth(DEFAULT_HEXHUB_CONFIG.auth)}`,
    `初始工具组：${formatGroups(DEFAULT_HEXHUB_CONFIG.initialGroups)}`,
    "",
    "当前值：",
    `MCP 地址：${current.url}`,
    `传输方式：${formatTransport(current.transport)}`,
    `请求超时：${current.timeoutMs} 毫秒`,
    `认证方式：${formatAuth(current.auth)}`,
    `初始工具组：${formatGroups(current.initialGroups)}`,
    "",
    `工具组说明：${HEXHUB_TOOL_GROUPS.map((group) => `${group}=${GROUP_LABELS[group]}`).join("；")}`,
  ].join("\n");
}

function projectTrusted(ctx: HexHubConfigCommandContext): boolean {
  return ctx.isProjectTrusted?.() ?? false;
}

async function loadCurrent(
  ctx: HexHubConfigCommandContext,
  hooks: HexHubConfigCommandHooks,
): Promise<LoadedHexHubConfig> {
  return hooks.load
    ? hooks.load(ctx)
    : loadHexHubConfig({ cwd: ctx.cwd, projectTrusted: projectTrusted(ctx) });
}

function formatReport(report: HexHubCommandReport | void): string | undefined {
  if (report === undefined) return undefined;
  if (typeof report === "string") return report;
  if (Array.isArray(report)) return report.join("\n");
  const structured = report as { summary: string; details?: readonly string[] };
  return [structured.summary, ...(structured.details ?? [])].join("\n");
}

function redactReport(report: string, config: HexHubConfig): string {
  let token: string | undefined;
  if (config.auth.type === "token") {
    token = config.auth.token;
  } else if (config.auth.type === "env") {
    token = process.env[config.auth.env];
  }
  if (!token) return report;
  return report.split(token).join("[redacted]");
}

function notifyReport(
  ctx: HexHubConfigCommandContext,
  report: HexHubCommandReport | void,
  config: HexHubConfig,
  fallback: string,
): void {
  const formatted = formatReport(report) ?? fallback;
  ctx.ui.notify(redactReport(formatted, config), "info");
}

function formatConnectionState(state: HexHubConnectionStatus["state"]): string {
  const labels: Record<HexHubConnectionStatus["state"], string> = {
    unconfigured: "未配置",
    ready: "已就绪",
    connecting: "正在连接",
    connected: "已连接",
    error: "连接错误",
  };
  return `${labels[state]}（${state}）`;
}

function formatShow(
  loaded: LoadedHexHubConfig,
  status?: HexHubConnectionStatus,
): string {
  const summary = summarizeHexHubConfig(loaded.config);
  const resolvedTransport = status?.transport
    ? `；实际使用：${formatTransport(status.transport)}`
    : "";
  const lines = [
    "HexHub 当前配置",
    `MCP 地址：${summary.url}（默认：${DEFAULT_HEXHUB_CONFIG.url}）`,
    `传输方式：${formatTransport(summary.transport)}（默认：${formatTransport(DEFAULT_HEXHUB_CONFIG.transport)}${resolvedTransport}）`,
    `请求超时：${summary.timeoutMs} 毫秒（默认：${DEFAULT_HEXHUB_CONFIG.timeoutMs} 毫秒）`,
    `认证方式：${formatAuth(summary.auth)}（默认：${formatAuth(DEFAULT_HEXHUB_CONFIG.auth)}）`,
    `初始工具组：${formatGroups(summary.initialGroups)}（默认：${formatGroups(DEFAULT_HEXHUB_CONFIG.initialGroups)}）`,
    `全局配置来源：${loaded.globalLoaded ? loaded.globalPath : "默认值或环境变量"}`,
    `项目配置来源：${loaded.projectLoaded ? loaded.projectPath : "未加载"}`,
  ];
  if (status) {
    lines.push(`连接状态：${formatConnectionState(status.state)}`);
    lines.push(
      `服务端工具：${status.remoteToolCount} 项；目录版本：${status.catalogEpoch}`,
    );
  }
  if (loaded.deprecatedKeys.length > 0) {
    lines.push(`已忽略的旧配置项：${loaded.deprecatedKeys.join(", ")}`);
  }
  return lines.join("\n");
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

async function chooseHeader(
  ctx: HexHubConfigCommandContext,
  current: HexHubAuthHeader,
): Promise<HexHubAuthHeader | undefined> {
  const values: readonly HexHubAuthHeader[] = [
    current,
    ...(["authorization", "x-hexhub-token"] as const).filter(
      (value) => value !== current,
    ),
  ];
  const options = values.map((value) => {
    const name =
      value === "authorization" ? "Authorization Bearer" : "X-HexHub-MCP-Token";
    const markers = [
      ...(value === current ? ["当前值"] : []),
      ...(value === "authorization" ? ["默认值"] : []),
    ];
    return { value, label: markedLabel(name, markers) };
  });
  const selected = await ctx.ui.select(
    "认证请求头：决定 token 使用哪个 HTTP header 发送",
    options.map((option) => option.label),
  );
  return options.find((option) => option.label === selected)?.value;
}

async function chooseAuth(
  ctx: HexHubConfigCommandContext,
  current: HexHubAuthConfig,
): Promise<HexHubAuthConfig | undefined> {
  const options =
    current.type === "none"
      ? [
          {
            value: "none" as const,
            label: markedLabel(AUTH_NONE, ["当前值", "默认值"]),
          },
          { value: "env" as const, label: AUTH_ENV },
          { value: "token" as const, label: AUTH_TOKEN },
        ]
      : [
          {
            value: "keep" as const,
            label: `${AUTH_KEEP}（当前：${formatAuth(current)}）`,
          },
          { value: "env" as const, label: AUTH_ENV },
          {
            value: "none" as const,
            label: markedLabel(AUTH_NONE, ["默认值"]),
          },
          { value: "token" as const, label: AUTH_TOKEN },
        ];
  const selected = await ctx.ui.select(
    `认证方式（当前：${formatAuth(current)}；默认：${formatAuth(DEFAULT_HEXHUB_CONFIG.auth)}）`,
    options.map((option) => option.label),
  );
  const mode = options.find((option) => option.label === selected)?.value;
  if (mode === undefined) return undefined;
  if (mode === "keep") return current;
  if (mode === "none") return { type: "none" };

  const header = await chooseHeader(
    ctx,
    current.type === "none" ? "authorization" : current.header,
  );
  if (!header) return undefined;
  if (mode === "env") {
    const currentName = current.type === "env" ? current.env : "HEXHUB_TOKEN";
    const env = await ctx.ui.input(
      "Token 环境变量名（留空保留当前值）",
      `当前值：${currentName}；默认值：HEXHUB_TOKEN`,
    );
    if (env === undefined) return undefined;
    const name = env.trim() || currentName;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      ctx.ui.notify(
        "环境变量名无效：必须以字母或下划线开头，且只能包含字母、数字和下划线。",
        "error",
      );
      return undefined;
    }
    return { type: "env", env: name, header };
  }

  const accepted = await ctx.ui.confirm(
    "确认以明文保存 Token？",
    "Pi 当前没有安全的密码输入接口。Token 输入时可见，并会写入全局 hexhub.json。建议改用环境变量。是否继续？",
  );
  if (!accepted) return undefined;
  const token = await ctx.ui.input(
    "HexHub 明文 Token",
    "无默认值；输入内容将保存到全局 hexhub.json",
  );
  if (token === undefined || !token.trim()) {
    ctx.ui.notify("未输入 Token，认证设置没有更改。", "warning");
    return undefined;
  }
  return { type: "token", token: token.trim(), header };
}

async function runWizard(
  ctx: HexHubConfigCommandContext,
  hooks: HexHubConfigCommandHooks,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("HexHub 配置需要在 Pi 交互界面中运行。", "error");
    return;
  }
  const previous = await loadCurrent(ctx, hooks);
  const current = previous.config;
  ctx.ui.notify(formatWizardGuide(current), "info");

  const urlInput = await ctx.ui.input(
    "HexHub MCP 地址（远程地址必须使用 HTTPS；留空保留当前值）",
    `当前值：${current.url}；默认值：${DEFAULT_HEXHUB_CONFIG.url}`,
  );
  if (urlInput === undefined) return;
  let url: string;
  let parsedUrl: URL;
  try {
    url = normalizeHexHubUrl(urlInput || current.url);
    parsedUrl = new URL(url);
  } catch (error) {
    ctx.ui.notify(
      `MCP 地址无效：${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }
  if (parsedUrl.protocol === "http:" && !isLoopback(parsedUrl.hostname)) {
    ctx.ui.notify(
      "远程 HexHub 地址必须使用 HTTPS；只有 localhost、127.0.0.0/8 和 ::1 可以使用 HTTP。",
      "error",
    );
    return;
  }

  const transportValues: readonly HexHubTransportMode[] = [
    current.transport,
    ...(["auto", "direct", "windows-helper"] as const).filter(
      (value) => value !== current.transport,
    ),
  ];
  const transportOptions = transportValues.map((value) => ({
    value,
    label: markedLabel(formatTransport(value), [
      ...(value === current.transport ? ["当前值"] : []),
      ...(value === DEFAULT_HEXHUB_CONFIG.transport ? ["默认值"] : []),
    ]),
  }));
  const selectedTransport = await ctx.ui.select(
    "传输方式：auto 会在 WSL 访问 Windows loopback 时自动使用 PowerShell 辅助连接",
    transportOptions.map((option) => option.label),
  );
  const transport = transportOptions.find(
    (option) => option.label === selectedTransport,
  )?.value;
  if (transport === undefined) return;

  const timeoutInput = await ctx.ui.input(
    "连接与工具调用超时（毫秒，范围 100-1800000；留空保留当前值）",
    `当前值：${current.timeoutMs}；默认值：${DEFAULT_HEXHUB_CONFIG.timeoutMs}`,
  );
  if (timeoutInput === undefined) return;
  const timeoutMs = Number(timeoutInput.trim() || current.timeoutMs);

  const auth = await chooseAuth(ctx, current.auth);
  if (auth === undefined) return;

  const groupsInput = await ctx.ui.input(
    "初始工具组（逗号分隔；留空保留当前值；输入 none 清空）",
    `当前值：${current.initialGroups.join(",") || "无"}；默认值：无`,
  );
  if (groupsInput === undefined) return;
  let initialGroups: HexHubToolGroup[];
  try {
    const value = groupsInput.trim();
    if (value === "") {
      initialGroups = [...current.initialGroups];
    } else if (/^(?:none|无)$/iu.test(value)) {
      initialGroups = [];
    } else {
      initialGroups = parseHexHubToolGroups(value);
    }
  } catch (error) {
    ctx.ui.notify(
      `初始工具组无效：${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }

  let config: HexHubConfig;
  try {
    config = parseHexHubConfig({
      version: 1,
      url,
      transport,
      timeoutMs,
      auth,
      initialGroups,
    });
  } catch (error) {
    ctx.ui.notify(
      `配置校验失败：${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }

  const saved = hooks.save
    ? await hooks.save(config, previous, ctx)
    : (await saveGlobalHexHubConfig(config, { cwd: ctx.cwd }), undefined);
  const loaded = saved ?? (await loadCurrent(ctx, hooks));
  await hooks.reload(loaded);
  ctx.ui.notify(
    `HexHub 配置已保存到 ${loaded.globalPath}，新配置已立即生效。`,
    "info",
  );
}

function parseAction(args: string): string | undefined {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  if (words.length !== 1) return "invalid";
  return words[0].toLowerCase();
}

export async function runHexHubConfigCommand(
  args: string,
  ctx: HexHubConfigCommandContext,
  hooks: HexHubConfigCommandHooks,
): Promise<void> {
  const action = parseAction(args);
  if (action === undefined) {
    await runWizard(ctx, hooks);
    return;
  }
  if (
    !new Set([
      "show",
      "test",
      "reconnect",
      "tools",
      "reset-tools",
      "clear",
    ]).has(action)
  ) {
    ctx.ui.notify(
      "用法：/hexhub-config [show|test|reconnect|tools|reset-tools|clear]\n" +
        "show=显示配置，test=测试连接，reconnect=重新连接，tools=工具状态，reset-tools=重置工具，clear=清除全局配置",
      "error",
    );
    return;
  }

  if (action === "clear") {
    if (!hooks.clear) {
      ctx.ui.notify("无法清除配置：当前运行时没有提供 clear 功能。", "error");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify("清除 HexHub 配置需要 Pi 交互界面确认。", "error");
      return;
    }
    const accepted = await ctx.ui.confirm(
      "清除 HexHub 全局配置？",
      "将删除全局连接配置，并在当前 Pi session 中停用 HexHub 工具。受信项目的初始工具组配置不会被删除。",
    );
    if (!accepted) return;
    await clearHexHubConfig({ cwd: ctx.cwd });
    await hooks.clear();
    ctx.ui.notify(
      "HexHub 全局连接配置已清除，当前 session 的工具已停用。",
      "info",
    );
    return;
  }

  const loaded = await loadCurrent(ctx, hooks);
  switch (action) {
    case "show":
      ctx.ui.notify(formatShow(loaded, hooks.getStatus?.()), "info");
      return;
    case "test": {
      if (!hooks.test) {
        ctx.ui.notify("无法测试连接：当前运行时没有提供 test 功能。", "error");
        return;
      }
      notifyReport(
        ctx,
        await hooks.test(loaded, ctx.signal),
        loaded.config,
        "HexHub 连接测试通过。",
      );
      return;
    }
    case "reconnect": {
      if (!hooks.reconnect) {
        ctx.ui.notify(
          "无法重新连接：当前运行时没有提供 reconnect 功能。",
          "error",
        );
        return;
      }
      notifyReport(
        ctx,
        await hooks.reconnect(ctx.signal),
        loaded.config,
        "HexHub 已重新连接，并刷新了工具目录。",
      );
      return;
    }
    case "tools": {
      if (!hooks.tools) {
        ctx.ui.notify(
          "无法读取工具状态：当前运行时没有提供 tools 功能。",
          "error",
        );
        return;
      }
      notifyReport(
        ctx,
        await hooks.tools(),
        loaded.config,
        "当前没有可用的 HexHub 工具。",
      );
      return;
    }
    case "reset-tools": {
      if (!hooks.resetTools) {
        ctx.ui.notify(
          "无法重置工具：当前运行时没有提供 reset-tools 功能。",
          "error",
        );
        return;
      }
      notifyReport(
        ctx,
        await hooks.resetTools(),
        loaded.config,
        "HexHub 工具已恢复为引导工具、资产工具和配置的初始工具组。",
      );
      return;
    }
    case "clear":
      return;
    default:
      return;
  }
}
