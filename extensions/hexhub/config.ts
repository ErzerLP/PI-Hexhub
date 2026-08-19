import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  HEXHUB_TOOL_GROUPS,
  type HexHubAuthConfig,
  type HexHubAuthHeader,
  type HexHubConfig,
  type HexHubToolGroup,
  type HexHubTransportMode,
  type LoadedHexHubConfig,
} from "./contracts.js";

export const DEFAULT_HEXHUB_URL = "http://127.0.0.1:17321/mcp";
export const DEFAULT_HEXHUB_TIMEOUT_MS = 30_000;
export const HEXHUB_CONFIG_FILENAME = "hexhub.json";

export const DEFAULT_HEXHUB_CONFIG: Readonly<HexHubConfig> = Object.freeze({
  version: 1,
  url: DEFAULT_HEXHUB_URL,
  transport: "auto",
  timeoutMs: DEFAULT_HEXHUB_TIMEOUT_MS,
  auth: Object.freeze({ type: "none" }),
  initialGroups: Object.freeze([]) as unknown as HexHubToolGroup[],
});

export interface HexHubConfigPathsOptions {
  cwd?: string;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface LoadHexHubConfigOptions extends HexHubConfigPathsOptions {
  projectTrusted?: boolean;
}

export interface HexHubConfigPaths {
  globalPath: string;
  projectPath: string;
}

export interface HexHubConfigSummary {
  version: 1;
  url: string;
  transport: HexHubTransportMode;
  timeoutMs: number;
  auth:
    | { type: "none" }
    | { type: "env"; env: string; header: HexHubAuthHeader }
    | {
        type: "token";
        token: "[redacted]";
        header: HexHubAuthHeader;
      };
  initialGroups: HexHubToolGroup[];
}

const TOOL_GROUP_SET = new Set<string>(HEXHUB_TOOL_GROUPS);
const TRANSPORTS = new Set<string>(["auto", "direct", "windows-helper"]);
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;

function cloneDefaultConfig(): HexHubConfig {
  return {
    version: 1,
    url: DEFAULT_HEXHUB_CONFIG.url,
    transport: DEFAULT_HEXHUB_CONFIG.transport,
    timeoutMs: DEFAULT_HEXHUB_CONFIG.timeoutMs,
    auth: { type: "none" },
    initialGroups: [],
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string")
    throw new TypeError(`${label} must be a string`);
  const result = value.trim();
  return result || undefined;
}

export function normalizeHexHubUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new TypeError("HexHub URL must not be empty");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("HexHub URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("HexHub URL must use http or https");
  }
  if (url.username || url.password) {
    throw new TypeError("HexHub URL must not contain credentials");
  }
  if (!url.hostname) throw new TypeError("HexHub URL must include a host");

  url.hash = "";
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/mcp";
  } else if (url.pathname.endsWith("/")) {
    url.pathname += "mcp";
  }
  return url.toString();
}

export function parseHexHubAuthHeader(value: unknown): HexHubAuthHeader {
  const header = optionalString(value, "auth header")?.toLowerCase();
  if (!header || header === "authorization" || header === "bearer")
    return "authorization";
  if (
    header === "x-hexhub-token" ||
    header === "x-hexhub-mcp-token" ||
    header === "x_hexhub_token"
  ) {
    return "x-hexhub-token";
  }
  throw new TypeError(
    "auth header must be Authorization or X-HexHub-MCP-Token",
  );
}

export function parseHexHubAuth(value: unknown): HexHubAuthConfig {
  if (value === undefined || value === null || value === "none")
    return { type: "none" };
  if (typeof value === "string") {
    const token = value.trim();
    if (!token) return { type: "none" };
    if (/\r|\n/.test(token))
      throw new TypeError("auth token must not contain line breaks");
    return { type: "token", token, header: "authorization" };
  }

  const auth = asRecord(value, "auth");
  const type = optionalString(auth.type, "auth.type") ?? "none";
  if (type === "none") return { type: "none" };
  const header = parseHexHubAuthHeader(auth.header);
  if (type === "env") {
    const env = optionalString(auth.env, "auth.env");
    if (!env || !ENV_NAME_RE.test(env))
      throw new TypeError("auth.env must be a valid environment variable name");
    return { type: "env", env, header };
  }
  if (type === "token") {
    const token = optionalString(auth.token, "auth.token");
    if (!token) throw new TypeError("auth.token must not be empty");
    if (/\r|\n/.test(token))
      throw new TypeError("auth.token must not contain line breaks");
    return { type: "token", token, header };
  }
  throw new TypeError("auth.type must be none, env, or token");
}

function parseTransport(
  value: unknown,
  fallback: HexHubTransportMode,
): HexHubTransportMode {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !TRANSPORTS.has(value)) {
    throw new TypeError("transport must be auto, direct, or windows-helper");
  }
  return value as HexHubTransportMode;
}

function parseTimeout(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const timeout = typeof value === "number" ? value : Number(value);
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < MIN_TIMEOUT_MS ||
    timeout > MAX_TIMEOUT_MS
  ) {
    throw new TypeError(
      `timeoutMs must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`,
    );
  }
  return timeout;
}

export function parseHexHubToolGroups(
  value: unknown,
  fallback: readonly HexHubToolGroup[] = [],
): HexHubToolGroup[] {
  if (value === undefined || value === null) return [...fallback];
  if (typeof value === "string" && value.trim() === "") return [];
  const values = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(values))
    throw new TypeError(
      "initialGroups must be an array or comma-separated string",
    );
  const groups: HexHubToolGroup[] = [];
  for (const raw of values) {
    if (typeof raw !== "string")
      throw new TypeError("initialGroups entries must be strings");
    const group = raw.trim();
    if (!TOOL_GROUP_SET.has(group))
      throw new TypeError(`unknown HexHub tool group: ${group || "(empty)"}`);
    if (!groups.includes(group as HexHubToolGroup))
      groups.push(group as HexHubToolGroup);
  }
  return groups;
}

function configFromEnvironment(env: NodeJS.ProcessEnv): HexHubConfig {
  const config = cloneDefaultConfig();
  const url = env.HEXHUB_MCP_URL ?? env.HEXHUB_URL;
  if (url) config.url = normalizeHexHubUrl(url);
  config.transport = parseTransport(env.HEXHUB_TRANSPORT, config.transport);
  config.timeoutMs = parseTimeout(env.HEXHUB_TIMEOUT_MS, config.timeoutMs);

  const envName = env.HEXHUB_TOKEN_ENV?.trim();
  const header = parseHexHubAuthHeader(env.HEXHUB_AUTH_HEADER);
  if (envName) {
    if (!ENV_NAME_RE.test(envName))
      throw new TypeError(
        "HEXHUB_TOKEN_ENV is not a valid environment variable name",
      );
    config.auth = { type: "env", env: envName, header };
  } else if (env.HEXHUB_TOKEN) {
    config.auth = { type: "env", env: "HEXHUB_TOKEN", header };
  }
  if (env.HEXHUB_INITIAL_GROUPS) {
    config.initialGroups = parseHexHubToolGroups(env.HEXHUB_INITIAL_GROUPS);
  }
  return config;
}

export function parseHexHubConfig(
  value: unknown,
  fallback: HexHubConfig = cloneDefaultConfig(),
): HexHubConfig {
  const raw = asRecord(value, "HexHub config");
  if (raw.version !== undefined && raw.version !== 1)
    throw new TypeError("unsupported HexHub config version");

  let auth: HexHubAuthConfig = fallback.auth;
  if (raw.auth !== undefined) {
    auth = parseHexHubAuth(raw.auth);
  } else if (raw.tokenEnv !== undefined) {
    auth = parseHexHubAuth({
      type: "env",
      env: raw.tokenEnv,
      header: raw.authHeader,
    });
  } else if (raw.token !== undefined) {
    auth = parseHexHubAuth({
      type: "token",
      token: raw.token,
      header: raw.authHeader,
    });
  }

  return {
    version: 1,
    url:
      raw.url === undefined
        ? fallback.url
        : normalizeHexHubUrl(String(raw.url)),
    transport: parseTransport(raw.transport, fallback.transport),
    timeoutMs: parseTimeout(raw.timeoutMs, fallback.timeoutMs),
    auth,
    initialGroups: parseHexHubToolGroups(
      raw.initialGroups,
      fallback.initialGroups,
    ),
  };
}

export function getHexHubConfigPaths(
  options: HexHubConfigPathsOptions = {},
): HexHubConfigPaths {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const configuredAgentDir =
    options.agentDir ?? env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configuredAgentDir || join(homedir(), ".pi", "agent");
  return {
    globalPath: join(agentDir, HEXHUB_CONFIG_FILENAME),
    projectPath: join(cwd, ".pi", HEXHUB_CONFIG_FILENAME),
  };
}

async function readJson(
  path: string,
): Promise<{ loaded: boolean; value?: unknown }> {
  try {
    return {
      loaded: true,
      value: JSON.parse(await readFile(path, "utf8")) as unknown,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { loaded: false };
    if (error instanceof SyntaxError)
      throw new TypeError(`invalid JSON in ${path}`);
    throw error;
  }
}

export async function loadHexHubConfig(
  options: LoadHexHubConfigOptions = {},
): Promise<LoadedHexHubConfig> {
  const env = options.env ?? process.env;
  const paths = getHexHubConfigPaths(options);
  const deprecatedKeys: string[] = [];
  let config = configFromEnvironment(env);

  const globalFile = await readJson(paths.globalPath);
  if (globalFile.loaded) {
    const raw = asRecord(globalFile.value, "global HexHub config");
    for (const key of ["token", "tokenEnv", "authHeader"]) {
      if (key in raw) deprecatedKeys.push(`global.${key}`);
    }
    config = parseHexHubConfig(raw, config);
  }

  let projectLoaded = false;
  if (options.projectTrusted === true) {
    const projectFile = await readJson(paths.projectPath);
    projectLoaded = projectFile.loaded;
    if (projectFile.loaded) {
      const raw = asRecord(projectFile.value, "project HexHub config");
      for (const key of Object.keys(raw)) {
        if (key !== "version" && key !== "initialGroups")
          deprecatedKeys.push(`project.${key}`);
      }
      if (raw.version !== undefined && raw.version !== 1)
        throw new TypeError("unsupported project HexHub config version");
      config.initialGroups = parseHexHubToolGroups(
        raw.initialGroups,
        config.initialGroups,
      );
    }
  }

  return {
    config,
    ...paths,
    globalLoaded: globalFile.loaded,
    projectLoaded,
    deprecatedKeys,
  };
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);

  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the original write error.
      }
    }
    try {
      await unlink(temporary);
    } catch {
      // The temporary file may not have been created yet.
    }
    throw error;
  }
}

export async function saveGlobalHexHubConfig(
  config: HexHubConfig,
  options: HexHubConfigPathsOptions = {},
): Promise<string> {
  const path = getHexHubConfigPaths(options).globalPath;
  await writeJsonAtomic(path, parseHexHubConfig(config));
  return path;
}

export async function saveProjectHexHubConfig(
  initialGroups: readonly HexHubToolGroup[],
  options: HexHubConfigPathsOptions = {},
): Promise<string> {
  const path = getHexHubConfigPaths(options).projectPath;
  await writeJsonAtomic(path, {
    version: 1,
    initialGroups: parseHexHubToolGroups([...initialGroups]),
  });
  return path;
}

export async function clearHexHubConfig(
  options: HexHubConfigPathsOptions & { project?: boolean } = {},
): Promise<void> {
  const paths = getHexHubConfigPaths(options);
  const targets = options.project
    ? [paths.globalPath, paths.projectPath]
    : [paths.globalPath];
  await Promise.all(
    targets.map(async (path) => {
      try {
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }),
  );
}

export function resolveHexHubAuthHeaders(
  config: Pick<HexHubConfig, "auth">,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (config.auth.type === "none") return {};
  const token =
    config.auth.type === "env"
      ? env[config.auth.env]?.trim()
      : config.auth.token.trim();
  if (!token) {
    const source =
      config.auth.type === "env"
        ? `environment variable ${config.auth.env}`
        : "configured token";
    throw new Error(`HexHub authentication requires ${source}`);
  }
  if (/\r|\n/.test(token))
    throw new Error("HexHub authentication token contains invalid line breaks");
  if (config.auth.header === "authorization") {
    return {
      Authorization: /^Bearer\s/i.test(token) ? token : `Bearer ${token}`,
    };
  }
  return { "X-HexHub-MCP-Token": token };
}

export function summarizeHexHubConfig(
  config: HexHubConfig,
): HexHubConfigSummary {
  const auth: HexHubConfigSummary["auth"] =
    config.auth.type === "token"
      ? { type: "token", token: "[redacted]", header: config.auth.header }
      : config.auth.type === "env"
        ? { type: "env", env: config.auth.env, header: config.auth.header }
        : { type: "none" };
  return {
    version: 1,
    url: normalizeHexHubUrl(config.url),
    transport: config.transport,
    timeoutMs: config.timeoutMs,
    auth,
    initialGroups: [...config.initialGroups],
  };
}
