import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  FetchLike,
  Transport,
} from "@modelcontextprotocol/sdk/shared/transport.js";

import type {
  HexHubCallResult,
  HexHubCatalogSnapshot,
  HexHubConfig,
  HexHubConnectionStatus,
  RemoteToolDefinition,
} from "./contracts.js";
import { parseHexHubConfig, resolveHexHubAuthHeaders } from "./config.js";

export type { FetchLike };

export interface ResolvedHexHubFetch {
  fetch: FetchLike;
  kind: "direct" | "windows-helper";
}

export type HexHubFetchResolver = (
  config: HexHubConfig,
) => ResolvedHexHubFetch | Promise<ResolvedHexHubFetch>;

export interface HexHubMcpClientOptions {
  fetchResolver?: HexHubFetchResolver;
  env?: NodeJS.ProcessEnv;
  clientFactory?: () => Client;
  transportFactory?: (
    url: URL,
    options: StreamableHTTPClientTransportOptions,
  ) => StreamableHTTPClientTransport;
  closeTimeoutMs?: number;
}

export interface HexHubCallToolOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface ConnectionEntry {
  generation: number;
  client: Client;
  transport: StreamableHTTPClientTransport;
}

interface ConnectFlight {
  generation: number;
  promise: Promise<HexHubConnectionStatus>;
}

const EMPTY_CATALOG: HexHubCatalogSnapshot = Object.freeze({
  epoch: 0,
  tools: Object.freeze([]) as unknown as RemoteToolDefinition[],
  names: new Set<string>(),
  unknownNames: Object.freeze([]),
  incompatible: new Map<string, string>(),
});

const MAX_CATALOG_PAGES = 100;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;

export const defaultHexHubFetchResolver: HexHubFetchResolver = () => ({
  fetch: globalThis.fetch.bind(globalThis) as FetchLike,
  kind: "direct",
});

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  return new DOMException("The operation was aborted", "AbortError");
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    "aborted" in value &&
    "addEventListener" in value
  );
}

async function awaitWithSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortError(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function freezeCatalog(
  epoch: number,
  tools: RemoteToolDefinition[],
): HexHubCatalogSnapshot {
  const frozenTools = tools.map((tool) =>
    Object.freeze({
      ...tool,
      inputSchema: Object.freeze({ ...tool.inputSchema }),
      ...(tool.annotations
        ? { annotations: Object.freeze({ ...tool.annotations }) }
        : {}),
    }),
  );
  return Object.freeze({
    epoch,
    tools: Object.freeze(frozenTools) as unknown as RemoteToolDefinition[],
    names: new Set(frozenTools.map((tool) => tool.name)),
    unknownNames: Object.freeze([]),
    incompatible: new Map<string, string>(),
  });
}

function asRemoteTool(tool: {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}): RemoteToolDefinition {
  return {
    name: tool.name,
    ...(tool.description === undefined
      ? {}
      : { description: tool.description }),
    inputSchema: tool.inputSchema,
    ...(tool.annotations === undefined
      ? {}
      : { annotations: tool.annotations }),
  };
}

function errorCode(error: unknown): number | undefined {
  if (error instanceof StreamableHTTPError) return error.code;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "number" ? code : undefined;
  }
  return undefined;
}

function isCancelled(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function isSessionInvalidError(error: unknown): boolean {
  const code = errorCode(error);
  if (code === 401 || code === 403) return false;
  if (code === 404) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:invalid|expired|unknown|missing|not found)\s+(?:mcp[- ]?)?session|session\s+(?:is\s+)?(?:invalid|expired|unknown|missing|not found)/i.test(
    message,
  );
}

function deadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

export class HexHubMcpClient {
  private config: HexHubConfig | undefined;
  private readonly options: Required<
    Pick<
      HexHubMcpClientOptions,
      | "fetchResolver"
      | "env"
      | "clientFactory"
      | "transportFactory"
      | "closeTimeoutMs"
    >
  >;
  private generation = 0;
  private generationAbort = new AbortController();
  private active: ConnectionEntry | undefined;
  private pending: ConnectionEntry | undefined;
  private connectFlight: ConnectFlight | undefined;
  private catalog: HexHubCatalogSnapshot = EMPTY_CATALOG;
  private status: HexHubConnectionStatus = {
    state: "unconfigured",
    connected: false,
    catalogEpoch: 0,
    remoteToolCount: 0,
  };

  constructor(config?: HexHubConfig, options: HexHubMcpClientOptions = {}) {
    this.options = {
      fetchResolver: options.fetchResolver ?? defaultHexHubFetchResolver,
      env: options.env ?? process.env,
      clientFactory:
        options.clientFactory ??
        (() =>
          new Client(
            { name: "pi-hexhub", version: "0.1.0" },
            { capabilities: {} },
          )),
      transportFactory:
        options.transportFactory ??
        ((url, transportOptions) =>
          new StreamableHTTPClientTransport(url, transportOptions)),
      closeTimeoutMs: options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
    };
    if (config) {
      this.config = parseHexHubConfig(config);
      this.status = this.readyStatus();
    }
  }

  getGeneration(): number {
    return this.generation;
  }

  getStatus(): HexHubConnectionStatus {
    return { ...this.status };
  }

  getCatalog(): HexHubCatalogSnapshot {
    return this.catalog;
  }

  async configure(config?: HexHubConfig): Promise<void> {
    const next = config ? parseHexHubConfig(config) : undefined;
    const oldEntries = this.invalidate(next, true);
    await Promise.all(oldEntries.map((entry) => this.closeEntry(entry)));
  }

  async connect(signal?: AbortSignal): Promise<HexHubConnectionStatus> {
    if (signal?.aborted) throw this.safeError(abortError(signal.reason));
    if (!this.config) throw new Error("HexHub is not configured");
    if (this.active?.generation === this.generation) return this.getStatus();
    if (this.connectFlight?.generation === this.generation) {
      return awaitWithSignal(this.connectFlight.promise, signal);
    }

    const generation = this.generation;
    const promise = this.establishConnection(generation).finally(() => {
      if (this.connectFlight?.promise === promise)
        this.connectFlight = undefined;
    });
    this.connectFlight = { generation, promise };
    return awaitWithSignal(promise, signal);
  }

  async reconnect(signal?: AbortSignal): Promise<HexHubConnectionStatus> {
    if (!this.config) throw new Error("HexHub is not configured");
    const oldEntries = this.invalidate(this.config, true);
    await Promise.all(oldEntries.map((entry) => this.closeEntry(entry)));
    return this.connect(signal);
  }

  async refreshCatalog(signal?: AbortSignal): Promise<HexHubCatalogSnapshot> {
    return this.withSessionRetry(signal, async (entry, operationSignal) => {
      const tools = await this.listRemoteTools(entry.client, operationSignal);
      this.assertCurrent(entry.generation);
      this.publishCatalog(tools);
      this.status = {
        ...this.status,
        catalogEpoch: this.catalog.epoch,
        remoteToolCount: this.catalog.tools.length,
        lastError: undefined,
      };
      return this.catalog;
    });
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    signalOrOptions?: AbortSignal | HexHubCallToolOptions,
  ): Promise<HexHubCallResult> {
    if (!name.trim()) throw new TypeError("HexHub tool name must not be empty");
    const options = isAbortSignal(signalOrOptions)
      ? { signal: signalOrOptions }
      : (signalOrOptions ?? {});
    return this.withSessionRetry(
      options.signal,
      async (entry, operationSignal) => {
        const timeout = options.timeoutMs ?? this.requireConfig().timeoutMs;
        const result = await entry.client.callTool(
          { name, arguments: args },
          undefined,
          { signal: operationSignal, timeout, maxTotalTimeout: timeout },
        );
        this.assertCurrent(entry.generation);
        return result as HexHubCallResult;
      },
    );
  }

  async close(): Promise<void> {
    const oldEntries = this.invalidate(this.config, true);
    await Promise.all(oldEntries.map((entry) => this.closeEntry(entry)));
  }

  private readyStatus(): HexHubConnectionStatus {
    if (!this.config) {
      return {
        state: "unconfigured",
        connected: false,
        catalogEpoch: this.catalog.epoch,
        remoteToolCount: this.catalog.tools.length,
      };
    }
    return {
      state: "ready",
      connected: false,
      endpoint: this.config.url,
      catalogEpoch: this.catalog.epoch,
      remoteToolCount: this.catalog.tools.length,
    };
  }

  private requireConfig(): HexHubConfig {
    if (!this.config) throw new Error("HexHub is not configured");
    return this.config;
  }

  private invalidate(
    nextConfig: HexHubConfig | undefined,
    clearCatalog: boolean,
  ): ConnectionEntry[] {
    this.generation += 1;
    this.generationAbort.abort(
      new DOMException("HexHub configuration changed", "AbortError"),
    );
    this.generationAbort = new AbortController();
    const entries = [
      ...new Set(
        [this.active, this.pending].filter(
          (entry): entry is ConnectionEntry => entry !== undefined,
        ),
      ),
    ];
    this.active = undefined;
    this.pending = undefined;
    this.connectFlight = undefined;
    this.config = nextConfig;
    if (clearCatalog) this.publishCatalog([]);
    this.status = this.readyStatus();
    return entries;
  }

  private async establishConnection(
    generation: number,
  ): Promise<HexHubConnectionStatus> {
    const config = this.requireConfig();
    const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
    const operationSignal = AbortSignal.any([
      this.generationAbort.signal,
      timeoutSignal,
    ]);
    let entry: ConnectionEntry | undefined;
    if (generation === this.generation) {
      this.status = { ...this.readyStatus(), state: "connecting" };
    }

    try {
      const resolved = await awaitWithSignal(
        Promise.resolve(this.options.fetchResolver(config)),
        operationSignal,
      );
      this.assertCurrent(generation);
      const headers = resolveHexHubAuthHeaders(config, this.options.env);
      const transport = this.options.transportFactory(new URL(config.url), {
        fetch: resolved.fetch,
        requestInit: { headers },
        reconnectionOptions: {
          initialReconnectionDelay: 250,
          maxReconnectionDelay: 1_000,
          reconnectionDelayGrowFactor: 1.5,
          maxRetries: 0,
        },
      });
      const client = this.options.clientFactory();
      entry = { generation, client, transport };
      this.pending = entry;

      await client.connect(transport as Transport, {
        signal: operationSignal,
        timeout: config.timeoutMs,
        maxTotalTimeout: config.timeoutMs,
      });
      const tools = await this.listRemoteTools(client, operationSignal);
      this.assertCurrent(generation);

      this.pending = undefined;
      this.active = entry;
      this.publishCatalog(tools);
      const server = client.getServerVersion();
      this.status = {
        state: "connected",
        connected: true,
        endpoint: config.url,
        transport: resolved.kind,
        ...(server?.name ? { serverName: server.name } : {}),
        ...(server?.version ? { serverVersion: server.version } : {}),
        ...(transport.protocolVersion
          ? { protocolVersion: transport.protocolVersion }
          : {}),
        ...(transport.sessionId ? { sessionId: transport.sessionId } : {}),
        catalogEpoch: this.catalog.epoch,
        remoteToolCount: this.catalog.tools.length,
      };
      return this.getStatus();
    } catch (error) {
      if (entry) {
        if (this.pending === entry) this.pending = undefined;
        await this.closeEntry(entry);
      }
      const safe = this.safeError(error);
      if (generation === this.generation) {
        this.status = {
          ...this.readyStatus(),
          state: "error",
          lastError: safe.message,
        };
      }
      throw safe;
    }
  }

  private async listRemoteTools(
    client: Client,
    signal?: AbortSignal,
  ): Promise<RemoteToolDefinition[]> {
    const tools: RemoteToolDefinition[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
      const config = this.requireConfig();
      const result = await client.listTools(cursor ? { cursor } : undefined, {
        signal,
        timeout: config.timeoutMs,
        maxTotalTimeout: config.timeoutMs,
      });
      tools.push(
        ...result.tools.map((tool) =>
          asRemoteTool(tool as Parameters<typeof asRemoteTool>[0]),
        ),
      );
      if (!result.nextCursor) return tools;
      if (seenCursors.has(result.nextCursor))
        throw new Error("HexHub tools/list returned a repeated cursor");
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error(`HexHub tools/list exceeded ${MAX_CATALOG_PAGES} pages`);
  }

  private async withSessionRetry<T>(
    signal: AbortSignal | undefined,
    operation: (
      entry: ConnectionEntry,
      signal: AbortSignal | undefined,
    ) => Promise<T>,
  ): Promise<T> {
    const execute = async (): Promise<T> => {
      await this.connect(signal);
      const entry = this.active;
      if (!entry || entry.generation !== this.generation)
        throw new Error("HexHub connection became stale");
      return operation(entry, signal);
    };

    try {
      return await execute();
    } catch (error) {
      if (isCancelled(error, signal) || !isSessionInvalidError(error))
        throw this.safeError(error);
      await this.reconnect(signal);
      try {
        return await execute();
      } catch (retryError) {
        throw this.safeError(retryError);
      }
    }
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.generation || this.generationAbort.signal.aborted) {
      throw new DOMException(
        "Stale HexHub connection generation",
        "AbortError",
      );
    }
  }

  private publishCatalog(tools: RemoteToolDefinition[]): void {
    this.catalog = freezeCatalog(this.catalog.epoch + 1, tools);
  }

  private safeError(error: unknown): Error {
    const original = error instanceof Error ? error : new Error(String(error));
    let message =
      original.message || original.name || "HexHub operation failed";
    const auth = this.config?.auth;
    const token =
      auth?.type === "token"
        ? auth.token
        : auth?.type === "env"
          ? this.options.env[auth.env]
          : undefined;
    if (token) {
      for (const secret of [token, encodeURIComponent(token)]) {
        if (secret) message = message.split(secret).join("[redacted]");
      }
    }
    if (original.name === "AbortError" || /\bAbortError\s*:/i.test(message)) {
      return new DOMException(
        message.replace(/^.*?AbortError\s*:\s*/i, "") ||
          "The operation was aborted",
        "AbortError",
      );
    }
    if (original.name === "TimeoutError")
      return new DOMException(message, "TimeoutError");
    const safe = new Error(message);
    safe.name = original.name;
    if ("code" in original)
      Object.assign(safe, {
        code: (original as Error & { code?: unknown }).code,
      });
    return safe;
  }

  private async closeEntry(entry: ConnectionEntry): Promise<void> {
    const timeout = this.options.closeTimeoutMs;
    await deadline(entry.transport.terminateSession(), timeout);
    await deadline(entry.client.close(), timeout);
  }
}
