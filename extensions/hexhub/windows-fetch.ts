import type { FetchLike } from "./mcp-client.js";
import {
  BoundedTextCollector,
  PowerShellLineDecoder,
  abortError,
  spawnPowerShellScript,
  terminatePowerShell,
  timeoutError,
  type PowerShellChild,
  type PowerShellSpawn,
} from "./powershell.js";

export const DEFAULT_WINDOWS_FETCH_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_METADATA_BYTES = 128 * 1024;
export const DEFAULT_MAX_ERROR_BYTES = 16 * 1024;

export interface WindowsFetchOptions {
  readonly spawn?: PowerShellSpawn;
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxMetadataBytes?: number;
  readonly maxErrorBytes?: number;
  readonly maxStderrBytes?: number;
}

interface WindowsRequestPayload {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

interface WindowsResponseMetadata {
  status: number;
  statusText: string;
  headers: Array<[string, string[]]>;
}

export const WINDOWS_HTTP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Net.Http
$utf8 = [System.Text.UTF8Encoding]::new($false)

function Write-ProtocolJson([string] $kind, $value) {
  $json = ConvertTo-Json -InputObject $value -Compress -Depth 8
  $encoded = [Convert]::ToBase64String($utf8.GetBytes($json))
  [Console]::Out.WriteLine($kind + ' ' + $encoded)
  [Console]::Out.Flush()
}

$handler = $null
$client = $null
$request = $null
$response = $null
$stream = $null
try {
  $payloadText = [Console]::In.ReadToEnd()
  $payload = ConvertFrom-Json -InputObject $payloadText
  $handler = [System.Net.Http.HttpClientHandler]::new()
  $handler.UseProxy = $false
  $handler.AllowAutoRedirect = $true
  $client = [System.Net.Http.HttpClient]::new($handler, $true)
  $request = [System.Net.Http.HttpRequestMessage]::new(
    [System.Net.Http.HttpMethod]::new([string] $payload.method),
    [Uri]::new([string] $payload.url)
  )

  if ($null -ne $payload.body) {
    $bodyBytes = [Convert]::FromBase64String([string] $payload.body)
    $request.Content = [System.Net.Http.ByteArrayContent]::new($bodyBytes)
  }
  foreach ($property in $payload.headers.PSObject.Properties) {
    $name = [string] $property.Name
    $value = [string] $property.Value
    if (-not $request.Headers.TryAddWithoutValidation($name, $value)) {
      if ($null -eq $request.Content) {
        $request.Content = [System.Net.Http.ByteArrayContent]::new([byte[]]::new(0))
      }
      [void] $request.Content.Headers.TryAddWithoutValidation($name, $value)
    }
  }

  $response = $client.SendAsync(
    $request,
    [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead
  ).GetAwaiter().GetResult()

  $headerRows = [System.Collections.Generic.List[object]]::new()
  foreach ($header in $response.Headers) {
    $headerRows.Add(@([string] $header.Key, @($header.Value | ForEach-Object { [string] $_ })))
  }
  if ($null -ne $response.Content) {
    foreach ($header in $response.Content.Headers) {
      $headerRows.Add(@([string] $header.Key, @($header.Value | ForEach-Object { [string] $_ })))
    }
  }
  Write-ProtocolJson 'M' @{
    status = [int] $response.StatusCode
    statusText = [string] $response.ReasonPhrase
    headers = $headerRows
  }

  if ($null -ne $response.Content) {
    $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $buffer = [byte[]]::new(32768)
    while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $encoded = [Convert]::ToBase64String($buffer, 0, $count)
      [Console]::Out.WriteLine('D ' + $encoded)
      [Console]::Out.Flush()
    }
  }
  [Console]::Out.WriteLine('X')
  [Console]::Out.Flush()
} catch {
  Write-ProtocolJson 'E' @{ code = 'request_failed'; message = 'Windows HTTP helper failed' }
  exit 1
} finally {
  if ($null -ne $stream) { $stream.Dispose() }
  if ($null -ne $response) { $response.Dispose() }
  if ($null -ne $request) { $request.Dispose() }
  if ($null -ne $client) { $client.Dispose() }
  elseif ($null -ne $handler) { $handler.Dispose() }
}
`;

function decodeBase64(value: string, label: string, maxBytes: number): Buffer {
  if (value.length === 0) return Buffer.alloc(0);
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error(`PowerShell protocol contained invalid ${label} base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength > maxBytes)
    throw new Error(`PowerShell ${label} exceeded its size limit`);
  return decoded;
}

function invalidMetadata(): never {
  throw new Error("PowerShell protocol returned invalid response metadata");
}

function parseMetadataJson(bytes: Buffer): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return invalidMetadata();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return invalidMetadata();
  return value as Record<string, unknown>;
}

function parseMetadataStatus(value: unknown): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 100 ||
    (value as number) > 599
  ) {
    throw new Error("PowerShell protocol returned an invalid HTTP status");
  }
  return value as number;
}

function parseMetadataStatusText(value: unknown): string {
  if (typeof value !== "string" || value.length > 1024) {
    throw new Error("PowerShell protocol returned an invalid HTTP status text");
  }
  return value;
}

function parseMetadataHeader(row: unknown): [string, string[]] {
  if (
    !Array.isArray(row) ||
    row.length !== 2 ||
    typeof row[0] !== "string" ||
    !Array.isArray(row[1])
  ) {
    throw new Error("PowerShell protocol returned invalid HTTP headers");
  }
  const name = row[0];
  const values = row[1];
  const valid =
    name.length <= 1024 &&
    values.every(
      (item) => typeof item === "string" && item.length <= 64 * 1024,
    );
  if (!valid)
    throw new Error("PowerShell protocol returned invalid HTTP headers");
  return [name, values as string[]];
}

function parseMetadataHeaders(value: unknown): Array<[string, string[]]> {
  if (!Array.isArray(value) || value.length > 1024) {
    throw new Error("PowerShell protocol returned invalid HTTP headers");
  }
  return value.map(parseMetadataHeader);
}

function parseMetadata(
  encoded: string,
  maxBytes: number,
): WindowsResponseMetadata {
  const metadata = parseMetadataJson(
    decodeBase64(encoded, "metadata", maxBytes),
  );
  return {
    status: parseMetadataStatus(metadata.status),
    statusText: parseMetadataStatusText(metadata.statusText),
    headers: parseMetadataHeaders(metadata.headers),
  };
}

function responseHeaders(rows: WindowsResponseMetadata["headers"]): Headers {
  const headers = new Headers();
  for (const [name, values] of rows) {
    for (const value of values) headers.append(name, value);
  }
  return headers;
}

function helperError(encoded: string, maxBytes: number): Error {
  const bytes = decodeBase64(encoded, "error", maxBytes);
  let code = "request_failed";
  try {
    const value = JSON.parse(bytes.toString("utf8")) as { code?: unknown };
    if (
      typeof value.code === "string" &&
      /^[a-z0-9_-]{1,40}$/i.test(value.code)
    )
      code = value.code;
  } catch {
    throw new Error("PowerShell protocol returned an invalid error frame");
  }
  return new Error(`Windows HTTP helper reported ${code}`);
}

type WindowsProtocolFrame =
  | { readonly kind: "metadata"; readonly encoded: string }
  | { readonly kind: "data"; readonly encoded: string }
  | { readonly kind: "error"; readonly encoded: string }
  | { readonly kind: "end" };

function parseProtocolFrame(line: string): WindowsProtocolFrame {
  if (line.startsWith("M "))
    return { kind: "metadata", encoded: line.slice(2) };
  if (line.startsWith("D ")) return { kind: "data", encoded: line.slice(2) };
  if (line.startsWith("E ")) return { kind: "error", encoded: line.slice(2) };
  if (line === "X") return { kind: "end" };
  throw new Error("PowerShell protocol returned an unknown frame");
}

class ResponseBodyController {
  readonly stream: ReadableStream<Uint8Array>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private cancelled = false;

  constructor(private readonly onCancel: () => void) {
    this.stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.cancelled = true;
        this.onCancel();
      },
    });
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  enqueue(chunk: Uint8Array): void {
    if (!this.cancelled) this.controller.enqueue(chunk);
  }

  close(): void {
    if (this.cancelled) return;
    this.controller.close();
  }

  error(error: Error): void {
    if (this.cancelled) return;
    try {
      this.controller.error(error);
    } catch {
      /* The body may already be closed. */
    }
  }
}

function protocolError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("PowerShell protocol failed");
}

function spawnRequestChild(
  options: WindowsFetchOptions,
): PowerShellChild | undefined {
  try {
    return spawnPowerShellScript(WINDOWS_HTTP_SCRIPT, {
      ...(options.spawn ? { spawn: options.spawn } : {}),
      ...(options.executable ? { executable: options.executable } : {}),
    });
  } catch {
    return undefined;
  }
}

class WindowsRequestSession {
  private readonly maxMetadataBytes: number;
  private readonly maxErrorBytes: number;
  private readonly maxStderrBytes: number;
  private readonly timeoutMs: number;
  private readonly stderr: BoundedTextCollector;
  private readonly responsePromise: Promise<Response>;
  private readonly body: ResponseBodyController;
  private child!: PowerShellChild;
  private decoder!: PowerShellLineDecoder;
  private timer!: NodeJS.Timeout;
  private onAbort!: () => void;
  private responseResolve!: (value: Response) => void;
  private responseReject!: (error: Error) => void;
  private responseSettled = false;
  private metadataSeen = false;
  private endSeen = false;
  private finished = false;
  private noBody = false;
  private pendingBodylessResponse: Response | undefined;

  constructor(
    private readonly payload: WindowsRequestPayload,
    private readonly signal: AbortSignal | undefined,
    private readonly options: WindowsFetchOptions,
  ) {
    this.maxMetadataBytes =
      options.maxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES;
    this.maxErrorBytes = options.maxErrorBytes ?? DEFAULT_MAX_ERROR_BYTES;
    this.maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_WINDOWS_FETCH_TIMEOUT_MS;
    this.stderr = new BoundedTextCollector(this.maxStderrBytes);
    this.body = new ResponseBodyController(() => this.cancelBody());
    this.responsePromise = new Promise<Response>((resolve, reject) => {
      this.responseResolve = resolve;
      this.responseReject = reject;
    });
  }

  start(): Promise<Response> {
    if (this.signal?.aborted)
      return Promise.reject(abortError(this.signal.reason));
    const child = spawnRequestChild(this.options);
    if (!child)
      return Promise.reject(
        new Error("Windows HTTP helper could not be started"),
      );
    this.child = child;
    this.decoder = new PowerShellLineDecoder((line) =>
      this.handleProtocolLine(line),
    );
    this.attachChildHandlers();
    this.startLifecycle();
    this.writePayload();
    return this.responsePromise;
  }

  private attachChildHandlers(): void {
    this.child.stdout.on("data", (chunk: Buffer | string) =>
      this.handleStdout(chunk),
    );
    this.child.stderr.on("data", (chunk: Buffer | string) =>
      this.handleStderr(chunk),
    );
    this.child.once("error", () =>
      this.fail(new Error("Windows HTTP helper process failed")),
    );
    this.child.once("close", (code) => this.handleClose(code));
    this.child.stdin.on("error", () =>
      this.fail(new Error("Windows HTTP helper input failed")),
    );
  }

  private startLifecycle(): void {
    this.onAbort = () => this.fail(abortError(this.signal?.reason));
    this.timer = setTimeout(
      () => this.fail(timeoutError("Windows HTTP request")),
      this.timeoutMs,
    );
    this.signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  private writePayload(): void {
    try {
      this.child.stdin.end(JSON.stringify(this.payload), "utf8");
    } catch {
      this.fail(new Error("Windows HTTP helper input failed"));
    }
  }

  private handleStdout(chunk: Buffer | string): void {
    try {
      this.decoder.push(chunk);
    } catch (error) {
      this.fail(protocolError(error));
    }
  }

  private handleStderr(chunk: Buffer | string): void {
    try {
      this.stderr.push(chunk);
    } catch {
      this.fail(
        new Error("Windows HTTP helper produced excessive error output"),
      );
    }
  }

  private handleProtocolLine(line: string): void {
    if (this.finished) return;
    try {
      this.handleFrame(parseProtocolFrame(line));
    } catch (error) {
      this.fail(protocolError(error));
    }
  }

  private handleFrame(frame: WindowsProtocolFrame): void {
    switch (frame.kind) {
      case "metadata":
        this.handleMetadataFrame(frame.encoded);
        return;
      case "data":
        this.handleDataFrame(frame.encoded);
        return;
      case "error":
        throw helperError(frame.encoded, this.maxErrorBytes);
      case "end":
        this.handleEndFrame();
        return;
    }
  }

  private handleMetadataFrame(encoded: string): void {
    if (this.metadataSeen || this.endSeen) {
      throw new Error(
        "PowerShell protocol returned duplicate response metadata",
      );
    }
    const metadata = parseMetadata(encoded, this.maxMetadataBytes);
    this.metadataSeen = true;
    this.noBody = this.isBodylessResponse(metadata.status);
    const response = new Response(this.noBody ? null : this.body.stream, {
      status: metadata.status,
      statusText: metadata.statusText,
      headers: responseHeaders(metadata.headers),
    });
    this.publishResponse(response);
  }

  private isBodylessResponse(status: number): boolean {
    return (
      this.payload.method === "HEAD" ||
      status === 204 ||
      status === 205 ||
      status === 304
    );
  }

  private publishResponse(response: Response): void {
    if (this.noBody) {
      this.pendingBodylessResponse = response;
      return;
    }
    this.responseSettled = true;
    this.responseResolve(response);
  }

  private handleDataFrame(encoded: string): void {
    if (!this.metadataSeen || this.endSeen) {
      throw new Error("PowerShell protocol returned a body chunk out of order");
    }
    const chunk = decodeBase64(encoded, "body chunk", 64 * 1024);
    if (this.noBody && chunk.length > 0) {
      throw new Error(
        "PowerShell protocol returned a body for a bodyless response",
      );
    }
    if (!this.noBody && chunk.length > 0) this.body.enqueue(chunk);
  }

  private handleEndFrame(): void {
    if (!this.metadataSeen || this.endSeen) {
      throw new Error("PowerShell protocol returned an invalid end frame");
    }
    this.endSeen = true;
  }

  private handleClose(code: number | null): void {
    if (this.finished) return;
    try {
      this.decoder.finish();
      this.stderr.finish();
    } catch (error) {
      this.fail(protocolError(error));
      return;
    }
    if (this.finished) return;
    if (code !== 0 || !this.metadataSeen || !this.endSeen) {
      this.fail(this.incompleteResponseError(code));
      return;
    }
    this.complete();
  }

  private incompleteResponseError(code: number | null): Error {
    const suffix = code === null ? "" : ` (exit ${code})`;
    return new Error(
      `Windows HTTP helper exited before completing the response${suffix}`,
    );
  }

  private complete(): void {
    this.finished = true;
    this.clearLifecycle();
    if (this.noBody) {
      this.responseSettled = true;
      this.responseResolve(this.pendingBodylessResponse!);
      return;
    }
    this.body.close();
  }

  private cancelBody(): void {
    terminatePowerShell(this.child);
  }

  private fail(error: Error): void {
    if (this.finished) return;
    this.finished = true;
    this.clearLifecycle();
    terminatePowerShell(this.child);
    if (!this.responseSettled) {
      this.responseSettled = true;
      this.responseReject(error);
      return;
    }
    if (!this.body.isCancelled) this.body.error(error);
  }

  private clearLifecycle(): void {
    clearTimeout(this.timer);
    this.signal?.removeEventListener("abort", this.onAbort);
  }
}

async function requestPayload(
  url: string | URL,
  init: RequestInit | undefined,
  maxRequestBytes: number,
): Promise<{
  payload: WindowsRequestPayload;
  signal: AbortSignal | undefined;
}> {
  const request = new Request(url, init);
  const signal = init?.signal ?? request.signal;
  if (signal?.aborted) throw abortError(signal.reason);
  const bytes =
    request.body === null ? null : Buffer.from(await request.arrayBuffer());
  if (signal?.aborted) throw abortError(signal.reason);
  if (bytes && bytes.byteLength > maxRequestBytes)
    throw new Error("Windows HTTP request body exceeded its size limit");
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return {
    payload: {
      method: request.method,
      url: request.url,
      headers,
      body: bytes?.toString("base64") ?? null,
    },
    signal,
  };
}

function startWindowsRequest(
  payload: WindowsRequestPayload,
  signal: AbortSignal | undefined,
  options: WindowsFetchOptions,
): Promise<Response> {
  return new WindowsRequestSession(payload, signal, options).start();
}

export function createWindowsFetch(
  options: WindowsFetchOptions = {},
): FetchLike {
  return async (url, init) => {
    const serialized = await requestPayload(
      url,
      init,
      options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
    );
    return startWindowsRequest(serialized.payload, serialized.signal, options);
  };
}
