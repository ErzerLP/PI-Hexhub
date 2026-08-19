import assert from "node:assert/strict";
import test from "node:test";

import { HexHubAssetRegistry } from "../extensions/hexhub/asset-registry.js";

const ASSETS = {
  structuredContent: {
    assets: [
      {
        asset_ref: "route:ssh:secret-1",
        id: "asset-real-1",
        type: "ssh",
        name: "prod",
        host: "prod.example",
      },
      {
        asset_ref: "route:docker:secret-2",
        id: "asset-real-2",
        type: "docker",
        name: "apps",
        host: "docker.example",
      },
      {
        asset_ref: "route:db:secret-3",
        type: "database",
        name: "orders",
        db_type: "postgres",
      },
      { asset_ref: "route:redis:secret-4", type: "redis", name: "cache" },
      {
        asset_ref: "route:ssh:secret-5",
        type: "ssh",
        name: "prod",
        host: "backup.example",
      },
    ],
  },
};

test("assets receive typed session handles and public data never exposes identifiers", () => {
  const registry = new HexHubAssetRegistry();
  registry.sync(1, 1);
  const assets = registry.ingestAssets(ASSETS);
  assert.deepEqual(
    assets.map((item) => item.asset),
    ["ssh:1", "docker:1", "db:1", "redis:1", "ssh:2"],
  );
  const publicJson = JSON.stringify(assets);
  assert.doesNotMatch(publicJson, /route:|asset-real|asset_ref/);
  assert.equal(registry.resolveAsset("apps").handle, "docker:1");
  assert.equal(registry.resolveAsset("ssh:1").name, "prod");
  assert.throws(
    () => registry.resolveAsset("prod"),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /Ambiguous/);
      assert.match(message, /ssh:1 \(prod\)/);
      assert.doesNotMatch(message, /route:|asset-real/);
      return true;
    },
  );
});

test("catalog epoch or connection generation invalidates every old handle", () => {
  const registry = new HexHubAssetRegistry();
  registry.sync(3, 8);
  registry.ingestAssets(ASSETS);
  assert.equal(registry.resolveAsset("ssh:1").name, "prod");
  assert.equal(registry.sync(3, 9), true);
  assert.throws(() => registry.resolveAsset("ssh:1"), /Unknown/);
  registry.ingestAssets(ASSETS);
  assert.equal(registry.sync(4, 9), true);
  assert.throws(() => registry.resolveAsset("docker:1"), /Unknown/);
});

test("container handles resolve by handle or unique name without exposing ids", () => {
  const registry = new HexHubAssetRegistry();
  registry.sync(1, 1);
  registry.ingestAssets(ASSETS);
  const docker = registry.resolveAsset("docker:1");
  const containers = registry.ingestContainers(docker, {
    structuredContent: {
      containers: [
        {
          id: "sha256:internal-one",
          name: "api",
          image: "example/api:1",
          status: "running",
          health: "healthy",
        },
        {
          container_id: "sha256:internal-two",
          Names: ["/worker"],
          image: "example/worker:1",
          state: "stopped",
        },
      ],
    },
  });
  assert.deepEqual(
    containers.map((item) => item.container),
    ["container:1", "container:2"],
  );
  assert.doesNotMatch(JSON.stringify(containers), /sha256|container_id/);
  assert.deepEqual(registry.resolveContainer(docker, "api"), {
    handle: "container:1",
    name: "api",
    id: "sha256:internal-one",
  });
  assert.equal(registry.resolveContainer(docker, "container:2").name, "worker");
  assert.ok(registry.getSensitiveValues().includes("sha256:internal-one"));
});

test("assets can be parsed from MCP text fallback", () => {
  const registry = new HexHubAssetRegistry();
  registry.sync(1, 1);
  const assets = registry.ingestAssets({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          assets: [{ asset_ref: "private", type: "ssh", name: "host" }],
        }),
      },
    ],
  });
  assert.deepEqual(assets, [{ asset: "ssh:1", type: "ssh", name: "host" }]);
});
