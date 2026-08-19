import type {
  HexHubAuthConfig,
  HexHubAuthHeader,
  HexHubConfig,
  HexHubConnectionStatus,
  HexHubToolGroup,
  LoadedHexHubConfig,
} from "./contracts.js";
import { HEXHUB_TOOL_GROUPS } from "./contracts.js";
import {
  clearHexHubConfig,
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

const AUTH_ENV = "Environment variable (recommended)";
const AUTH_NONE = "No authentication";
const AUTH_TOKEN = "Plaintext token (insecure)";
const AUTH_KEEP = "Keep current authentication";

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
  const token =
    config.auth.type === "token"
      ? config.auth.token
      : config.auth.type === "env"
        ? process.env[config.auth.env]
        : undefined;
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

function formatShow(
  loaded: LoadedHexHubConfig,
  status?: HexHubConnectionStatus,
): string {
  const summary = summarizeHexHubConfig(loaded.config);
  const lines = [
    `URL: ${summary.url}`,
    `Transport: ${summary.transport}${status?.transport ? ` (resolved: ${status.transport})` : ""}`,
    `Timeout: ${summary.timeoutMs} ms`,
    `Authentication: ${summary.auth.type === "env" ? `environment ${summary.auth.env}` : summary.auth.type}`,
    `Auth header: ${summary.auth.type === "none" ? "n/a" : summary.auth.header}`,
    `Initial groups: ${summary.initialGroups.join(", ") || "none"}`,
    `Global config: ${loaded.globalLoaded ? loaded.globalPath : "defaults/environment"}`,
    `Project config: ${loaded.projectLoaded ? loaded.projectPath : "not loaded"}`,
  ];
  if (status) {
    lines.push(`Connection: ${status.state}`);
    lines.push(
      `Remote tools: ${status.remoteToolCount} (catalog epoch ${status.catalogEpoch})`,
    );
  }
  if (loaded.deprecatedKeys.length)
    lines.push(`Ignored/deprecated keys: ${loaded.deprecatedKeys.join(", ")}`);
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
  const authorization = "Authorization (Bearer)";
  const hexhub = "X-HexHub-MCP-Token";
  const selected = await ctx.ui.select(
    `Authentication header (current: ${current})`,
    current === "authorization"
      ? [authorization, hexhub]
      : [hexhub, authorization],
  );
  if (selected === undefined) return undefined;
  return selected === authorization ? "authorization" : "x-hexhub-token";
}

async function chooseAuth(
  ctx: HexHubConfigCommandContext,
  current: HexHubAuthConfig,
): Promise<HexHubAuthConfig | undefined> {
  const options =
    current.type === "none"
      ? [AUTH_ENV, AUTH_NONE, AUTH_TOKEN]
      : [AUTH_KEEP, AUTH_ENV, AUTH_NONE, AUTH_TOKEN];
  const selected = await ctx.ui.select(
    `Authentication (current: ${current.type})`,
    options,
  );
  if (selected === undefined) return undefined;
  if (selected === AUTH_KEEP) return current;
  if (selected === AUTH_NONE) return { type: "none" };

  const header = await chooseHeader(
    ctx,
    current.type === "none" ? "authorization" : current.header,
  );
  if (!header) return undefined;
  if (selected === AUTH_ENV) {
    const env = await ctx.ui.input(
      "Token environment variable",
      current.type === "env" ? current.env : "HEXHUB_TOKEN",
    );
    if (env === undefined) return undefined;
    const name =
      env.trim() || (current.type === "env" ? current.env : "HEXHUB_TOKEN");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      ctx.ui.notify("Environment variable name is invalid.", "error");
      return undefined;
    }
    return { type: "env", env: name, header };
  }

  const accepted = await ctx.ui.confirm(
    "Store token as plaintext?",
    "Pi has no secure secret input API. The token will be visible while entered and stored in hexhub.json. Prefer an environment variable. Continue?",
  );
  if (!accepted) return undefined;
  const token = await ctx.ui.input(
    "Plaintext HexHub token",
    "Token will be stored in hexhub.json",
  );
  if (token === undefined || !token.trim()) {
    ctx.ui.notify("Token was not changed.", "warning");
    return undefined;
  }
  return { type: "token", token: token.trim(), header };
}

async function runWizard(
  ctx: HexHubConfigCommandContext,
  hooks: HexHubConfigCommandHooks,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("HexHub configuration requires an interactive UI.", "error");
    return;
  }
  const previous = await loadCurrent(ctx, hooks);
  const current = previous.config;

  const urlInput = await ctx.ui.input("HexHub MCP URL", current.url);
  if (urlInput === undefined) return;
  let url: string;
  try {
    url = normalizeHexHubUrl(urlInput || current.url);
  } catch (error) {
    ctx.ui.notify(
      error instanceof Error ? error.message : String(error),
      "error",
    );
    return;
  }
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol === "http:" && !isLoopback(parsedUrl.hostname)) {
    ctx.ui.notify(
      "Remote HexHub endpoints must use HTTPS; HTTP is allowed only for loopback addresses.",
      "error",
    );
    return;
  }

  const transport = await ctx.ui.select("HexHub transport", [
    current.transport,
    ...(["auto", "direct", "windows-helper"] as const).filter(
      (value) => value !== current.transport,
    ),
  ]);
  if (transport === undefined) return;

  const timeoutInput = await ctx.ui.input(
    "HTTP and tool timeout (milliseconds)",
    String(current.timeoutMs),
  );
  if (timeoutInput === undefined) return;
  const timeoutMs = Number(timeoutInput || current.timeoutMs);

  const auth = await chooseAuth(ctx, current.auth);
  if (auth === undefined) return;

  const groupsInput = await ctx.ui.input(
    `Initial groups (${HEXHUB_TOOL_GROUPS.join(", ")})`,
    current.initialGroups.join(","),
  );
  if (groupsInput === undefined) return;
  let initialGroups: HexHubToolGroup[];
  try {
    initialGroups = parseHexHubToolGroups(groupsInput);
  } catch (error) {
    ctx.ui.notify(
      error instanceof Error ? error.message : String(error),
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
      error instanceof Error ? error.message : String(error),
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
    `HexHub configuration saved to ${loaded.globalPath} and reloaded.`,
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
      "Usage: /hexhub-config [show|test|reconnect|tools|reset-tools|clear]",
      "error",
    );
    return;
  }

  if (action === "clear") {
    if (!hooks.clear) {
      ctx.ui.notify(
        "HexHub clear hook is not available; configuration was not changed.",
        "error",
      );
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "Clearing HexHub configuration requires confirmation in an interactive UI.",
        "error",
      );
      return;
    }
    const accepted = await ctx.ui.confirm(
      "Clear HexHub configuration?",
      "This removes the global connection configuration and disables HexHub tools for this session.",
    );
    if (!accepted) return;
    await clearHexHubConfig({ cwd: ctx.cwd });
    await hooks.clear();
    ctx.ui.notify(
      "HexHub connection configuration cleared and tools disabled.",
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
        ctx.ui.notify("HexHub test hook is not available.", "error");
        return;
      }
      notifyReport(
        ctx,
        await hooks.test(loaded, ctx.signal),
        loaded.config,
        "HexHub connection test passed.",
      );
      return;
    }
    case "reconnect": {
      if (!hooks.reconnect) {
        ctx.ui.notify("HexHub reconnect hook is not available.", "error");
        return;
      }
      notifyReport(
        ctx,
        await hooks.reconnect(ctx.signal),
        loaded.config,
        "HexHub reconnected and catalog refreshed.",
      );
      return;
    }
    case "tools": {
      if (!hooks.tools) {
        ctx.ui.notify("HexHub tools hook is not available.", "error");
        return;
      }
      notifyReport(
        ctx,
        await hooks.tools(),
        loaded.config,
        "No HexHub tools are currently available.",
      );
      return;
    }
    case "reset-tools": {
      if (!hooks.resetTools) {
        ctx.ui.notify("HexHub tool reset hook is not available.", "error");
        return;
      }
      notifyReport(
        ctx,
        await hooks.resetTools(),
        loaded.config,
        "HexHub tools reset to bootstrap and assets.",
      );
      return;
    }
    case "clear":
      return;
  }
}
