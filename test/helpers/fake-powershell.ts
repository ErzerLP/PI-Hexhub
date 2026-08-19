import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type {
  PowerShellChild,
  PowerShellSpawn,
} from "../../extensions/hexhub/powershell.js";

export class FakePowerShellChild
  extends EventEmitter
  implements PowerShellChild
{
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  closeCode: number | null | undefined;

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.killed) return false;
    this.killed = true;
    this.stdin.destroy();
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() =>
      this.close(null, typeof signal === "string" ? signal : null),
    );
    return true;
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.closeCode !== undefined) return;
    this.closeCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}

export interface FakeSpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: unknown;
  readonly child: FakePowerShellChild;
}

export function createFakePowerShellSpawn(
  setup?: (
    child: FakePowerShellChild,
    call: Omit<FakeSpawnCall, "child">,
  ) => void,
): { spawn: PowerShellSpawn; calls: FakeSpawnCall[] } {
  const calls: FakeSpawnCall[] = [];
  const spawn = ((
    command: string,
    args: readonly string[],
    options: unknown,
  ) => {
    const child = new FakePowerShellChild();
    const call = { command, args, options, child };
    calls.push(call);
    setup?.(child, { command, args, options });
    return child;
  }) as PowerShellSpawn;
  return { spawn, calls };
}

export function protocolJson(kind: "M" | "E", value: unknown): string {
  return `${kind} ${Buffer.from(JSON.stringify(value), "utf8").toString("base64")}\n`;
}

export function protocolData(value: Buffer | string): string {
  return `D ${Buffer.from(value).toString("base64")}\n`;
}
