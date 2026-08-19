import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { HEXHUB_TOOL_SPECS } from "../extensions/hexhub/catalog.js";
import type {
  HexHubCallResult,
  HexHubCatalogSnapshot,
  HexHubConfig,
  RemoteToolDefinition,
} from "../extensions/hexhub/contracts.js";
import {
  registerHexHubTools,
  routeHexHubToolGroups,
  type HexHubControllerClient,
} from "../extensions/hexhub/tool-controller.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function snapshot(
  epoch = 1,
  omit: readonly string[] = [],
  unknown = false,
): HexHubCatalogSnapshot {
  const tools: RemoteToolDefinition[] = HEXHUB_TOOL_SPECS.filter(
    (spec) => !omit.includes(spec.remoteName),
  ).map((spec) => ({
    name: spec.remoteName,
    inputSchema: clone(spec.reviewedRemoteSchema),
  }));
  if (unknown)
    tools.push({
      name: "future_tool",
      inputSchema: { type: "object", properties: {} },
    });
  return {
    epoch,
    tools,
    names: new Set(tools.map((tool) => tool.name)),
    unknownNames: [],
    incompatible: new Map(),
  };
}

const CONFIG: HexHubConfig = {
  version: 1,
  url: "http://127.0.0.1:17321/mcp",
  transport: "auto",
  timeoutMs: 30_000,
  auth: { type: "none" },
  initialGroups: [],
};

class FakePi {
  readonly tools: Array<Record<string, unknown>> = [];
  active = ["read"];

  getAllTools() {
    return this.tools;
  }
  registerTool(tool: Record<string, unknown>) {
    this.tools.push(tool);
  }
  getActiveTools() {
    return [...this.active];
  }
  setActiveTools(names: string[]) {
    this.active = [...names];
  }

  asApi(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }

  tool(name: string): Record<string, unknown> {
    const tool = this.tools.find((item) => item.name === name);
    assert.ok(tool, `missing registered tool ${name}`);
    return tool;
  }
}

class FakeClient implements HexHubControllerClient {
  generation = 1;
  current = snapshot(1, [], true);
  readonly calls: Array<{
    name: string;
    args: Record<string, unknown>;
    signal?: AbortSignal;
  }> = [];
  catalogReads = 0;
  writesActive = 0;
  writesMax = 0;

  getCatalog(): HexHubCatalogSnapshot {
    this.catalogReads += 1;
    return this.current;
  }

  getGeneration(): number {
    return this.generation;
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<HexHubCallResult> {
    this.calls.push({ name, args: clone(args), ...(signal ? { signal } : {}) });
    if (name === "list_assets") {
      return {
        structuredContent: {
          assets: [
            {
              asset_ref: "private-ssh-ref",
              asset_id: "private-asset-id",
              type: "ssh",
              name: "host",
            },
          ],
        },
      };
    }
    if (name === "read")
      return { structuredContent: { content: "one\ntwo\nthree" } };
    if (name === "write") {
      this.writesActive += 1;
      this.writesMax = Math.max(this.writesMax, this.writesActive);
      await new Promise((resolve) => setTimeout(resolve, 10));
      this.writesActive -= 1;
      return { structuredContent: { ok: true, asset_ref: "private-ssh-ref" } };
    }
    if (name === "open_ssh_tunnel") {
      return {
        structuredContent: {
          tunnel_id: "tunnel-1",
          host: "127.0.0.1",
          port: 1000,
        },
      };
    }
    return { structuredContent: { ok: true } };
  }

  async refreshCatalog(): Promise<HexHubCatalogSnapshot> {
    return this.current;
  }
  async reconnect(): Promise<void> {
    this.generation += 1;
  }
}

async function execute(
  pi: FakePi,
  name: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<any> {
  const tool = pi.tool(name);
  const fn = tool.execute as (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    update: undefined,
    context: { cwd: string },
  ) => Promise<unknown>;
  return fn("call-1", params, signal, undefined, { cwd: "/work" });
}

test("registers all static tools while initially activating only loader and assets additively", () => {
  const pi = new FakePi();
  const client = new FakeClient();
  const controller = registerHexHubTools({
    pi: pi.asApi(),
    client,
    config: CONFIG,
  });
  assert.equal(pi.tools.length, 25);
  assert.equal(new Set(pi.tools.map((tool) => tool.name)).size, 25);
  assert.deepEqual(pi.active, ["read", "hexhub_tools", "hexhub_assets"]);
  assert.equal(controller.getStatus().registered, 24);
  assert.deepEqual(controller.getStatus().unknown, ["future_tool"]);
});

test("loader routes locally, activates additively, and reports unknown without MCP calls", async () => {
  const pi = new FakePi();
  const client = new FakeClient();
  registerHexHubTools({ pi: pi.asApi(), client, config: CONFIG });
  const result = await execute(pi, "hexhub_tools", {
    query: "查看 Docker 容器最近日志",
  });
  assert.ok(pi.active.includes("hexhub_docker_containers"));
  assert.ok(pi.active.includes("hexhub_docker_logs"));
  assert.ok(pi.active.includes("read"));
  assert.equal(client.calls.length, 0);
  assert.match(result.content[0].text, /future_tool/);
  assert.deepEqual(routeHexHubToolGroups("修改远程文件"), [
    "files-read",
    "files-write",
  ]);
  assert.deepEqual(routeHexHubToolGroups("run SQL"), [
    "database-meta",
    "database-sql",
  ]);
});

test("remote execution passes signal, maps refs, enforces read-before-write, and serializes writes", async () => {
  const pi = new FakePi();
  const client = new FakeClient();
  const controller = registerHexHubTools({
    pi: pi.asApi(),
    client,
    config: CONFIG,
  });
  controller.activateGroups(["files-read", "files-write"]);
  const abort = new AbortController();

  const assets = await execute(pi, "hexhub_assets", {}, abort.signal);
  assert.doesNotMatch(
    JSON.stringify(assets),
    /private-ssh-ref|private-asset-id|asset_ref/,
  );
  assert.deepEqual(client.calls[0].args, { pattern: "" });
  assert.equal(client.calls[0].signal, abort.signal);

  await assert.rejects(
    execute(pi, "hexhub_write", {
      asset: "ssh:1",
      file_path: "/etc/app",
      content: "new",
    }),
    /hexhub_read/,
  );
  const read = await execute(
    pi,
    "hexhub_read",
    {
      asset: "ssh:1",
      container: "",
      file_path: "/etc/app",
      offset: 2,
      limit: 1,
    },
    abort.signal,
  );
  assert.equal(read.content[0].text, "two\n\n[lines 2-2 of 3]");
  const readCall = client.calls.find((call) => call.name === "read")!;
  assert.deepEqual(readCall.args, {
    asset_ref: "private-ssh-ref",
    file_path: "/etc/app",
  });
  assert.equal(readCall.signal, abort.signal);

  await Promise.all([
    execute(pi, "hexhub_write", {
      asset: "ssh:1",
      file_path: "/etc/app",
      content: "a",
    }),
    execute(pi, "hexhub_write", {
      asset: "ssh:1",
      file_path: "/etc/app",
      content: "b",
    }),
  ]);
  assert.equal(client.writesMax, 1);
  assert.ok(client.catalogReads >= client.calls.length);
});

test("latest catalog revocation removes only invalid HexHub tools and blocks stale calls", async () => {
  const pi = new FakePi();
  const client = new FakeClient();
  const controller = registerHexHubTools({
    pi: pi.asApi(),
    client,
    config: CONFIG,
  });
  controller.activateGroups(["shell"]);
  assert.ok(pi.active.includes("hexhub_shell"));
  client.current = snapshot(2, ["shell"], true);
  const before = client.calls.length;
  await assert.rejects(
    execute(pi, "hexhub_shell", { asset: "ssh:1", command: "pwd" }),
    /unavailable/,
  );
  assert.equal(client.calls.length, before);
  assert.equal(pi.active.includes("hexhub_shell"), false);
  assert.ok(pi.active.includes("read"));
  assert.ok(pi.active.includes("hexhub_tools"));
});

test("incompatible schemas block calls and are removed from the active set", async () => {
  const pi = new FakePi();
  const client = new FakeClient();
  const controller = registerHexHubTools({
    pi: pi.asApi(),
    client,
    config: CONFIG,
  });
  controller.activateGroups(["shell"]);
  const changed = snapshot(2, [], false);
  const shell = changed.tools.find((tool) => tool.name === "shell")!;
  (
    shell.inputSchema.properties as Record<string, { type: string }>
  ).command.type = "number";
  client.current = changed;
  await assert.rejects(
    execute(pi, "hexhub_shell", { asset: "ssh:1", command: "pwd" }),
    /incompatible/,
  );
  assert.equal(pi.active.includes("hexhub_shell"), false);
  assert.deepEqual(controller.getStatus().incompatible, ["shell"]);
});

test("platform path and tunnel hooks are injectable and config hooks refresh/reset safely", async () => {
  const pi = new FakePi();
  const client = new FakeClient();
  let tunnelHookCalls = 0;
  const controller = registerHexHubTools({
    pi: pi.asApi(),
    client,
    config: CONFIG,
    localPath(path, context) {
      assert.equal(path, "local.txt");
      assert.equal(context.cwd, "/work");
      return "//?/D:/work/local.txt";
    },
    tunnelResult(context) {
      tunnelHookCalls += 1;
      assert.equal(context.remoteTool, "open_ssh_tunnel");
      return {
        structuredContent: {
          tunnel_id: "tunnel-1",
          host: "127.0.0.1",
          port: 4321,
        },
      };
    },
  });
  await execute(pi, "hexhub_assets", {});
  controller.activateGroups(["transfer", "tunnel"]);
  await execute(pi, "hexhub_scp", {
    asset: "ssh:1",
    direction: "upload",
    local_path: "local.txt",
    remote_path: "/tmp/local.txt",
  });
  const scp = client.calls.find((call) => call.name === "scp_transfer")!;
  assert.equal(scp.args.local_path, "//?/D:/work/local.txt");

  const tunnel = await execute(pi, "hexhub_tunnel_open", {
    asset: "ssh:1",
    target_host: "127.0.0.1",
    target_port: 5432,
  });
  assert.match(tunnel.content[0].text, /127\.0\.0\.1:4321/);
  assert.equal(tunnelHookCalls, 1);

  const hooks = controller.createConfigHooks();
  assert.match(
    hooks.tools().join("\n"),
    /未知工具（仅报告，不自动开放）：future_tool/u,
  );
  const reset = hooks.resetTools();
  assert.deepEqual(reset, ["hexhub_tools", "hexhub_assets"]);
  assert.deepEqual(pi.active, ["read", "hexhub_tools", "hexhub_assets"]);
  await hooks.reconnect();
  assert.equal(client.generation, 2);
});

test("generation changes invalidate read evidence and short handles", async () => {
  const pi = new FakePi();
  const client = new FakeClient();
  const controller = registerHexHubTools({
    pi: pi.asApi(),
    client,
    config: CONFIG,
  });
  controller.activateGroups(["files-read", "files-write"]);
  await execute(pi, "hexhub_assets", {});
  await execute(pi, "hexhub_read", { asset: "ssh:1", file_path: "/etc/app" });
  client.generation += 1;
  await assert.rejects(
    execute(pi, "hexhub_write", {
      asset: "ssh:1",
      file_path: "/etc/app",
      content: "new",
    }),
    /Unknown HexHub asset/,
  );
});
