import type { HexHubCallResult } from "./contracts.js";
import type { HexHubToolSpec, HexHubResultPolicy } from "./catalog.js";
import {
  type HexHubAssetRegistry,
  hexHubResultPayload,
} from "./asset-registry.js";
import type { HexHubPreparedInput } from "./input-adapters.js";

export interface HexHubResultBudget {
  readonly maxBytes: number;
  readonly maxLines: number;
  readonly strategy: "head" | "tail" | "table";
}

export interface HexHubResultTruncation {
  readonly truncated: boolean;
  readonly strategy: HexHubResultBudget["strategy"];
  readonly totalBytes: number;
  readonly outputBytes: number;
  readonly totalLines: number;
  readonly outputLines: number;
}

export interface FormattedHexHubToolResult {
  readonly content: Array<{ type: "text"; text: string }>;
  readonly details: {
    readonly tool: string;
    readonly policy: HexHubResultPolicy;
    readonly durationMs: number;
    readonly rawBytes: number;
    readonly returnedBytes: number;
    readonly truncated: boolean;
    readonly truncation: HexHubResultTruncation;
    readonly isError: boolean;
  };
}

export interface FormatHexHubResultOptions {
  readonly result: HexHubCallResult | unknown;
  readonly spec: HexHubToolSpec;
  readonly registry: HexHubAssetRegistry;
  readonly prepared: HexHubPreparedInput;
  readonly durationMs?: number;
}

const HARD_MAX_BYTES = 50 * 1024;
const HARD_MAX_LINES = 2_000;
const BUDGETS: Readonly<Record<HexHubResultPolicy, HexHubResultBudget>> =
  Object.freeze({
    assets: { maxBytes: 12 * 1024, maxLines: 400, strategy: "table" },
    shell: { maxBytes: 24 * 1024, maxLines: 800, strategy: "tail" },
    "file-read": { maxBytes: 32 * 1024, maxLines: 1_200, strategy: "head" },
    "file-mutation": { maxBytes: 4 * 1024, maxLines: 100, strategy: "head" },
    "docker-containers": {
      maxBytes: 16 * 1024,
      maxLines: 500,
      strategy: "table",
    },
    "docker-logs": { maxBytes: 24 * 1024, maxLines: 800, strategy: "tail" },
    "docker-action": { maxBytes: 4 * 1024, maxLines: 100, strategy: "head" },
    "db-objects": { maxBytes: 24 * 1024, maxLines: 800, strategy: "table" },
    ddl: { maxBytes: 24 * 1024, maxLines: 800, strategy: "head" },
    sql: { maxBytes: 32 * 1024, maxLines: 1_000, strategy: "table" },
    redis: { maxBytes: 24 * 1024, maxLines: 800, strategy: "table" },
    transfer: { maxBytes: 4 * 1024, maxLines: 100, strategy: "head" },
    tunnel: { maxBytes: 4 * 1024, maxLines: 100, strategy: "head" },
    terminal: { maxBytes: 24 * 1024, maxLines: 800, strategy: "tail" },
  });

const SENSITIVE_KEY =
  /^(?:asset_?ref|asset_?id|token|access_?token|authorization|internal_?route|routing_?key|route|container_?id)$/i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function estimateHexHubBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? String(value));
  } catch {
    try {
      return Buffer.byteLength(String(value));
    } catch {
      return 0;
    }
  }
}

function redactString(
  value: string,
  sensitiveValues: readonly string[],
): string {
  let result = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /(["']?(?:asset_?ref|asset_?id|access_?token|token|authorization)["']?\s*[:=]\s*)[^\s,;}\]]+/gi,
      "$1[redacted]",
    );
  for (const sensitive of sensitiveValues) {
    if (sensitive) result = result.split(sensitive).join("[redacted]");
  }
  return result;
}

export function redactHexHubValue(
  value: unknown,
  sensitiveValues: readonly string[] = [],
): unknown {
  if (typeof value === "string") return redactString(value, sensitiveValues);
  if (Array.isArray(value))
    return value.map((item) => redactHexHubValue(item, sensitiveValues));
  const record = asRecord(value);
  if (!record) return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (SENSITIVE_KEY.test(key)) continue;
    sanitized[key] = redactHexHubValue(child, sensitiveValues);
  }
  return sanitized;
}

function stringify(value: unknown, compact = false): string {
  if (typeof value === "string") return value;
  try {
    return (
      JSON.stringify(value, null, compact ? undefined : 2) ?? String(value)
    );
  } catch {
    return "[Unserializable HexHub result]";
  }
}

function firstString(
  value: unknown,
  keys: readonly string[],
): string | undefined {
  const record = asRecord(value);
  if (!record) return typeof value === "string" ? value : undefined;
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  for (const child of Object.values(record)) {
    const nested = asRecord(child);
    if (nested) {
      const found = firstString(nested, keys);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function firstArray(
  value: unknown,
  keys: readonly string[],
): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of keys)
    if (Array.isArray(record[key])) return record[key] as unknown[];
  for (const child of Object.values(record)) {
    const nested = asRecord(child);
    if (nested) {
      const found = firstArray(nested, keys);
      if (found) return found;
    }
  }
  return undefined;
}

function scalar(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "object") return stringify(value, true);
  return String(value).replace(/\r?\n/g, "\\n");
}

function table(rows: readonly unknown[]): string {
  if (rows.length === 0) return "No results.";
  const records = rows.map(asRecord);
  if (records.every((item) => item !== undefined)) {
    const columns = [
      ...new Set(
        (records as Record<string, unknown>[]).flatMap((row) =>
          Object.keys(row),
        ),
      ),
    ]
      .filter((key) => !SENSITIVE_KEY.test(key))
      .slice(0, 12);
    if (columns.length === 0) return `${rows.length} result(s).`;
    return [
      columns.join("\t"),
      ...(records as Record<string, unknown>[]).map((row) =>
        columns.map((column) => scalar(row[column])).join("\t"),
      ),
    ].join("\n");
  }
  return rows.map(scalar).join("\n");
}

function formatAssets(registry: HexHubAssetRegistry, result: unknown): string {
  const assets = registry.ingestAssets(result);
  if (assets.length === 0) return "No permitted HexHub assets.";
  return [
    "asset\ttype\tname\thost/path\tdatabase",
    ...assets.map((item) =>
      [
        item.asset,
        item.type,
        item.name,
        item.host ?? item.path ?? "",
        item.db_type ?? "",
      ].join("\t"),
    ),
  ].join("\n");
}

function formatShell(payload: unknown, prepared: HexHubPreparedInput): string {
  const record = asRecord(payload);
  const stdout = firstString(payload, ["stdout", "output", "text", "content"]);
  const stderr = firstString(payload, ["stderr", "error"]);
  const exitCode = record?.exit_code ?? record?.exitCode ?? record?.code;
  const heading = `Command completed${exitCode === undefined ? "" : ` (exit=${scalar(exitCode)})`}.`;
  return (
    [heading, stdout, stderr ? `stderr:\n${stderr}` : undefined]
      .filter((item): item is string => item !== undefined && item !== "")
      .join("\n\n") || stringify(prepared.remoteArgs.command ?? payload)
  );
}

function formatFileRead(
  payload: unknown,
  prepared: HexHubPreparedInput,
): string {
  const content =
    firstString(payload, ["content", "text", "data", "output"]) ??
    stringify(payload);
  const window = prepared.resultOptions?.fileWindow;
  if (!window) return content || "Remote file is empty.";
  const lines = content.split("\n");
  const start = Math.min(window.offset - 1, lines.length);
  const end = Math.min(start + window.limit, lines.length);
  const marker =
    start >= lines.length
      ? `[lines 0 of ${lines.length}; requested offset ${window.offset}]`
      : `[lines ${start + 1}-${end} of ${lines.length}]`;
  return `${start >= lines.length ? "No file lines at the requested offset." : lines.slice(start, end).join("\n")}\n\n${marker}`;
}

function formatFileMutation(
  spec: HexHubToolSpec,
  prepared: HexHubPreparedInput,
): string {
  const target =
    typeof prepared.remoteArgs.file_path === "string"
      ? prepared.remoteArgs.file_path
      : "remote file";
  return `${spec.remoteName} completed for ${target}.`;
}

function formatContainers(
  registry: HexHubAssetRegistry,
  result: unknown,
  prepared: HexHubPreparedInput,
): string {
  if (!prepared.internal.asset) return "No Docker asset was selected.";
  const containers = registry.ingestContainers(prepared.internal.asset, result);
  if (containers.length === 0) return "No containers found.";
  return [
    "container\tname\timage\tstatus\thealth",
    ...containers.map((item) =>
      [
        item.container,
        item.name,
        item.image ?? "",
        item.status ?? "",
        item.health ?? "",
      ].join("\t"),
    ),
  ].join("\n");
}

function formatLogs(payload: unknown): string {
  return (
    firstString(payload, ["logs", "output", "text", "content", "data"]) ??
    stringify(payload)
  );
}

function formatDockerAction(prepared: HexHubPreparedInput): string {
  return `Container ${prepared.internal.container?.handle ?? "action"}: ${scalar(prepared.remoteArgs.action)} completed.`;
}

function formatDbObjects(payload: unknown): string {
  const rows = firstArray(payload, [
    "objects",
    "databases",
    "schemas",
    "tables",
    "views",
    "items",
    "rows",
    "data",
  ]);
  return rows ? table(rows) : stringify(payload);
}

function formatDdl(payload: unknown): string {
  return (
    firstString(payload, [
      "ddl",
      "sql",
      "definition",
      "output",
      "text",
      "content",
    ]) ?? stringify(payload)
  );
}

function formatSql(payload: unknown): string {
  const record = asRecord(payload);
  const rows = firstArray(payload, ["rows", "records", "data", "items"]);
  if (!rows) return stringify(payload);
  const columns = Array.isArray(record?.columns)
    ? record.columns.map(String)
    : undefined;
  const body =
    columns && rows.every(Array.isArray)
      ? [
          columns.join("\t"),
          ...rows.map((row) => (row as unknown[]).map(scalar).join("\t")),
        ].join("\n")
      : table(rows);
  const count =
    record?.row_count ?? record?.rowCount ?? record?.count ?? rows.length;
  return `${body}\n\n[rows=${scalar(count)}]`;
}

function formatRedis(payload: unknown): string {
  const record = asRecord(payload);
  const value =
    record?.result ??
    record?.value ??
    record?.data ??
    record?.output ??
    payload;
  return Array.isArray(value) ? table(value) : stringify(value);
}

function transferTaskSuffix(payload: unknown): string {
  const taskId = firstString(payload, ["task_id", "taskId"]);
  return taskId && /^[A-Za-z0-9._:-]{1,128}$/u.test(taskId)
    ? ` [task_id=${taskId}]`
    : "";
}

function formatTransfer(
  payload: unknown,
  prepared: HexHubPreparedInput,
): string {
  const direction = scalar(prepared.remoteArgs.direction);
  const remotePath = scalar(prepared.remoteArgs.remote_path);
  const summary = `SCP ${direction} for ${remotePath}`;
  const suffix = transferTaskSuffix(payload);
  const status = firstString(payload, ["status", "state"])?.toLowerCase();
  switch (status) {
    case "queued":
      return `${summary} queued by HexHub; completion is not confirmed.${suffix}`;
    case "running":
      return `${summary} is running; completion is not confirmed.${suffix}`;
    case "completed":
      return `${summary} completed.${suffix}`;
    case "failed":
      return `${summary} failed.${suffix}`;
    default:
      return `${summary} was accepted by HexHub; completion status is unknown.${suffix}`;
  }
}

function formatTunnel(payload: unknown): string {
  const sanitized = asRecord(payload);
  if (!sanitized) return stringify(payload);
  const host = sanitized.host ?? sanitized.local_host ?? "127.0.0.1";
  const port = sanitized.port ?? sanitized.local_port;
  const id = sanitized.tunnel_id;
  return [
    port === undefined
      ? "Tunnel operation completed."
      : `Tunnel available at ${scalar(host)}:${scalar(port)}.`,
    id === undefined ? undefined : `tunnel_id=${scalar(id)}`,
  ]
    .filter((item): item is string => item !== undefined)
    .join("\n");
}

function formatTerminal(payload: unknown): string {
  const text = firstString(payload, ["text", "output", "rendered", "content"]);
  const record = asRecord(payload);
  const metadata = record
    ? ["terminal_id", "reason", "matched", "timeout", "idle", "user_intervened"]
        .filter((key) => record[key] !== undefined)
        .map((key) => `${key}=${scalar(record[key])}`)
    : [];
  if (text !== undefined)
    return `${text}${metadata.length ? `\n\n[${metadata.join(" ")}]` : ""}`;
  return stringify(payload);
}

function formatPolicy(
  options: FormatHexHubResultOptions,
  payload: unknown,
): string {
  switch (options.spec.resultPolicy) {
    case "assets":
      return formatAssets(options.registry, options.result);
    case "shell":
      return formatShell(payload, options.prepared);
    case "file-read":
      return formatFileRead(payload, options.prepared);
    case "file-mutation":
      return formatFileMutation(options.spec, options.prepared);
    case "docker-containers":
      return formatContainers(
        options.registry,
        options.result,
        options.prepared,
      );
    case "docker-logs":
      return formatLogs(payload);
    case "docker-action":
      return formatDockerAction(options.prepared);
    case "db-objects":
      return formatDbObjects(payload);
    case "ddl":
      return formatDdl(payload);
    case "sql":
      return formatSql(payload);
    case "redis":
      return formatRedis(payload);
    case "transfer":
      return formatTransfer(payload, options.prepared);
    case "tunnel":
      return formatTunnel(payload);
    case "terminal":
      return formatTerminal(payload);
  }
}

function sliceBytes(text: string, maxBytes: number, tail: boolean): string {
  const bytes = Buffer.from(text);
  if (bytes.byteLength <= maxBytes) return text;
  const selected = tail
    ? bytes.subarray(bytes.byteLength - maxBytes)
    : bytes.subarray(0, maxBytes);
  return new TextDecoder().decode(selected);
}

export function truncateHexHubText(
  text: string,
  requested: HexHubResultBudget,
): { text: string; metadata: HexHubResultTruncation } {
  const budget: HexHubResultBudget = {
    maxBytes: Math.min(requested.maxBytes, HARD_MAX_BYTES),
    maxLines: Math.min(requested.maxLines, HARD_MAX_LINES),
    strategy: requested.strategy,
  };
  const totalBytes = Buffer.byteLength(text);
  const lines = text.split("\n");
  const totalLines = lines.length;
  const tail = budget.strategy === "tail";
  const truncated =
    totalBytes > budget.maxBytes || totalLines > budget.maxLines;
  if (!truncated) {
    return {
      text,
      metadata: {
        truncated: false,
        strategy: budget.strategy,
        totalBytes,
        outputBytes: totalBytes,
        totalLines,
        outputLines: totalLines,
      },
    };
  }

  const markerReserve = 220;
  const contentLineLimit = Math.max(1, budget.maxLines - 1);
  const lineWindow = tail
    ? lines.slice(-contentLineLimit)
    : lines.slice(0, contentLineLimit);
  let body = sliceBytes(
    lineWindow.join("\n"),
    Math.max(1, budget.maxBytes - markerReserve),
    tail,
  );
  const marker = `[HexHub result truncated: strategy=${budget.strategy} total_lines=${totalLines} total_bytes=${totalBytes}]`;
  body = tail ? `${marker}\n${body}` : `${body}\n${marker}`;
  body = sliceBytes(body, budget.maxBytes, tail);
  const outputBytes = Buffer.byteLength(body);
  const outputLines = body.split("\n").length;
  return {
    text: body,
    metadata: {
      truncated: true,
      strategy: budget.strategy,
      totalBytes,
      outputBytes,
      totalLines,
      outputLines,
    },
  };
}

export function getHexHubResultBudget(
  policy: HexHubResultPolicy,
): HexHubResultBudget {
  return BUDGETS[policy];
}

export function formatHexHubResult(
  options: FormatHexHubResultOptions,
): FormattedHexHubToolResult {
  const root = asRecord(options.result);
  const isError = root?.isError === true;
  const rawBytes = estimateHexHubBytes(options.result);
  let payload = hexHubResultPayload(options.result);

  if (!isError && options.spec.resultPolicy === "assets") {
    // Asset ingestion occurs in the formatter so newly learned references are included in redaction.
    options.registry.ingestAssets(options.result);
  }
  payload = redactHexHubValue(payload, options.registry.getSensitiveValues());
  let formatted = isError
    ? (firstString(payload, ["error", "message", "text", "content"]) ??
      stringify(payload))
    : formatPolicy(options, payload);
  formatted = redactString(
    formatted || "HexHub tool completed with no content.",
    options.registry.getSensitiveValues(),
  );
  const bounded = truncateHexHubText(
    formatted,
    BUDGETS[options.spec.resultPolicy],
  );

  return {
    content: [{ type: "text", text: bounded.text }],
    details: {
      tool: options.spec.name,
      policy: options.spec.resultPolicy,
      durationMs: Math.max(0, Math.round(options.durationMs ?? 0)),
      rawBytes,
      returnedBytes: Buffer.byteLength(bounded.text),
      truncated: bounded.metadata.truncated,
      truncation: bounded.metadata,
      isError,
    },
  };
}
