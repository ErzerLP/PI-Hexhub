export const HEXHUB_TOOL_GROUPS = [
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
] as const;

export type HexHubToolGroup = (typeof HEXHUB_TOOL_GROUPS)[number];
export type HexHubTransportMode = "auto" | "direct" | "windows-helper";
export type HexHubAuthHeader = "authorization" | "x-hexhub-token";

export type HexHubAuthConfig =
  | { type: "none" }
  | { type: "env"; env: string; header: HexHubAuthHeader }
  | { type: "token"; token: string; header: HexHubAuthHeader };

export interface HexHubConfig {
  version: 1;
  url: string;
  transport: HexHubTransportMode;
  timeoutMs: number;
  auth: HexHubAuthConfig;
  initialGroups: HexHubToolGroup[];
}

export interface LoadedHexHubConfig {
  config: HexHubConfig;
  globalPath: string;
  projectPath: string;
  globalLoaded: boolean;
  projectLoaded: boolean;
  deprecatedKeys: string[];
}

export interface RemoteToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface HexHubCatalogSnapshot {
  epoch: number;
  tools: RemoteToolDefinition[];
  names: ReadonlySet<string>;
  unknownNames: readonly string[];
  incompatible: ReadonlyMap<string, string>;
}

export interface HexHubContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface HexHubCallResult {
  content?: HexHubContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

export interface HexHubConnectionStatus {
  state: "unconfigured" | "ready" | "connecting" | "connected" | "error";
  connected: boolean;
  endpoint?: string;
  transport?: "direct" | "windows-helper";
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  sessionId?: string;
  catalogEpoch: number;
  remoteToolCount: number;
  lastError?: string;
}

export interface HexHubToolDetails {
  remoteTool: string;
  endpoint: string;
  transport?: string;
  catalogEpoch: number;
  durationMs: number;
  rawBytes: number;
  returnedBytes: number;
  truncated: boolean;
  policy: string;
}

export interface TunnelBridgeResult {
  host: string;
  port: number;
  close(): Promise<void>;
}
