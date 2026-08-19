import type { HexHubLocalPathContext } from "./input-adapters.js";
import {
  abortError,
  BoundedTextCollector,
  spawnPowerShellScript,
  terminatePowerShell,
  timeoutError,
  type PowerShellChild,
  type PowerShellSpawn,
} from "./powershell.js";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 128;
const MAX_ERROR_BYTES = 4 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

const WINDOWS_SCP_PATH_PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$raw = [Console]::In.ReadToEnd()
if ([Text.Encoding]::UTF8.GetByteCount($raw) -gt 65536) { exit 10 }
$request = $raw | ConvertFrom-Json
$path = [string]$request.path
$direction = [string]$request.direction
if ($direction -eq 'upload') {
  if ([IO.File]::Exists($path)) { [Console]::Out.Write('file'); exit 0 }
  if ([IO.Directory]::Exists($path)) { [Console]::Out.Write('directory'); exit 0 }
  exit 3
}
if ($direction -eq 'download') {
  if ([IO.Directory]::Exists($path)) { [Console]::Out.Write('destination'); exit 0 }
  $parent = [IO.Path]::GetDirectoryName($path)
  if ($parent -and [IO.Directory]::Exists($parent)) {
    [Console]::Out.Write('destination')
    exit 0
  }
  exit 4
}
exit 5
`;

export type HexHubWindowsScpPathProbe = (
  path: string,
  context: HexHubLocalPathContext,
) => Promise<void>;

export interface WindowsScpPathProbeOptions {
  readonly spawn?: PowerShellSpawn;
  readonly executable?: string;
  readonly timeoutMs?: number;
}

function exitError(code: number | null): Error {
  if (code === 3)
    return new Error("HexHub SCP upload source is not accessible from Windows");
  if (code === 4)
    return new Error(
      "HexHub SCP download destination parent is not accessible from Windows",
    );
  return new Error(
    `HexHub SCP Windows path check failed${code === null ? "" : ` (exit ${code})`}`,
  );
}

function validProbeOutput(value: string): boolean {
  return value === "file" || value === "directory" || value === "destination";
}

class WindowsScpPathProbeSession {
  private readonly stdout = new BoundedTextCollector(MAX_OUTPUT_BYTES);
  private readonly stderr = new BoundedTextCollector(MAX_ERROR_BYTES);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private resolve: (() => void) | undefined;
  private reject: ((error: Error) => void) | undefined;
  private settled = false;

  constructor(
    private readonly child: PowerShellChild,
    private readonly context: HexHubLocalPathContext,
    private readonly timeoutMs: number,
  ) {}

  run(request: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.timer = setTimeout(
        () => this.fail(timeoutError("HexHub SCP Windows path check")),
        this.timeoutMs,
      );
      this.context.signal?.addEventListener("abort", this.onAbort, {
        once: true,
      });
      this.child.stdout.on("data", this.onStdout);
      this.child.stderr.on("data", this.onStderr);
      this.child.stdin.once("error", this.onInputError);
      this.child.once("error", this.onChildError);
      this.child.once("close", this.onClose);
      this.child.stdin.end(request);
    });
  }

  private readonly onAbort = (): void =>
    this.fail(abortError(this.context.signal?.reason));

  private readonly onStdout = (chunk: Buffer | string): void => {
    try {
      this.stdout.push(chunk);
    } catch {
      this.fail(
        new Error("HexHub SCP Windows path check returned invalid output"),
      );
    }
  };

  private readonly onStderr = (chunk: Buffer | string): void => {
    try {
      this.stderr.push(chunk);
    } catch {
      this.fail(
        new Error(
          "HexHub SCP Windows path check produced excessive error output",
        ),
      );
    }
  };

  private readonly onInputError = (): void =>
    this.fail(new Error("HexHub SCP Windows path check input failed"));

  private readonly onChildError = (): void =>
    this.finish(new Error("PowerShell helper is unavailable"));

  private readonly onClose = (code: number | null): void => {
    if (this.settled) return;
    let output: string;
    try {
      output = this.stdout.finish();
      this.stderr.finish();
    } catch {
      this.finish(
        new Error("HexHub SCP Windows path check returned invalid output"),
      );
      return;
    }
    this.finish(
      code === 0 && validProbeOutput(output) ? undefined : exitError(code),
    );
  };

  private fail(error: Error): void {
    terminatePowerShell(this.child);
    this.finish(error);
  }

  private finish(error?: Error): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timer) clearTimeout(this.timer);
    this.context.signal?.removeEventListener("abort", this.onAbort);
    if (error) this.reject?.(error);
    else this.resolve?.();
  }
}

async function probeWindowsScpPath(
  path: string,
  context: HexHubLocalPathContext,
  options: WindowsScpPathProbeOptions,
): Promise<void> {
  if (context.signal?.aborted) throw abortError(context.signal.reason);
  const request = JSON.stringify({ path, direction: context.direction });
  if (Buffer.byteLength(request) > MAX_REQUEST_BYTES)
    throw new Error("HexHub SCP local path exceeds its size limit");
  const spawnOptions = options.spawn ? { spawn: options.spawn } : {};
  const executableOptions = options.executable
    ? { executable: options.executable }
    : {};
  const child = spawnPowerShellScript(WINDOWS_SCP_PATH_PROBE_SCRIPT, {
    ...spawnOptions,
    ...executableOptions,
  });
  const session = new WindowsScpPathProbeSession(
    child,
    context,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  await session.run(request);
}

export function createWindowsScpPathProbe(
  options: WindowsScpPathProbeOptions = {},
): HexHubWindowsScpPathProbe {
  return (path, context) => probeWindowsScpPath(path, context, options);
}
