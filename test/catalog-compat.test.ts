import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { HEXHUB_TOOL_SPECS } from "../extensions/hexhub/catalog.js";
import {
  analyzeHexHubCatalog,
  checkHexHubToolCompatibility,
} from "../extensions/hexhub/catalog-compat.js";
import type { RemoteToolDefinition } from "../extensions/hexhub/contracts.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const HEXHUB_539_TOOLS = JSON.parse(
  readFileSync(
    new URL("./fixtures/hexhub-5.3.9-tools.json", import.meta.url),
    "utf8",
  ),
) as RemoteToolDefinition[];

function remoteTools(includeRedis = false): RemoteToolDefinition[] {
  const tools = clone(HEXHUB_539_TOOLS);
  if (includeRedis) {
    const redis = HEXHUB_TOOL_SPECS.find(
      (spec) => spec.remoteName === "redis_command",
    );
    assert.ok(redis);
    tools.push({
      name: redis.remoteName,
      inputSchema: clone(redis.reviewedRemoteSchema),
    });
  }
  return tools;
}

test("the 23-tool 5.3.9 baseline is compatible and Redis is merely unavailable", () => {
  const diagnostics = analyzeHexHubCatalog(remoteTools(), 7);
  assert.equal(diagnostics.epoch, 7);
  assert.deepEqual(diagnostics.unavailable, ["redis_command"]);
  assert.deepEqual([...diagnostics.incompatible], []);
  assert.deepEqual(diagnostics.unknown, []);
  assert.equal(diagnostics.tools.get("shell")?.status, "available");
  assert.match(diagnostics.fingerprint, /^[a-f0-9]{20}$/);
});

test("description drift and added optional fields remain compatible", () => {
  const spec = HEXHUB_TOOL_SPECS.find((item) => item.remoteName === "shell")!;
  const remote: RemoteToolDefinition = {
    name: spec.remoteName,
    description: "completely changed long server description",
    inputSchema: clone(spec.reviewedRemoteSchema),
  };
  (remote.inputSchema.properties as Record<string, unknown>).new_hint = {
    type: "string",
    description: "new",
  };
  const status = checkHexHubToolCompatibility(spec, remote);
  assert.equal(status.status, "available");
  assert.deepEqual(status.optionalRemoteFields, ["$.properties.new_hint"]);

  const a = analyzeHexHubCatalog([remote], 1);
  remote.description = "another description";
  const b = analyzeHexHubCatalog([remote], 2);
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.equal(b.tools.get("shell")?.status, "available");
});

test("required, type, enum, and additionalProperties drift block only that tool", () => {
  const action = HEXHUB_TOOL_SPECS.find(
    (item) => item.remoteName === "docker_container_action",
  )!;
  const required = clone(action.reviewedRemoteSchema) as { required: string[] };
  required.required.push("extra");
  assert.equal(
    checkHexHubToolCompatibility(action, {
      name: action.remoteName,
      inputSchema: required,
    }).status,
    "incompatible",
  );

  const changedType = clone(action.reviewedRemoteSchema) as {
    properties: Record<string, { type?: string; enum?: string[] }>;
  };
  changedType.properties.action.type = "number";
  assert.match(
    checkHexHubToolCompatibility(action, {
      name: action.remoteName,
      inputSchema: changedType,
    }).reason!,
    /type changed/,
  );

  const changedEnum = clone(action.reviewedRemoteSchema) as {
    properties: Record<string, { enum?: string[] }>;
  };
  changedEnum.properties.action.enum = ["start", "stop"];
  assert.match(
    checkHexHubToolCompatibility(action, {
      name: action.remoteName,
      inputSchema: changedEnum,
    }).reason!,
    /enum changed/,
  );

  const redis = HEXHUB_TOOL_SPECS.find(
    (item) => item.remoteName === "redis_command",
  )!;
  const changedAdditional = clone(redis.reviewedRemoteSchema) as Record<
    string,
    unknown
  >;
  changedAdditional.additionalProperties = true;
  assert.match(
    checkHexHubToolCompatibility(redis, {
      name: redis.remoteName,
      inputSchema: changedAdditional,
    }).reason!,
    /additionalProperties/,
  );
});

test("missing tools are unavailable and unknown tools are report-only", () => {
  const tools = remoteTools();
  tools.push({
    name: "future_destroy_everything",
    inputSchema: { type: "object", properties: {} },
  });
  const diagnostics = analyzeHexHubCatalog(tools, 9);
  assert.deepEqual(diagnostics.unknown, ["future_destroy_everything"]);
  assert.equal(diagnostics.tools.has("future_destroy_everything"), false);
  assert.match(diagnostics.diagnostics.join("\n"), /report only/);
});
