import assert from "node:assert/strict";
import test from "node:test";

import { createWindowsFetch } from "../extensions/hexhub/windows-fetch.js";
import {
  type FakePowerShellChild,
  createFakePowerShellSpawn,
  protocolData,
  protocolJson,
} from "./helpers/fake-powershell.js";

const metadata = (
  status = 200,
  statusText = "OK",
  headers: Array<[string, string[]]> = [],
) => protocolJson("M", { status, statusText, headers });

function collectInput(
  child: FakePowerShellChild,
  callback: (payload: any) => void,
): void {
  const chunks: Buffer[] = [];
  child.stdin.on("data", (chunk: Buffer | string) =>
    chunks.push(Buffer.from(chunk)),
  );
  child.stdin.once("finish", () =>
    callback(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
  );
}

async function finishStreamingResponse(
  child: FakePowerShellChild,
  gate: Promise<void>,
): Promise<void> {
  await gate;
  child.stdout.write(protocolData("event: message\ndata: second\n\n"));
  child.stdout.write("X\n");
  child.close(0);
}

function createStreamingFixture() {
  let payload: any;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = createFakePowerShellSpawn((child) => {
    collectInput(child, (value) => {
      payload = value;
      const first =
        metadata(200, "OK", [
          ["Content-Type", ["text/event-stream"]],
          ["X-Test", ["a", "b"]],
        ]) + protocolData("event: message\ndata: first\n\n");
      child.stdout.write(first.slice(0, 5));
      child.stdout.write(first.slice(5, 19));
      child.stdout.write(first.slice(19));
      void finishStreamingResponse(child, gate);
    });
  });
  return {
    fake,
    fetch: createWindowsFetch({ spawn: fake.spawn, timeoutMs: 2_000 }),
    release: () => release(),
    payload: () => payload,
  };
}

function assertSerializedRequest(
  payload: any,
  token: string,
  fake: ReturnType<typeof createFakePowerShellSpawn>,
): void {
  assert.equal(payload.method, "POST");
  assert.equal(payload.url, "http://127.0.0.1:17321/mcp?request=1");
  assert.equal(payload.headers.authorization, `Bearer ${token}`);
  assert.equal(
    Buffer.from(payload.body, "base64").toString(),
    JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }),
  );
  const argv = fake.calls[0]!.args.join(" ");
  assert.doesNotMatch(argv, /127\.0\.0\.1|Authorization|tools\/list/);
  assert.equal(argv.includes(token), false);
  assert.equal((fake.calls[0]!.options as { shell?: unknown }).shell, false);
}

async function testStreamingRequest(): Promise<void> {
  const token = "test-token-never-in-argv";
  const fixture = createStreamingFixture();
  const response = await fixture.fetch("http://127.0.0.1:17321/mcp?request=1", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.statusText, "OK");
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("x-test"), "a, b");
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.equal(
    Buffer.from(first.value!).toString(),
    "event: message\ndata: first\n\n",
  );
  fixture.release();
  const second = await reader.read();
  assert.equal(
    Buffer.from(second.value!).toString(),
    "event: message\ndata: second\n\n",
  );
  assert.equal((await reader.read()).done, true);
  assertSerializedRequest(fixture.payload(), token, fixture.fake);
}

async function waitForSpawn(
  fake: ReturnType<typeof createFakePowerShellSpawn>,
): Promise<void> {
  while (fake.calls.length === 0)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

test(
  "serializes method URL headers and body only through stdin and streams split SSE frames",
  testStreamingRequest,
);

test("supports DELETE/204 and preserves a non-2xx response body", async () => {
  const fake = createFakePowerShellSpawn((child) => {
    collectInput(child, (payload) => {
      if (payload.method === "DELETE") {
        child.stdout.write(
          metadata(204, "No Content", [["Mcp-Session-Id", ["gone"]]]),
        );
      } else {
        child.stdout.write(
          metadata(401, "Unauthorized", [["Content-Type", ["text/plain"]]]),
        );
        child.stdout.write(protocolData("denied body"));
      }
      child.stdout.write("X\n");
      child.close(0);
    });
  });
  const fetch = createWindowsFetch({ spawn: fake.spawn });
  const deleted = await fetch("http://127.0.0.1:17321/mcp", {
    method: "DELETE",
  });
  assert.equal(deleted.status, 204);
  assert.equal(deleted.body, null);
  assert.equal(await deleted.text(), "");

  const denied = await fetch("http://127.0.0.1:17321/mcp", { method: "GET" });
  assert.equal(denied.status, 401);
  assert.equal(denied.statusText, "Unauthorized");
  assert.equal(await denied.text(), "denied body");
});

test("abort before metadata rejects fetch and never exposes request secrets", async () => {
  const token = "abort-secret-token";
  const fake = createFakePowerShellSpawn();
  const fetch = createWindowsFetch({ spawn: fake.spawn, timeoutMs: 2_000 });
  const controller = new AbortController();
  const pending = fetch("http://127.0.0.1:17321/mcp", {
    method: "POST",
    headers: { "X-HexHub-MCP-Token": token },
    body: "{}",
    signal: controller.signal,
  });
  await waitForSpawn(fake);
  controller.abort(new DOMException("cancel request", "AbortError"));
  await assert.rejects(
    () => pending,
    (error: unknown) =>
      error instanceof Error &&
      error.name === "AbortError" &&
      !error.message.includes(token),
  );
  assert.equal(fake.calls[0]?.child.killed, true);
  assert.equal(fake.calls[0]?.args.join(" ").includes(token), false);
});

test("abort after metadata errors the streaming response body", async () => {
  const fake = createFakePowerShellSpawn((child) => {
    collectInput(child, () =>
      child.stdout.write(
        metadata(200, "OK", [["Content-Type", ["text/event-stream"]]]),
      ),
    );
  });
  const fetch = createWindowsFetch({ spawn: fake.spawn, timeoutMs: 2_000 });
  const controller = new AbortController();
  const response = await fetch("http://127.0.0.1:17321/mcp", {
    signal: controller.signal,
  });
  const reading = response.body!.getReader().read();
  controller.abort(new DOMException("stop SSE", "AbortError"));
  await assert.rejects(
    () => reading,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(fake.calls[0]?.child.killed, true);
});

async function testUnknownFrame(): Promise<void> {
  const fake = createFakePowerShellSpawn((child) =>
    collectInput(child, () => {
      child.stdout.write("BROKEN\n");
      child.close(0);
    }),
  );
  await assert.rejects(
    () => createWindowsFetch({ spawn: fake.spawn })("http://127.0.0.1/mcp"),
    /unknown frame/,
  );
}

async function testMetadataSize(): Promise<void> {
  const fake = createFakePowerShellSpawn((child) =>
    collectInput(child, () => {
      child.stdout.write(metadata());
      child.close(0);
    }),
  );
  await assert.rejects(
    () =>
      createWindowsFetch({ spawn: fake.spawn, maxMetadataBytes: 4 })(
        "http://127.0.0.1/mcp",
      ),
    /metadata exceeded/,
  );
}

async function testHelperErrorSanitization(): Promise<void> {
  const token = "must-not-leak-from-helper";
  const fake = createFakePowerShellSpawn((child) =>
    collectInput(child, () => {
      child.stdout.write(
        protocolJson("E", { code: "request_failed", message: token }),
      );
      child.close(1);
    }),
  );
  await assert.rejects(
    () => createWindowsFetch({ spawn: fake.spawn })("http://127.0.0.1/mcp"),
    (error: unknown) =>
      error instanceof Error &&
      /request_failed/.test(error.message) &&
      !error.message.includes(token),
  );
}

async function testStderrLimit(): Promise<void> {
  const fake = createFakePowerShellSpawn((child) =>
    collectInput(child, () => child.stderr.write("x".repeat(20))),
  );
  await assert.rejects(
    () =>
      createWindowsFetch({ spawn: fake.spawn, maxStderrBytes: 8 })(
        "http://127.0.0.1/mcp",
      ),
    /excessive error output/,
  );
}

async function testTimeout(): Promise<void> {
  const fake = createFakePowerShellSpawn();
  await assert.rejects(
    () =>
      createWindowsFetch({ spawn: fake.spawn, timeoutMs: 10 })(
        "http://127.0.0.1/mcp",
      ),
    (error: unknown) => error instanceof Error && error.name === "TimeoutError",
  );
}

test("bad protocol, metadata limits, helper errors, stderr limits, and timeout are bounded and sanitized", async (t) => {
  await t.test("unknown frame", testUnknownFrame);
  await t.test("metadata size", testMetadataSize);
  await t.test(
    "helper error ignores untrusted message",
    testHelperErrorSanitization,
  );
  await t.test("stderr size", testStderrLimit);
  await t.test("timeout", testTimeout);
});
