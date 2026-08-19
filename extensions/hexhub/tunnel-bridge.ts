import {
  createServer as nodeCreateServer,
  isIP,
  type Server,
  type Socket,
} from "node:net";

import type { HexHubCallResult } from "./contracts.js";
import type { HexHubTunnelResultHook } from "./tool-controller.js";
import {
  BoundedTextCollector,
  abortError,
  spawnPowerShellScript,
  terminatePowerShell,
  timeoutError,
  probePowerShell,
  type PowerShellChild,
  type PowerShellSpawn,
} from "./powershell.js";

export const DEFAULT_TUNNEL_MAX_CONNECTIONS = 32;
export const DEFAULT_TUNNEL_CLOSE_TIMEOUT_MS = 2_000;

export const WINDOWS_TUNNEL_RELAY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$inputStream = [Console]::OpenStandardInput()
$outputStream = [Console]::OpenStandardOutput()
$prefix = [byte[]]::new(4)
$offset = 0
while ($offset -lt 4) {
  $read = $inputStream.Read($prefix, $offset, 4 - $offset)
  if ($read -le 0) { throw 'Missing relay port prefix' }
  $offset += $read
}
$port = ([int] $prefix[0] -shl 24) -bor ([int] $prefix[1] -shl 16) -bor ([int] $prefix[2] -shl 8) -bor [int] $prefix[3]
if ($port -lt 1 -or $port -gt 65535) { throw 'Invalid relay port' }
$client = [System.Net.Sockets.TcpClient]::new()
try {
  $client.NoDelay = $true
  $client.Connect('127.0.0.1', $port)
  $network = $client.GetStream()
  $upload = $inputStream.CopyToAsync($network)
  $download = $network.CopyToAsync($outputStream)
  $first = [System.Threading.Tasks.Task]::WhenAny($upload, $download).GetAwaiter().GetResult()
  if ([object]::ReferenceEquals($first, $upload)) {
    $upload.GetAwaiter().GetResult()
    $network.Flush()
    try { $client.Client.Shutdown([System.Net.Sockets.SocketShutdown]::Send) } catch {}
    $download.GetAwaiter().GetResult()
  } else {
    $download.GetAwaiter().GetResult()
  }
  $outputStream.Flush()
} finally {
  if ($null -ne $client) { $client.Dispose() }
}
`;

export interface TunnelBridgeEndpoint {
  readonly tunnelId: string;
  readonly host: string;
  readonly port: number;
  readonly bridged: boolean;
}

export interface TunnelBridgeManagerOptions {
  readonly isWsl?: boolean;
  readonly spawn?: PowerShellSpawn;
  readonly executable?: string;
  readonly createServer?: typeof nodeCreateServer;
  readonly maxConnections?: number;
  readonly closeTimeoutMs?: number;
  readonly maxStderrBytes?: number;
  readonly probe?: () => void | Promise<void>;
}

interface RelayConnection {
  readonly socket: Socket;
  readonly child: PowerShellChild;
  readonly closed: Promise<void>;
  close(): void;
}

function loopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (normalized.startsWith("::ffff:"))
    return loopbackHost(normalized.slice(7));
  if (isIP(normalized) === 4) return normalized.split(".")[0] === "127";
  return false;
}

function portPrefix(port: number): Buffer {
  const result = Buffer.allocUnsafe(4);
  result.writeUInt32BE(port, 0);
  return result;
}

async function boundedWait<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(label)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function closeServerQuietly(server: Server): void {
  try {
    server.close();
  } catch {
    /* It may not be listening yet. */
  }
}

function waitForServerClose(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function waitForConnections(
  connections: readonly RelayConnection[],
): Promise<void> {
  await Promise.allSettled(connections.map((connection) => connection.closed));
}

async function waitForBridgeStop(
  stopped: Promise<void>,
  connections: readonly RelayConnection[],
): Promise<void> {
  await Promise.all([stopped, waitForConnections(connections)]);
}

function closeConnections(connections: Iterable<RelayConnection>): void {
  for (const connection of connections) connection.close();
}

async function closeBridgeQuietly(bridge: TunnelBridge): Promise<void> {
  try {
    await bridge.close();
  } catch {
    // Server error cleanup must not create an unhandled rejection.
  }
}

function listeningPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("WSL tunnel bridge returned an invalid address");
  }
  return address.port;
}

async function listenForBridge(
  server: Server,
  signal: AbortSignal | undefined,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
      server.removeListener("error", onError);
    };
    const onAbort = (): void => {
      cleanup();
      closeServerQuietly(server);
      reject(abortError(signal?.reason));
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("Could not create the WSL tunnel bridge"));
    };
    const onListening = (): void => {
      cleanup();
      if (signal?.aborted) {
        closeServerQuietly(server);
        reject(abortError(signal.reason));
        return;
      }
      try {
        resolve(listeningPort(server));
      } catch (error) {
        closeServerQuietly(server);
        reject(error);
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, onListening);
  });
}

function spawnRelayChild(
  options: Pick<TunnelBridgeManagerOptions, "spawn" | "executable">,
): PowerShellChild | undefined {
  try {
    return spawnPowerShellScript(WINDOWS_TUNNEL_RELAY_SCRIPT, {
      ...(options.spawn ? { spawn: options.spawn } : {}),
      ...(options.executable ? { executable: options.executable } : {}),
    });
  } catch {
    return undefined;
  }
}

class RelayConnectionController implements RelayConnection {
  readonly closed: Promise<void>;
  private readonly stderr: BoundedTextCollector;
  private resolveClosed!: () => void;
  private childClosed = false;
  private socketClosed = false;
  private closedState = false;
  private forceKillTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly socket: Socket,
    readonly child: PowerShellChild,
    private readonly remotePort: number,
    private readonly options: Pick<
      TunnelBridgeManagerOptions,
      "closeTimeoutMs" | "maxStderrBytes"
    >,
    private readonly onClosed: (connection: RelayConnection) => void,
  ) {
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    this.stderr = new BoundedTextCollector(options.maxStderrBytes);
  }

  start(): void {
    this.attachEvents();
    this.pipeRelayStreams();
    this.writeRelayPrefix();
  }

  close(): void {
    this.socket.destroy();
    try {
      this.child.stdin.end();
    } catch {
      /* Already closed. */
    }
    terminatePowerShell(this.child);
    this.scheduleForceKill();
  }

  private attachEvents(): void {
    this.child.stdin.on("error", () => this.fail());
    this.child.stdout.on("error", () => this.fail());
    this.child.stderr.on("error", () => this.fail());
    this.socket.on("error", () => this.fail());
    this.child.stderr.on("data", (chunk: Buffer | string) =>
      this.handleStderr(chunk),
    );
    this.child.once("error", () => this.fail());
    this.child.once("close", () => this.handleChildClose());
    this.socket.once("close", () => this.handleSocketClose());
  }

  private handleStderr(chunk: Buffer | string): void {
    try {
      this.stderr.push(chunk);
    } catch {
      this.fail();
    }
  }

  private handleChildClose(): void {
    this.childClosed = true;
    try {
      this.stderr.finish();
    } catch {
      /* The relay is already being closed. */
    }
    if (!this.socket.destroyed) this.socket.end(() => this.socket.destroy());
    this.finish();
  }

  private handleSocketClose(): void {
    this.socketClosed = true;
    terminatePowerShell(this.child);
    if (!this.childClosed) this.scheduleForceKill();
    this.finish();
  }

  private pipeRelayStreams(): void {
    this.child.stdout.pipe(this.socket, { end: false });
    this.child.stdout.once("end", () => {
      if (!this.socket.destroyed) this.socket.end();
    });
  }

  private writeRelayPrefix(): void {
    try {
      this.child.stdin.write(portPrefix(this.remotePort));
      this.socket.pipe(this.child.stdin);
    } catch {
      this.fail();
    }
  }

  private fail(): void {
    this.socket.destroy();
    terminatePowerShell(this.child);
  }

  private scheduleForceKill(): void {
    this.forceKillTimer ??= setTimeout(() => {
      try {
        this.child.kill("SIGKILL");
      } catch {
        /* It may already have exited. */
      }
    }, this.options.closeTimeoutMs);
    this.forceKillTimer.unref();
  }

  private finish(): void {
    if (this.closedState || !this.childClosed || !this.socketClosed) return;
    this.closedState = true;
    if (this.forceKillTimer) clearTimeout(this.forceKillTimer);
    this.onClosed(this);
    this.resolveClosed();
  }
}

class TunnelBridge {
  private readonly connections = new Set<RelayConnection>();
  private closing = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    readonly tunnelId: string,
    readonly remotePort: number,
    readonly server: Server,
    readonly localPort: number,
    private readonly options: Required<
      Pick<
        TunnelBridgeManagerOptions,
        "maxConnections" | "closeTimeoutMs" | "maxStderrBytes"
      >
    > &
      Pick<TunnelBridgeManagerOptions, "spawn" | "executable">,
  ) {}

  accept(socket: Socket): void {
    if (this.rejectSocket(socket)) return;
    const child = spawnRelayChild(this.options);
    if (!child) {
      socket.destroy();
      return;
    }
    let connection!: RelayConnectionController;
    connection = new RelayConnectionController(
      socket,
      child,
      this.remotePort,
      this.options,
      (closedConnection) => this.connections.delete(closedConnection),
    );
    this.connections.add(connection);
    connection.start();
  }

  private rejectSocket(socket: Socket): boolean {
    if (this.closing || this.connections.size >= this.options.maxConnections) {
      socket.destroy();
      return true;
    }
    socket.setNoDelay(true);
    socket.allowHalfOpen = true;
    return false;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    const stopped = waitForServerClose(this.server);
    const current = [...this.connections];
    closeConnections(current);
    try {
      await boundedWait(
        waitForBridgeStop(stopped, current),
        this.options.closeTimeoutMs,
        "Tunnel bridge close",
      );
    } catch (error) {
      closeConnections(this.connections);
      throw error;
    }
  }
}

export class TunnelBridgeManager {
  private readonly bridges = new Map<string, TunnelBridge>();
  private readonly pending = new Map<string, Promise<TunnelBridgeEndpoint>>();
  private readonly isWsl: boolean;
  private readonly options: TunnelBridgeManagerOptions;
  private capability: Promise<void> | undefined;
  private closed = false;
  private resetPromise: Promise<void> | undefined;
  private closeAllPromise: Promise<void> | undefined;

  constructor(options: TunnelBridgeManagerOptions = {}) {
    this.options = options;
    this.isWsl = options.isWsl ?? false;
  }

  get size(): number {
    return this.bridges.size;
  }

  async open(
    tunnelId: string,
    host: string,
    port: number,
    signal?: AbortSignal,
  ): Promise<TunnelBridgeEndpoint> {
    const reset = this.resetPromise;
    if (reset) await reset;
    const id = tunnelId.trim();
    if (this.closed) throw new Error("Tunnel bridge manager is closed");
    if (!id || id.length > 512)
      throw new Error("HexHub tunnel result has an invalid tunnel_id");
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("HexHub tunnel result has an invalid local port");
    if (!this.isWsl || !loopbackHost(host))
      return { tunnelId: id, host, port, bridged: false };
    if (signal?.aborted) throw abortError(signal.reason);

    const existing = this.bridges.get(id);
    if (existing) {
      if (existing.remotePort !== port)
        throw new Error("HexHub reused a tunnel_id for a different endpoint");
      return {
        tunnelId: id,
        host: "127.0.0.1",
        port: existing.localPort,
        bridged: true,
      };
    }
    const inFlight = this.pending.get(id);
    if (inFlight) return inFlight;

    const created = this.createBridgeAfterCapability(id, port, signal);
    this.pending.set(id, created);
    try {
      return await created;
    } finally {
      this.pending.delete(id);
    }
  }

  async close(tunnelId: string): Promise<void> {
    const id = tunnelId.trim();
    if (!id) return;
    const pending = this.pending.get(id);
    if (pending) {
      try {
        await pending;
      } catch {
        return;
      }
    }
    const bridge = this.bridges.get(id);
    if (!bridge) return;
    this.bridges.delete(id);
    await bridge.close();
  }

  reset(): Promise<void> {
    if (this.closed) return this.closeAllPromise ?? Promise.resolve();
    if (this.resetPromise) return this.resetPromise;
    const reset = this.resetInternal();
    this.resetPromise = reset;
    void reset
      .finally(() => {
        if (this.resetPromise === reset) this.resetPromise = undefined;
      })
      .catch(() => undefined);
    return reset;
  }

  closeAll(): Promise<void> {
    if (this.closeAllPromise) return this.closeAllPromise;
    this.closed = true;
    this.closeAllPromise = (async () => {
      const reset = this.resetPromise;
      const resetResult = reset ? await Promise.allSettled([reset]) : [];
      await Promise.allSettled([...this.pending.values()]);
      const bridges = [...this.bridges.values()];
      this.bridges.clear();
      const results = await Promise.allSettled(
        bridges.map((bridge) => bridge.close()),
      );
      const failure = [...resetResult, ...results].find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failure) throw failure.reason;
    })();
    return this.closeAllPromise;
  }

  private async resetInternal(): Promise<void> {
    await Promise.allSettled([...this.pending.values()]);
    const bridges = [...this.bridges.values()];
    this.bridges.clear();
    const results = await Promise.allSettled(
      bridges.map((bridge) => bridge.close()),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
  }

  private checkCapability(): Promise<void> {
    if (!this.capability) this.capability = this.runCapabilityCheck();
    return this.capability;
  }

  private async runCapabilityCheck(): Promise<void> {
    try {
      if (this.options.probe) {
        await this.options.probe();
        return;
      }
      await probePowerShell({
        ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
        ...(this.options.executable
          ? { executable: this.options.executable }
          : {}),
      });
    } catch {
      this.capability = undefined;
      throw new Error("Windows tunnel relay helper is unavailable");
    }
  }

  private async createBridgeAfterCapability(
    tunnelId: string,
    remotePort: number,
    signal?: AbortSignal,
  ): Promise<TunnelBridgeEndpoint> {
    await this.checkCapability();
    if (this.closed) throw new Error("Tunnel bridge manager is closed");
    return this.createBridge(tunnelId, remotePort, signal);
  }

  private async createBridge(
    tunnelId: string,
    remotePort: number,
    signal?: AbortSignal,
  ): Promise<TunnelBridgeEndpoint> {
    const createServer = this.options.createServer ?? nodeCreateServer;
    const server = createServer({ allowHalfOpen: true, pauseOnConnect: false });
    let bridge: TunnelBridge | undefined;
    try {
      const localPort = await listenForBridge(server, signal);
      bridge = new TunnelBridge(tunnelId, remotePort, server, localPort, {
        maxConnections:
          this.options.maxConnections ?? DEFAULT_TUNNEL_MAX_CONNECTIONS,
        closeTimeoutMs:
          this.options.closeTimeoutMs ?? DEFAULT_TUNNEL_CLOSE_TIMEOUT_MS,
        maxStderrBytes: this.options.maxStderrBytes ?? 64 * 1024,
        ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
        ...(this.options.executable
          ? { executable: this.options.executable }
          : {}),
      });
      attachBridgeServer(server, bridge);
      this.bridges.set(tunnelId, bridge);
      return { tunnelId, host: "127.0.0.1", port: localPort, bridged: true };
    } catch (error) {
      closeServerQuietly(server);
      if (bridge) await closeBridgeQuietly(bridge);
      throw error;
    }
  }
}

function attachBridgeServer(server: Server, bridge: TunnelBridge): void {
  server.on("connection", (socket) => bridge.accept(socket));
  server.on("error", () => {
    void closeBridgeQuietly(bridge);
  });
  server.unref();
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function findTunnelRecord(
  value: unknown,
  depth = 0,
): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record || depth > 4) return undefined;
  const hasId = "tunnel_id" in record || "tunnelId" in record;
  const hasHost =
    "local_host" in record || "localHost" in record || "host" in record;
  const hasPort =
    "local_port" in record || "localPort" in record || "port" in record;
  if (hasId && hasHost && hasPort) return record;
  for (const child of Object.values(record)) {
    const found = findTunnelRecord(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function parseTextJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first)
    candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      /* Try the next candidate. */
    }
  }
  return undefined;
}

function findStructuredTunnelRecord(
  result: HexHubCallResult,
): Record<string, unknown> | undefined {
  return result.structuredContent === undefined
    ? undefined
    : findTunnelRecord(result.structuredContent);
}

function findTextTunnelRecord(
  result: HexHubCallResult,
): Record<string, unknown> | undefined {
  for (const block of result.content ?? []) {
    if (block.type !== "text" || typeof block.text !== "string") continue;
    const record = findTunnelRecord(parseTextJson(block.text));
    if (record) return record;
  }
  return undefined;
}

function findTunnelRecordInResult(
  result: HexHubCallResult,
): Record<string, unknown> | undefined {
  return findStructuredTunnelRecord(result) ?? findTextTunnelRecord(result);
}

function aliasValue(
  record: Record<string, unknown>,
  aliases: readonly string[],
): unknown {
  for (const alias of aliases) {
    const value = record[alias];
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}

function validateTunnelId(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("HexHub tunnel result has an invalid tunnel_id");
  return value.trim();
}

function validateTunnelHost(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("HexHub tunnel result has an invalid local host");
  return value.trim();
}

function validateTunnelPort(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65535
  ) {
    throw new Error("HexHub tunnel result has an invalid local port");
  }
  return value;
}

function parseTunnelEndpoint(
  record: Record<string, unknown>,
): ParsedTunnelResult {
  return {
    tunnelId: validateTunnelId(aliasValue(record, ["tunnel_id", "tunnelId"])),
    host: validateTunnelHost(
      aliasValue(record, ["local_host", "localHost", "host"]),
    ),
    port: validateTunnelPort(
      aliasValue(record, ["local_port", "localPort", "port"]),
    ),
  };
}

export interface ParsedTunnelResult {
  readonly tunnelId: string;
  readonly host: string;
  readonly port: number;
}

export function parseTunnelOpenResult(
  result: HexHubCallResult,
): ParsedTunnelResult {
  const record = findTunnelRecordInResult(result);
  if (!record)
    throw new Error(
      "HexHub tunnel open result did not include a usable endpoint",
    );
  return parseTunnelEndpoint(record);
}

function closeTunnelId(
  args: Readonly<Record<string, unknown>>,
): string | undefined {
  const value = args.tunnel_id ?? args.tunnelId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function createTunnelResultHook(
  manager: TunnelBridgeManager,
): HexHubTunnelResultHook {
  return async ({ remoteTool, result, remoteArgs, signal }) => {
    if (remoteTool === "close_ssh_tunnel") {
      const tunnelId = closeTunnelId(remoteArgs);
      if (tunnelId) await manager.close(tunnelId);
      return result;
    }
    if (result.isError === true) return result;
    const parsed = parseTunnelOpenResult(result);
    const endpoint = await manager.open(
      parsed.tunnelId,
      parsed.host,
      parsed.port,
      signal,
    );
    const safe = {
      tunnel_id: endpoint.tunnelId,
      host: endpoint.host,
      port: endpoint.port,
      local_host: endpoint.host,
      local_port: endpoint.port,
    };
    return {
      structuredContent: safe,
      content: [{ type: "text", text: JSON.stringify(safe) }],
    };
  };
}
