import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { once } from "node:events";
import test from "node:test";

import {
  TunnelBridgeManager,
  createTunnelResultHook,
  parseTunnelOpenResult,
} from "../extensions/hexhub/tunnel-bridge.js";
import { createFakePowerShellSpawn } from "./helpers/fake-powershell.js";

function relaySpawn() {
  let observedPort: number | undefined;
  const fake = createFakePowerShellSpawn((child) => {
    let pending = Buffer.alloc(0);
    child.stdin.on("data", (chunk: Buffer | string) => {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      if (observedPort === undefined && pending.length >= 4) {
        observedPort = pending.readUInt32BE(0);
        pending = pending.subarray(4);
      }
      if (observedPort !== undefined && pending.length > 0) {
        child.stdout.write(pending);
        pending = Buffer.alloc(0);
      }
    });
    child.stdin.once("finish", () => child.close(0));
  });
  return {
    ...fake,
    get observedPort() {
      return observedPort;
    },
  };
}

async function connect(port: number) {
  const socket = createConnection({ host: "127.0.0.1", port });
  await once(socket, "connect");
  return socket;
}

test("parses structured tunnel results first and supports JSON text aliases", () => {
  assert.deepEqual(
    parseTunnelOpenResult({
      structuredContent: {
        tunnel: {
          tunnel_id: "structured",
          local_host: "127.0.0.1",
          local_port: 1234,
        },
      },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            tunnel_id: "text",
            host: "127.0.0.1",
            port: 9999,
          }),
        },
      ],
    }),
    { tunnelId: "structured", host: "127.0.0.1", port: 1234 },
  );

  assert.deepEqual(
    parseTunnelOpenResult({
      content: [
        {
          type: "text",
          text: `Tunnel opened: ${JSON.stringify({ tunnelId: "camel", localHost: "localhost", localPort: 4321 })}`,
        },
      ],
    }),
    { tunnelId: "camel", host: "localhost", port: 4321 },
  );
  assert.throws(
    () => parseTunnelOpenResult({ structuredContent: { ok: true } }),
    /usable endpoint/,
  );
  assert.throws(
    () =>
      parseTunnelOpenResult({
        structuredContent: { tunnel_id: "x", host: "localhost", port: 0 },
      }),
    /invalid local port/,
  );
});

test("non-WSL endpoints remain unchanged and do not start PowerShell", async () => {
  let probed = false;
  const manager = new TunnelBridgeManager({
    isWsl: false,
    probe: () => {
      probed = true;
    },
  });
  const endpoint = await manager.open("direct", "10.0.0.5", 8080);
  assert.deepEqual(endpoint, {
    tunnelId: "direct",
    host: "10.0.0.5",
    port: 8080,
    bridged: false,
  });
  assert.equal(probed, false);
  await manager.close("direct");
  await manager.closeAll();
});

test("WSL bridge rewrites results, forwards binary bytes, and keeps port out of argv/content", async (t) => {
  const relay = relaySpawn();
  const manager = new TunnelBridgeManager({
    isWsl: true,
    spawn: relay.spawn,
    probe: async () => undefined,
    closeTimeoutMs: 500,
  });
  t.after(() => manager.closeAll().catch(() => undefined));
  const hook = createTunnelResultHook(manager);
  const remotePort = 65_535;
  const remoteResult = {
    structuredContent: {
      tunnel_id: "tunnel-1",
      local_host: "127.0.0.1",
      local_port: remotePort,
    },
    content: [
      { type: "text", text: `Windows endpoint 127.0.0.1:${remotePort}` },
    ],
    details: { originalPort: remotePort },
  };
  const rewritten = await hook({
    remoteTool: "open_ssh_tunnel",
    result: remoteResult,
    remoteArgs: {},
  });
  const safe = rewritten.structuredContent as Record<string, unknown>;
  assert.equal(safe.tunnel_id, "tunnel-1");
  assert.equal(safe.host, "127.0.0.1");
  assert.equal(safe.local_host, "127.0.0.1");
  assert.equal(typeof safe.port, "number");
  assert.notEqual(safe.port, remotePort);
  assert.equal(JSON.stringify(rewritten).includes(String(remotePort)), false);
  assert.equal(manager.size, 1);

  const duplicate = await hook({
    remoteTool: "open_ssh_tunnel",
    result: remoteResult,
    remoteArgs: {},
  });
  assert.equal(
    (duplicate.structuredContent as Record<string, unknown>).port,
    safe.port,
  );
  assert.equal(manager.size, 1);

  const socket = await connect(safe.port as number);
  const input = Buffer.from([0, 1, 2, 3, 255, 128, 10, 0, 42]);
  socket.write(input);
  const [output] = (await once(socket, "data")) as [Buffer];
  assert.deepEqual(output, input);
  assert.equal(relay.observedPort, remotePort);
  assert.equal(relay.calls.length, 1);
  assert.equal(
    relay.calls[0]?.args.join(" ").includes(String(remotePort)),
    false,
  );
  assert.equal((relay.calls[0]?.options as { shell?: unknown }).shell, false);

  socket.end();
  await once(socket, "close");
  const closeResult = { structuredContent: { closed: true } };
  assert.equal(
    await hook({
      remoteTool: "close_ssh_tunnel",
      result: closeResult,
      remoteArgs: { tunnel_id: "tunnel-1" },
    }),
    closeResult,
  );
  assert.equal(manager.size, 0);
  await manager.close("tunnel-1");
  await manager.closeAll();
});

test("reset closes current bridges without permanently closing the manager", async (t) => {
  const relay = relaySpawn();
  const manager = new TunnelBridgeManager({
    isWsl: true,
    spawn: relay.spawn,
    probe: () => undefined,
    closeTimeoutMs: 500,
  });
  t.after(() => manager.closeAll().catch(() => undefined));

  const first = await manager.open("before-reset", "localhost", 12345);
  assert.equal(first.bridged, true);
  assert.equal(manager.size, 1);
  const firstReset = manager.reset();
  const duplicateReset = manager.reset();
  assert.equal(duplicateReset, firstReset);
  await firstReset;
  assert.equal(manager.size, 0);

  const second = await manager.open("after-reset", "localhost", 23456);
  assert.equal(second.bridged, true);
  assert.equal(manager.size, 1);
  await manager.reset();
  assert.equal(manager.size, 0);

  await manager.closeAll();
  await assert.rejects(
    () => manager.open("after-close", "localhost", 34567),
    /manager is closed/,
  );
});

test("maximum connection count rejects excess clients and cleanup is idempotent", async (t) => {
  const relay = relaySpawn();
  const manager = new TunnelBridgeManager({
    isWsl: true,
    spawn: relay.spawn,
    probe: () => undefined,
    maxConnections: 1,
    closeTimeoutMs: 500,
  });
  t.after(() => manager.closeAll().catch(() => undefined));
  const endpoint = await manager.open("limited", "localhost", 12345);
  const first = await connect(endpoint.port);
  while (relay.calls.length < 1)
    await new Promise((resolve) => setImmediate(resolve));
  const second = await connect(endpoint.port);
  await once(second, "close");
  assert.equal(relay.calls.length, 1);
  first.destroy();
  await manager.close("limited");
  await manager.close("limited");
  await manager.closeAll();
  await manager.closeAll();
  await assert.rejects(
    () => manager.open("late", "localhost", 12345),
    /manager is closed/,
  );
  assert.equal(manager.size, 0);
});

test("capability failure and aborted open do not publish a bridge", async () => {
  const unavailable = new TunnelBridgeManager({
    isWsl: true,
    probe: () => {
      throw new Error("raw host diagnostic");
    },
  });
  await assert.rejects(
    () => unavailable.open("failed", "127.0.0.1", 1000),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Windows tunnel relay helper is unavailable",
  );
  assert.equal(unavailable.size, 0);

  const aborted = new TunnelBridgeManager({
    isWsl: true,
    probe: () => undefined,
  });
  const controller = new AbortController();
  controller.abort(new DOMException("cancel tunnel", "AbortError"));
  await assert.rejects(
    () => aborted.open("aborted", "127.0.0.1", 1000, controller.signal),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(aborted.size, 0);
});
