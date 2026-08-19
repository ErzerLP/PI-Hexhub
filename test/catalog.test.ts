import assert from "node:assert/strict";
import test from "node:test";

import {
  HEXHUB_TOOL_LOADER,
  HEXHUB_TOOL_SPECS,
} from "../extensions/hexhub/catalog.js";

const EXPECTED: Readonly<Record<string, string>> = {
  hexhub_assets: "list_assets",
  hexhub_shell: "shell",
  hexhub_read: "read",
  hexhub_write: "write",
  hexhub_edit: "edit",
  hexhub_multi_edit: "multi_edit",
  hexhub_delete: "delete",
  hexhub_docker_containers: "list_docker_containers",
  hexhub_docker_logs: "docker_container_logs",
  hexhub_docker_action: "docker_container_action",
  hexhub_db_objects: "list_db_objects",
  hexhub_db_ddl: "db_table_ddl",
  hexhub_sql: "execute_sql",
  hexhub_redis: "redis_command",
  hexhub_scp: "scp_transfer",
  hexhub_tunnel_open: "open_ssh_tunnel",
  hexhub_tunnel_close: "close_ssh_tunnel",
  hexhub_terminal_open: "open_ssh_terminal",
  hexhub_terminal_close: "close_ssh_terminal",
  hexhub_terminals: "list_ssh_terminals",
  hexhub_terminal_send: "ssh_terminal_send",
  hexhub_terminal_key: "ssh_terminal_key",
  hexhub_terminal_read: "ssh_terminal_read",
  hexhub_terminal_expect: "ssh_terminal_expect",
};

test("catalog contains the exact 24 reviewed mappings and policies", () => {
  assert.equal(HEXHUB_TOOL_SPECS.length, 24);
  assert.deepEqual(
    Object.fromEntries(
      HEXHUB_TOOL_SPECS.map((spec) => [spec.name, spec.remoteName]),
    ),
    EXPECTED,
  );
  assert.equal(new Set(HEXHUB_TOOL_SPECS.map((spec) => spec.name)).size, 24);
  assert.equal(
    new Set(HEXHUB_TOOL_SPECS.map((spec) => spec.remoteName)).size,
    24,
  );
  for (const spec of HEXHUB_TOOL_SPECS) {
    assert.ok(spec.group);
    assert.match(spec.risk, /^(read|mutate|destructive|interactive)$/);
    assert.match(spec.executionMode, /^(parallel|sequential)$/);
    assert.ok(spec.resultPolicy);
    assert.equal(
      (spec.parameters as unknown as Record<string, unknown>)
        .additionalProperties,
      false,
    );
    assert.equal(spec.reviewedRemoteSchema.type, "object");
  }
});

test("model schemas use asset and container without exposing remote selector fields", () => {
  for (const spec of HEXHUB_TOOL_SPECS) {
    const properties = (
      spec.parameters as unknown as { properties: Record<string, unknown> }
    ).properties;
    assert.equal("asset_ref" in properties, false, spec.name);
    assert.equal("container_id" in properties, false, spec.name);
    assert.equal("container_name" in properties, false, spec.name);
  }
  const read = HEXHUB_TOOL_SPECS.find((spec) => spec.name === "hexhub_read")!;
  assert.deepEqual(
    Object.keys(
      (read.parameters as unknown as { properties: object }).properties,
    ).sort(),
    ["asset", "container", "file_path", "limit", "offset"],
  );
  const assets = HEXHUB_TOOL_SPECS.find(
    (spec) => spec.name === "hexhub_assets",
  )!;
  const pattern = (
    assets.parameters as unknown as {
      properties: { pattern: { default: string } };
    }
  ).properties.pattern;
  assert.equal(pattern.default, "");
});

test("redis schema is present with the recovered 5.3.9 contract", () => {
  const redis = HEXHUB_TOOL_SPECS.find(
    (spec) => spec.remoteName === "redis_command",
  )!;
  const remote = redis.reviewedRemoteSchema as {
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: boolean;
  };
  assert.deepEqual(Object.keys(remote.properties).sort(), [
    "asset_ref",
    "command",
    "db",
    "description",
    "timeout",
  ]);
  assert.deepEqual([...remote.required].sort(), ["asset_ref", "command"]);
  assert.equal(remote.additionalProperties, false);
  const model = redis.parameters as unknown as {
    properties: Record<string, unknown>;
    required: string[];
  };
  assert.ok(model.properties.asset);
  assert.equal("asset_ref" in model.properties, false);
});

test("bootstrap definitions stay below the approved disclosure budget", () => {
  const assets = HEXHUB_TOOL_SPECS.find(
    (spec) => spec.name === "hexhub_assets",
  )!;
  const serialized = JSON.stringify([
    {
      name: HEXHUB_TOOL_LOADER.name,
      description: HEXHUB_TOOL_LOADER.description,
      schema: HEXHUB_TOOL_LOADER.parameters,
    },
    {
      name: assets.name,
      description: assets.description,
      schema: assets.parameters,
    },
  ]);
  assert.ok(
    serialized.length < 2_400,
    `bootstrap serialized length=${serialized.length}`,
  );
  assert.ok(
    serialized.length <= 29_181 * 0.1,
    `reduction was only ${serialized.length}/29181`,
  );
});
