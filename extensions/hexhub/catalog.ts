import { Type, type TSchema } from "typebox";

import type { HexHubToolGroup } from "./contracts.js";

export type HexHubToolRisk = "read" | "mutate" | "destructive" | "interactive";
export type HexHubExecutionMode = "parallel" | "sequential";
export type HexHubResultPolicy =
  | "assets"
  | "shell"
  | "file-read"
  | "file-mutation"
  | "docker-containers"
  | "docker-logs"
  | "docker-action"
  | "db-objects"
  | "ddl"
  | "sql"
  | "redis"
  | "transfer"
  | "tunnel"
  | "terminal";

export interface HexHubToolSpec {
  readonly name: `hexhub_${string}`;
  readonly label: string;
  readonly remoteName: string;
  readonly group: HexHubToolGroup | "assets";
  readonly description: string;
  readonly parameters: TSchema;
  readonly reviewedRemoteSchema: Readonly<Record<string, unknown>>;
  readonly risk: HexHubToolRisk;
  readonly executionMode: HexHubExecutionMode;
  readonly resultPolicy: HexHubResultPolicy;
  readonly containerField?: "container_id" | "container_name";
  readonly requiresReadEvidence?: boolean;
}

const str = (description?: string) =>
  Type.String(description ? { description } : {});
const optStr = (description?: string) => Type.Optional(str(description));
const int = (options: Record<string, unknown> = {}) => Type.Integer(options);
const optInt = (options: Record<string, unknown> = {}) =>
  Type.Optional(int(options));
const optBool = () => Type.Optional(Type.Boolean());
const enumeration = (values: readonly string[]) =>
  Type.String({ enum: [...values] });
const optEnum = (values: readonly string[]) =>
  Type.Optional(enumeration(values));
const object = (properties: Record<string, TSchema>) =>
  Type.Object(properties, { additionalProperties: false });

const asset = str("Short asset key or unique name");
const optionalAsset = optStr("Short asset key or unique name");
const container = optStr("Short container key or unique name");
const filePath = str("Absolute path on the remote target");

const assetsSchema = object({
  pattern: Type.Optional(
    Type.String({ default: "", description: "Optional asset filter" }),
  ),
});
const shellSchema = object({
  asset,
  container,
  command: str("Command on the selected remote target"),
  description: optStr(),
  timeout: optInt({ minimum: 1, maximum: 300_000 }),
});
const readSchema = object({
  asset,
  container,
  file_path: filePath,
  offset: optInt({ minimum: 1 }),
  limit: optInt({ minimum: 1, maximum: 2_000 }),
});
const writeSchema = object({
  asset,
  container,
  file_path: filePath,
  content: str("Complete file content"),
  mode: optInt({ minimum: 0 }),
});
const editSchema = object({
  asset,
  container,
  file_path: filePath,
  old_string: str(),
  new_string: str(),
  replace_all: optBool(),
});
const editItemSchema = object({
  old_string: str(),
  new_string: str(),
  replace_all: optBool(),
});
const multiEditSchema = object({
  asset,
  container,
  file_path: filePath,
  edits: Type.Array(editItemSchema, { minItems: 1 }),
});
const deleteSchema = object({ asset, container, file_path: filePath });
const dockerContainersSchema = object({ asset });
const dockerLogsSchema = object({
  asset,
  container: str("Short container key or unique name"),
  filter: optStr(),
  show_stderr: optBool(),
  show_stdout: optBool(),
  tail_lines: optInt({ minimum: 1, maximum: 10_000, default: 200 }),
  timestamps: optBool(),
});
const dockerActionSchema = object({
  asset,
  container: str("Short container key or unique name"),
  action: enumeration(["pause", "restart", "start", "stop"]),
});
const dbObjectsSchema = object({
  asset,
  db: optStr(),
  pattern: optStr(),
  query_type: optEnum([
    "database",
    "schema",
    "table",
    "view",
    "function",
    "procedure",
    "object",
  ]),
  schema: optStr(),
});
const ddlSchema = object({
  asset,
  db: optStr(),
  schema: str(),
  table: str(),
});
const sqlSchema = object({
  asset,
  db: str("Database/catalog; do not guess"),
  schema: str("Schema/context; do not guess"),
  sql: str(),
});
const redisSchema = object({
  asset,
  command: str(),
  db: optInt({ minimum: 0 }),
  timeout: optInt({ minimum: 1, maximum: 300_000, default: 20_000 }),
  description: optStr(),
});
const scpSchema = object({
  asset,
  direction: enumeration(["upload", "download"]),
  local_path: str("Path on the machine running HexHub"),
  remote_path: str("Absolute path on the SSH target"),
  overwrite: optBool(),
});
const tunnelOpenSchema = object({
  asset,
  target_host: str(),
  target_port: int({ minimum: 1, maximum: 65_535 }),
  description: optStr(),
});
const tunnelCloseSchema = object({ tunnel_id: str() });
const terminalOpenSchema = object({
  asset,
  initial_input: optStr(),
  append_enter: optBool(),
});
const terminalCloseSchema = object({ terminal_id: str() });
const terminalsSchema = object({ asset: optionalAsset });
const terminalSendSchema = object({
  terminal_id: str(),
  input: str(),
  append_enter: optBool(),
});
const terminalKeySchema = object({
  terminal_id: str(),
  key: enumeration([
    "enter",
    "tab",
    "esc",
    "backspace",
    "delete",
    "ctrl_c",
    "ctrl_d",
    "ctrl_z",
    "up",
    "down",
    "left",
    "right",
    "home",
    "end",
    "page_up",
    "page_down",
    "space",
  ]),
  count: optInt({ minimum: 1 }),
});
const terminalReadSchema = object({
  terminal_id: str(),
  lines: optInt({ minimum: 1 }),
  max_chars: optInt({ minimum: 1 }),
  mode: optEnum(["cursor_before", "viewport", "tail"]),
});
const terminalExpectSchema = object({
  terminal_id: str(),
  input: optStr(),
  append_enter: optBool(),
  wait_for: Type.Optional(Type.Array(Type.String())),
  match: optEnum(["contains", "regex"]),
  idle_ms: optInt({ minimum: 0 }),
  min_wait_ms: optInt({ minimum: 0 }),
  timeout_ms: optInt({ minimum: 1 }),
  lines: optInt({ minimum: 1 }),
  max_chars: optInt({ minimum: 1 }),
  mode: optEnum(["cursor_before", "viewport", "tail"]),
});

function cloneSchema(schema: TSchema): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

function stripAdditionalProperties(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) stripAdditionalProperties(item);
    return;
  }
  const record = value as Record<string, unknown>;
  delete record.additionalProperties;
  for (const child of Object.values(record)) stripAdditionalProperties(child);
}

function remoteSchema(
  modelSchema: TSchema,
  options: {
    containerField?: "container_id" | "container_name";
    omit?: readonly string[];
    add?: Readonly<Record<string, TSchema>>;
    additionalProperties?: false;
  } = {},
): Readonly<Record<string, unknown>> {
  const schema = cloneSchema(modelSchema);
  stripAdditionalProperties(schema);
  const properties = schema.properties as Record<string, unknown>;
  const required = Array.isArray(schema.required)
    ? (schema.required as string[])
    : [];
  if (properties.asset) {
    properties.asset_ref = properties.asset;
    delete properties.asset;
    const index = required.indexOf("asset");
    if (index >= 0) required[index] = "asset_ref";
  }
  if (properties.container && options.containerField) {
    properties[options.containerField] = properties.container;
    delete properties.container;
    const index = required.indexOf("container");
    if (index >= 0) required[index] = options.containerField;
  }
  for (const key of options.omit ?? []) {
    delete properties[key];
    const index = required.indexOf(key);
    if (index >= 0) required.splice(index, 1);
  }
  for (const [key, value] of Object.entries(options.add ?? {})) {
    const added = cloneSchema(value);
    stripAdditionalProperties(added);
    properties[key] = added;
  }
  if (required.length === 0) delete schema.required;
  if (options.additionalProperties === false)
    schema.additionalProperties = false;
  return Object.freeze(schema);
}

interface SpecOptions {
  name: HexHubToolSpec["name"];
  remoteName: string;
  label: string;
  group: HexHubToolSpec["group"];
  description: string;
  parameters: TSchema;
  risk: HexHubToolRisk;
  resultPolicy: HexHubResultPolicy;
  executionMode?: HexHubExecutionMode;
  containerField?: HexHubToolSpec["containerField"];
  requiresReadEvidence?: boolean;
  remoteOmit?: readonly string[];
  remoteAdd?: Readonly<Record<string, TSchema>>;
  remoteAdditionalProperties?: false;
}

function spec(options: SpecOptions): HexHubToolSpec {
  return Object.freeze({
    ...options,
    executionMode:
      options.executionMode ??
      (options.risk === "read" ? "parallel" : "sequential"),
    reviewedRemoteSchema: remoteSchema(options.parameters, {
      ...(options.containerField
        ? { containerField: options.containerField }
        : {}),
      ...(options.remoteOmit ? { omit: options.remoteOmit } : {}),
      ...(options.remoteAdd ? { add: options.remoteAdd } : {}),
      ...(options.remoteAdditionalProperties === false
        ? { additionalProperties: false }
        : {}),
    }),
  });
}

export const HEXHUB_TOOL_SPECS = Object.freeze([
  spec({
    name: "hexhub_assets",
    remoteName: "list_assets",
    label: "HexHub assets",
    group: "assets",
    description: "List permitted assets using short session keys.",
    parameters: assetsSchema,
    risk: "read",
    resultPolicy: "assets",
  }),
  spec({
    name: "hexhub_shell",
    remoteName: "shell",
    label: "HexHub shell",
    group: "shell",
    description: "Run a command on an authorized SSH or Docker target.",
    parameters: shellSchema,
    risk: "mutate",
    resultPolicy: "shell",
    containerField: "container_id",
    remoteAdd: { timeout_ms: Type.Integer() },
  }),
  spec({
    name: "hexhub_read",
    remoteName: "read",
    label: "HexHub read",
    group: "files-read",
    description: "Read a remote SSH or container file by line window.",
    parameters: readSchema,
    risk: "read",
    resultPolicy: "file-read",
    containerField: "container_id",
    remoteOmit: ["offset", "limit"],
  }),
  spec({
    name: "hexhub_write",
    remoteName: "write",
    label: "HexHub write",
    group: "files-write",
    description: "Overwrite a previously read remote file.",
    parameters: writeSchema,
    risk: "mutate",
    resultPolicy: "file-mutation",
    containerField: "container_id",
    requiresReadEvidence: true,
  }),
  spec({
    name: "hexhub_edit",
    remoteName: "edit",
    label: "HexHub edit",
    group: "files-write",
    description: "Replace exact text in a previously read remote file.",
    parameters: editSchema,
    risk: "mutate",
    resultPolicy: "file-mutation",
    containerField: "container_id",
    requiresReadEvidence: true,
  }),
  spec({
    name: "hexhub_multi_edit",
    remoteName: "multi_edit",
    label: "HexHub multi edit",
    group: "files-write",
    description: "Apply ordered exact replacements to a previously read file.",
    parameters: multiEditSchema,
    risk: "mutate",
    resultPolicy: "file-mutation",
    containerField: "container_id",
    requiresReadEvidence: true,
  }),
  spec({
    name: "hexhub_delete",
    remoteName: "delete",
    label: "HexHub delete",
    group: "files-write",
    description: "Delete one previously read remote file.",
    parameters: deleteSchema,
    risk: "destructive",
    resultPolicy: "file-mutation",
    containerField: "container_id",
    requiresReadEvidence: true,
  }),
  spec({
    name: "hexhub_docker_containers",
    remoteName: "list_docker_containers",
    label: "HexHub containers",
    group: "docker-read",
    description: "List containers using short session keys.",
    parameters: dockerContainersSchema,
    risk: "read",
    resultPolicy: "docker-containers",
  }),
  spec({
    name: "hexhub_docker_logs",
    remoteName: "docker_container_logs",
    label: "HexHub Docker logs",
    group: "docker-read",
    description: "Read a bounded recent container log window.",
    parameters: dockerLogsSchema,
    risk: "read",
    resultPolicy: "docker-logs",
    containerField: "container_name",
  }),
  spec({
    name: "hexhub_docker_action",
    remoteName: "docker_container_action",
    label: "HexHub Docker action",
    group: "docker-control",
    description: "Start, stop, pause, or restart a container.",
    parameters: dockerActionSchema,
    risk: "destructive",
    resultPolicy: "docker-action",
    containerField: "container_name",
  }),
  spec({
    name: "hexhub_db_objects",
    remoteName: "list_db_objects",
    label: "HexHub DB objects",
    group: "database-meta",
    description: "List database metadata without metadata SQL.",
    parameters: dbObjectsSchema,
    risk: "read",
    resultPolicy: "db-objects",
  }),
  spec({
    name: "hexhub_db_ddl",
    remoteName: "db_table_ddl",
    label: "HexHub table DDL",
    group: "database-meta",
    description: "Read table or view DDL.",
    parameters: ddlSchema,
    risk: "read",
    resultPolicy: "ddl",
  }),
  spec({
    name: "hexhub_sql",
    remoteName: "execute_sql",
    label: "HexHub SQL",
    group: "database-sql",
    description: "Execute SQL with an explicit database and schema.",
    parameters: sqlSchema,
    risk: "mutate",
    resultPolicy: "sql",
  }),
  spec({
    name: "hexhub_redis",
    remoteName: "redis_command",
    label: "HexHub Redis",
    group: "redis",
    description:
      "Run an authorized Redis command; writes remain server-confirmed.",
    parameters: redisSchema,
    risk: "mutate",
    resultPolicy: "redis",
    remoteAdditionalProperties: false,
  }),
  spec({
    name: "hexhub_scp",
    remoteName: "scp_transfer",
    label: "HexHub SCP",
    group: "transfer",
    description: "Upload or download through an authorized SSH asset.",
    parameters: scpSchema,
    risk: "mutate",
    resultPolicy: "transfer",
  }),
  spec({
    name: "hexhub_tunnel_open",
    remoteName: "open_ssh_tunnel",
    label: "HexHub open tunnel",
    group: "tunnel",
    description: "Open an SSH TCP tunnel to an explicit target.",
    parameters: tunnelOpenSchema,
    risk: "mutate",
    resultPolicy: "tunnel",
  }),
  spec({
    name: "hexhub_tunnel_close",
    remoteName: "close_ssh_tunnel",
    label: "HexHub close tunnel",
    group: "tunnel",
    description: "Close a HexHub SSH tunnel.",
    parameters: tunnelCloseSchema,
    risk: "mutate",
    resultPolicy: "tunnel",
  }),
  spec({
    name: "hexhub_terminal_open",
    remoteName: "open_ssh_terminal",
    label: "HexHub open terminal",
    group: "terminal",
    description: "Open a visible interactive SSH terminal.",
    parameters: terminalOpenSchema,
    risk: "interactive",
    resultPolicy: "terminal",
  }),
  spec({
    name: "hexhub_terminal_close",
    remoteName: "close_ssh_terminal",
    label: "HexHub close terminal",
    group: "terminal",
    description: "Close an interactive SSH terminal.",
    parameters: terminalCloseSchema,
    risk: "interactive",
    resultPolicy: "terminal",
  }),
  spec({
    name: "hexhub_terminals",
    remoteName: "list_ssh_terminals",
    label: "HexHub terminals",
    group: "terminal",
    description: "List visible interactive SSH terminals.",
    parameters: terminalsSchema,
    risk: "read",
    resultPolicy: "terminal",
  }),
  spec({
    name: "hexhub_terminal_send",
    remoteName: "ssh_terminal_send",
    label: "HexHub terminal send",
    group: "terminal",
    description: "Send raw input to an interactive terminal.",
    parameters: terminalSendSchema,
    risk: "interactive",
    resultPolicy: "terminal",
  }),
  spec({
    name: "hexhub_terminal_key",
    remoteName: "ssh_terminal_key",
    label: "HexHub terminal key",
    group: "terminal",
    description: "Send a named key to an interactive terminal.",
    parameters: terminalKeySchema,
    risk: "interactive",
    resultPolicy: "terminal",
  }),
  spec({
    name: "hexhub_terminal_read",
    remoteName: "ssh_terminal_read",
    label: "HexHub terminal read",
    group: "terminal",
    description: "Read a bounded rendered terminal window.",
    parameters: terminalReadSchema,
    risk: "read",
    resultPolicy: "terminal",
  }),
  spec({
    name: "hexhub_terminal_expect",
    remoteName: "ssh_terminal_expect",
    label: "HexHub terminal expect",
    group: "terminal",
    description: "Wait for terminal match, idle, timeout, or intervention.",
    parameters: terminalExpectSchema,
    risk: "interactive",
    resultPolicy: "terminal",
  }),
] as const satisfies readonly HexHubToolSpec[]);

export const HEXHUB_TOOL_LOADER = Object.freeze({
  name: "hexhub_tools" as const,
  label: "HexHub tools",
  description: "Activate reviewed HexHub tool groups for the current task.",
  parameters: object({
    query: optStr("Task or capability to route locally"),
    groups: Type.Optional(
      Type.Array(
        enumeration([
          "shell",
          "files-read",
          "files-write",
          "docker-read",
          "docker-control",
          "database-meta",
          "database-sql",
          "redis",
          "transfer",
          "tunnel",
          "terminal",
        ]),
        { uniqueItems: true },
      ),
    ),
  }),
});

export const HEXHUB_DIRECT_TOOL_NAMES: ReadonlySet<string> = new Set(
  HEXHUB_TOOL_SPECS.map((item) => item.name),
);
export const HEXHUB_REMOTE_TOOL_NAMES: ReadonlySet<string> = new Set(
  HEXHUB_TOOL_SPECS.map((item) => item.remoteName),
);
export const HEXHUB_MANAGED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...HEXHUB_DIRECT_TOOL_NAMES,
  HEXHUB_TOOL_LOADER.name,
]);
export const HEXHUB_SPEC_BY_NAME: ReadonlyMap<string, HexHubToolSpec> = new Map(
  HEXHUB_TOOL_SPECS.map((item) => [item.name, item]),
);
export const HEXHUB_SPEC_BY_REMOTE_NAME: ReadonlyMap<string, HexHubToolSpec> =
  new Map(HEXHUB_TOOL_SPECS.map((item) => [item.remoteName, item]));

export function hexHubToolsInGroups(
  groups: readonly HexHubToolGroup[],
): HexHubToolSpec[] {
  const selected = new Set(groups);
  return HEXHUB_TOOL_SPECS.filter(
    (item) => item.group !== "assets" && selected.has(item.group),
  );
}
