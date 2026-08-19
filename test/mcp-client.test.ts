import assert from "node:assert/strict";
import test from "node:test";

import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

import { DEFAULT_HEXHUB_CONFIG } from "../extensions/hexhub/config.js";
import {
  HexHubMcpClient,
  type HexHubFetchResolver,
} from "../extensions/hexhub/mcp-client.js";
import type { HexHubConfig } from "../extensions/hexhub/contracts.js";

interface FakeServerOptions {
  firstCallStatus?: number;
  alwaysCallStatus?: number;
  pagedTools?: boolean;
  initializeDelay?: Promise<void>;
}

interface FakeServer {
  fetch: FetchLike;
  initializeCount: number;
  callCount: number;
  deleteCount: number;
  seenSessions: string[];
}

function rpcResponse(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function createFakeServer(options: FakeServerOptions = {}): FakeServer {
  const state: FakeServer = {
    initializeCount: 0,
    callCount: 0,
    deleteCount: 0,
    seenSessions: [],
    fetch: undefined as unknown as FetchLike,
  };
  state.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET") return new Response(null, { status: 405 });
    if (method === "DELETE") {
      state.deleteCount += 1;
      return new Response(null, { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as {
      id?: unknown;
      method?: string;
      params?: { cursor?: string };
    };
    const headers = new Headers(init?.headers);
    const session = headers.get("mcp-session-id");
    if (session) state.seenSessions.push(session);

    if (body.method === "initialize") {
      state.initializeCount += 1;
      await options.initializeDelay;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-hexhub", version: "1.2.3" },
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "mcp-session-id": `session-${state.initializeCount}`,
          },
        },
      );
    }
    if (body.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    if (body.method === "tools/list") {
      if (options.pagedTools && !body.params?.cursor) {
        return rpcResponse(body.id, {
          tools: [
            {
              name: "asset_list",
              description: "Assets",
              inputSchema: { type: "object" },
            },
          ],
          nextCursor: "page-2",
        });
      }
      return rpcResponse(body.id, {
        tools: [
          {
            name: options.pagedTools ? "shell_run" : "asset_list",
            inputSchema: { type: "object" },
          },
        ],
      });
    }
    if (body.method === "tools/call") {
      state.callCount += 1;
      const status =
        options.alwaysCallStatus ??
        (state.callCount === 1 ? options.firstCallStatus : undefined);
      if (status) return new Response("session rejected", { status });
      return rpcResponse(body.id, { content: [{ type: "text", text: "ok" }] });
    }
    throw new Error(`Unexpected MCP request: ${body.method}`);
  }) as FetchLike;
  return state;
}

function config(overrides: Partial<HexHubConfig> = {}): HexHubConfig {
  return {
    ...DEFAULT_HEXHUB_CONFIG,
    timeoutMs: 2_000,
    auth: { type: "none" },
    initialGroups: [],
    ...overrides,
  };
}

function resolver(
  server: FakeServer,
  kind: "direct" | "windows-helper" = "direct",
): HexHubFetchResolver {
  return async () => ({ fetch: server.fetch, kind });
}

test("connect is single-flight and stores a paginated raw catalog", async (t) => {
  const server = createFakeServer({ pagedTools: true });
  const client = new HexHubMcpClient(config(), {
    fetchResolver: resolver(server),
    closeTimeoutMs: 50,
  });
  t.after(() => client.close());

  const [first, second, third] = await Promise.all([
    client.connect(),
    client.connect(),
    client.connect(),
  ]);
  assert.equal(server.initializeCount, 1);
  assert.equal(first.state, "connected");
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  assert.deepEqual(
    client.getCatalog().tools.map((tool) => tool.name),
    ["asset_list", "shell_run"],
  );
  assert.equal(client.getCatalog().epoch, 1);
  assert.equal(client.getStatus().serverName, "fake-hexhub");
  assert.equal(client.getStatus().protocolVersion, "2025-03-26");
  assert.ok(server.seenSessions.every((session) => session === "session-1"));
});

test("404 session failure reconnects and retries once", async (t) => {
  const server = createFakeServer({ firstCallStatus: 404 });
  const client = new HexHubMcpClient(config(), {
    fetchResolver: resolver(server),
    closeTimeoutMs: 50,
  });
  t.after(() => client.close());

  const result = await client.callTool("asset_list");
  assert.equal(result.content?.[0]?.text, "ok");
  assert.equal(server.callCount, 2);
  assert.equal(server.initializeCount, 2);
  assert.ok(server.deleteCount >= 1);
  assert.ok(client.getCatalog().epoch >= 3);
});

test("401 and repeated 404 are not retried beyond the single session retry", async (t) => {
  const unauthorizedServer = createFakeServer({ alwaysCallStatus: 401 });
  const unauthorized = new HexHubMcpClient(config(), {
    fetchResolver: resolver(unauthorizedServer),
    closeTimeoutMs: 50,
  });
  t.after(() => unauthorized.close());
  await assert.rejects(
    () => unauthorized.callTool("asset_list"),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: number }).code === 401,
  );
  assert.equal(unauthorizedServer.callCount, 1);
  assert.equal(unauthorizedServer.initializeCount, 1);

  const invalidServer = createFakeServer({ alwaysCallStatus: 404 });
  const invalid = new HexHubMcpClient(config(), {
    fetchResolver: resolver(invalidServer),
    closeTimeoutMs: 50,
  });
  t.after(() => invalid.close());
  await assert.rejects(
    () => invalid.callTool("asset_list"),
    /404|session rejected/i,
  );
  assert.equal(invalidServer.callCount, 2);
  assert.equal(invalidServer.initializeCount, 2);
});

test("caller cancellation propagates without reconnecting", async (t) => {
  const server = createFakeServer();
  const client = new HexHubMcpClient(config(), {
    fetchResolver: resolver(server),
    closeTimeoutMs: 50,
  });
  t.after(() => client.close());
  await client.connect();
  const controller = new AbortController();
  controller.abort(new DOMException("cancelled by test", "AbortError"));
  await assert.rejects(
    () => client.connect(controller.signal),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  await assert.rejects(
    () => client.callTool("asset_list", {}, controller.signal),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(server.callCount, 0);
  assert.equal(server.initializeCount, 1);
});

test("runtime configure invalidates an in-flight generation", async (t) => {
  let releaseFirst!: () => void;
  const delayed = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstServer = createFakeServer({ initializeDelay: delayed });
  const secondServer = createFakeServer();
  let resolutions = 0;
  const fetchResolver: HexHubFetchResolver = async () => {
    resolutions += 1;
    return {
      fetch: resolutions === 1 ? firstServer.fetch : secondServer.fetch,
      kind: "direct",
    };
  };
  const client = new HexHubMcpClient(config(), {
    fetchResolver,
    closeTimeoutMs: 50,
  });
  t.after(() => client.close());

  const stale = client.connect();
  while (firstServer.initializeCount === 0)
    await new Promise((resolve) => setTimeout(resolve, 1));
  const nextConfig = config({ url: "http://127.0.0.1:17322/mcp" });
  await client.configure(nextConfig);
  releaseFirst();
  await assert.rejects(
    stale,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );

  const status = await client.connect();
  assert.equal(status.endpoint, nextConfig.url);
  assert.equal(status.connected, true);
  assert.equal(secondServer.initializeCount, 1);
  assert.ok(client.getGeneration() >= 1);
});

test("errors and status redact configured tokens", async () => {
  const token = "top-secret-token";
  const fetchResolver: HexHubFetchResolver = async () => {
    throw new Error(`failed while using ${token}`);
  };
  const client = new HexHubMcpClient(
    config({
      auth: { type: "token", token, header: "authorization" },
    }),
    { fetchResolver, closeTimeoutMs: 50 },
  );
  await assert.rejects(
    () => client.connect(),
    (error: unknown) =>
      error instanceof Error &&
      !error.message.includes(token) &&
      error.message.includes("[redacted]"),
  );
  assert.equal(JSON.stringify(client.getStatus()).includes(token), false);
  assert.equal(client.getStatus().lastError?.includes(token), false);
});

test("StreamableHTTPError exposes status codes used by retry classification", () => {
  assert.equal(new StreamableHTTPError(404, "missing").code, 404);
});
