import assert from "node:assert/strict";
import test from "node:test";

import { createWindowsScpPathProbe } from "../extensions/hexhub/windows-path-probe.js";
import {
  type FakePowerShellChild,
  createFakePowerShellSpawn,
} from "./helpers/fake-powershell.js";

function collectRequest(
  child: FakePowerShellChild,
  callback: (value: { path: string; direction: "upload" | "download" }) => void,
): void {
  const chunks: Buffer[] = [];
  child.stdin.on("data", (chunk: Buffer | string) =>
    chunks.push(Buffer.from(chunk)),
  );
  child.stdin.once("finish", () =>
    callback(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
  );
}

test("Windows SCP preflight sends path only through stdin", async () => {
  const requests: Array<{ path: string; direction: string }> = [];
  const fake = createFakePowerShellSpawn((child) => {
    collectRequest(child, (request) => {
      requests.push(request);
      child.stdout.write(
        request.direction === "upload" ? "file" : "destination",
      );
      child.close(0);
    });
  });
  const probe = createWindowsScpPathProbe({ spawn: fake.spawn });
  const path = "D:\\private path\\file.txt";
  await probe(path, { cwd: "/work", direction: "upload" });
  await probe(path, { cwd: "/work", direction: "download" });

  assert.deepEqual(requests, [
    { path, direction: "upload" },
    { path, direction: "download" },
  ]);
  for (const call of fake.calls) {
    assert.equal(call.args.join(" ").includes(path), false);
    assert.equal((call.options as { shell?: unknown }).shell, false);
  }
});

test("Windows SCP preflight reports missing sources and destination parents", async () => {
  const fake = createFakePowerShellSpawn((child) => {
    collectRequest(child, (request) => {
      child.stderr.write("private diagnostic must stay hidden");
      child.close(request.direction === "upload" ? 3 : 4);
    });
  });
  const probe = createWindowsScpPathProbe({ spawn: fake.spawn });
  await assert.rejects(
    Promise.resolve(
      probe("D:\\missing.txt", { cwd: "/work", direction: "upload" }),
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message ===
        "HexHub SCP upload source is not accessible from Windows",
  );
  await assert.rejects(
    Promise.resolve(
      probe("D:\\missing\\download.txt", {
        cwd: "/work",
        direction: "download",
      }),
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message ===
        "HexHub SCP download destination parent is not accessible from Windows",
  );
});

test("Windows SCP preflight propagates cancellation and bounds output", async () => {
  const hanging = createFakePowerShellSpawn();
  const probe = createWindowsScpPathProbe({ spawn: hanging.spawn });
  const controller = new AbortController();
  const pending = Promise.resolve(
    probe("D:\\file.txt", {
      cwd: "/work",
      direction: "upload",
      signal: controller.signal,
    }),
  );
  controller.abort(new DOMException("cancel probe", "AbortError"));
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(hanging.calls[0]?.child.killed, true);

  const excessive = createFakePowerShellSpawn((child) => {
    collectRequest(child, () => {
      child.stdout.write("x".repeat(129));
      child.close(0);
    });
  });
  const excessiveProbe = createWindowsScpPathProbe({ spawn: excessive.spawn });
  await assert.rejects(
    Promise.resolve(
      excessiveProbe("D:\\file.txt", {
        cwd: "/work",
        direction: "upload",
      }),
    ),
    /invalid output/u,
  );
});
