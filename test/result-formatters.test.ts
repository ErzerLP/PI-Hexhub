import assert from "node:assert/strict";
import test from "node:test";

import {
  HEXHUB_TOOL_SPECS,
  type HexHubResultPolicy,
} from "../extensions/hexhub/catalog.js";
import { HexHubAssetRegistry } from "../extensions/hexhub/asset-registry.js";
import type { HexHubPreparedInput } from "../extensions/hexhub/input-adapters.js";
import {
  formatHexHubResult,
  getHexHubResultBudget,
  redactHexHubValue,
  truncateHexHubText,
} from "../extensions/hexhub/result-formatters.js";

function spec(remoteName: string) {
  return HEXHUB_TOOL_SPECS.find((item) => item.remoteName === remoteName)!;
}

function prepared(
  overrides: Partial<HexHubPreparedInput> = {},
): HexHubPreparedInput {
  return { remoteArgs: {}, internal: {}, ...overrides };
}

function registry(): HexHubAssetRegistry {
  const value = new HexHubAssetRegistry();
  value.sync(1, 1);
  value.ingestAssets({
    structuredContent: {
      assets: [
        {
          asset_ref: "secret-ref-value",
          asset_id: "secret-asset-id",
          type: "ssh",
          name: "host",
        },
      ],
    },
  });
  return value;
}

test("structuredContent is preferred without repeating text fallback", () => {
  const output = formatHexHubResult({
    result: {
      structuredContent: { stdout: "structured output", exit_code: 0 },
      content: [{ type: "text", text: "fallback must not appear" }],
    },
    spec: spec("shell"),
    registry: registry(),
    prepared: prepared({ remoteArgs: { command: "true" } }),
  });
  assert.match(output.content[0].text, /structured output/);
  assert.doesNotMatch(output.content[0].text, /fallback must not appear/);
});

test("asset and container lists expose only short handles and readable columns", () => {
  const assets = registry();
  const assetOutput = formatHexHubResult({
    result: {
      structuredContent: {
        assets: [
          {
            asset_ref: "another-private-ref",
            id: "real-id",
            type: "docker",
            name: "apps",
            host: "docker.local",
          },
        ],
      },
    },
    spec: spec("list_assets"),
    registry: assets,
    prepared: prepared(),
  });
  assert.match(assetOutput.content[0].text, /docker:1\tdocker\tapps/);
  assert.doesNotMatch(
    JSON.stringify(assetOutput),
    /another-private-ref|real-id|asset_ref/,
  );

  const docker = assets.resolveAsset("docker:1");
  const containerOutput = formatHexHubResult({
    result: {
      structuredContent: {
        containers: [
          {
            container_id: "private-container-id",
            name: "api",
            image: "api:1",
            status: "running",
          },
        ],
      },
    },
    spec: spec("list_docker_containers"),
    registry: assets,
    prepared: prepared({
      internal: { asset: docker },
      remoteArgs: { asset_ref: docker.ref },
    }),
  });
  assert.match(
    containerOutput.content[0].text,
    /container:1\tapi\tapi:1\trunning/,
  );
  assert.doesNotMatch(
    JSON.stringify(containerOutput),
    /private-container-id|another-private-ref/,
  );
});

test("file windows and SQL rows are compressed into bounded model text", () => {
  const assets = registry();
  const file = formatHexHubResult({
    result: {
      structuredContent: { content: "one\ntwo\nthree\nfour" },
      content: [{ type: "text", text: "duplicate" }],
    },
    spec: spec("read"),
    registry: assets,
    prepared: prepared({
      resultOptions: { fileWindow: { offset: 2, limit: 2 } },
    }),
  });
  assert.equal(file.content[0].text, "two\nthree\n\n[lines 2-3 of 4]");

  const sql = formatHexHubResult({
    result: {
      structuredContent: {
        columns: ["id", "name"],
        rows: [
          [1, "a"],
          [2, "b"],
        ],
        row_count: 2,
      },
    },
    spec: spec("execute_sql"),
    registry: assets,
    prepared: prepared(),
  });
  assert.equal(sql.content[0].text, "id\tname\n1\ta\n2\tb\n\n[rows=2]");
});

test("deep redaction removes refs, asset ids, container ids, routes, and tokens", () => {
  const assets = registry();
  const sanitized = redactHexHubValue(
    {
      asset_ref: "secret-ref-value",
      assetId: "secret-asset-id",
      container_id: "container-secret",
      token: "token-secret",
      nested: { route: "internal", ok: "Bearer abc.def and secret-ref-value" },
    },
    assets.getSensitiveValues(),
  );
  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(
    serialized,
    /secret-ref|secret-asset|container-secret|token-secret|internal|abc\.def/,
  );

  const output = formatHexHubResult({
    result: {
      structuredContent: {
        ddl: "-- asset_ref=secret-ref-value token=token-secret\nCREATE TABLE ok();",
      },
    },
    spec: spec("db_table_ddl"),
    registry: assets,
    prepared: prepared(),
  });
  assert.doesNotMatch(JSON.stringify(output), /secret-ref-value|token-secret/);
  assert.doesNotMatch(JSON.stringify(output.details), /asset_ref|remoteArgs/);
});

test("every policy budget is below 50 KiB and 2000 lines with explicit truncation metadata", () => {
  const policies = [
    ...new Set(HEXHUB_TOOL_SPECS.map((item) => item.resultPolicy)),
  ] as HexHubResultPolicy[];
  const huge = Array.from(
    { length: 4_000 },
    (_, index) => `${index}:${"x".repeat(100)}`,
  ).join("\n");
  for (const policy of policies) {
    const budget = getHexHubResultBudget(policy);
    const result = truncateHexHubText(huge, budget);
    assert.equal(result.metadata.truncated, true, policy);
    assert.ok(Buffer.byteLength(result.text) <= budget.maxBytes, policy);
    assert.ok(result.text.split("\n").length <= budget.maxLines, policy);
    assert.ok(Buffer.byteLength(result.text) <= 50 * 1024, policy);
    assert.ok(result.text.split("\n").length <= 2_000, policy);
    assert.match(result.text, /HexHub result truncated/, policy);
  }
});

test("shell/log/terminal tail policies retain the newest output", () => {
  const assets = registry();
  for (const remoteName of [
    "shell",
    "docker_container_logs",
    "ssh_terminal_read",
  ]) {
    const item = spec(remoteName);
    const field =
      remoteName === "docker_container_logs"
        ? "logs"
        : remoteName === "shell"
          ? "stdout"
          : "text";
    const output = formatHexHubResult({
      result: {
        structuredContent: { [field]: `${"old\n".repeat(2_000)}LATEST` },
      },
      spec: item,
      registry: assets,
      prepared: prepared({ remoteArgs: { command: "x" } }),
    });
    assert.match(output.content[0].text, /LATEST/, remoteName);
    assert.equal(output.details.truncated, true, remoteName);
    assert.equal(output.details.truncation.strategy, "tail", remoteName);
  }
});
