import assert from "node:assert/strict";
import test from "node:test";

import { HEXHUB_TOOL_SPECS } from "../extensions/hexhub/catalog.js";
import { HexHubAssetRegistry } from "../extensions/hexhub/asset-registry.js";
import {
  DEFAULT_DOCKER_LOG_TAIL,
  HexHubFileReadEvidence,
  prepareHexHubInput,
} from "../extensions/hexhub/input-adapters.js";
import { KeyedMutationQueue } from "../extensions/hexhub/mutation-queue.js";

function spec(remoteName: string) {
  return HEXHUB_TOOL_SPECS.find((item) => item.remoteName === remoteName)!;
}

function registry(): HexHubAssetRegistry {
  const value = new HexHubAssetRegistry();
  value.sync(1, 1);
  value.ingestAssets({
    structuredContent: {
      assets: [
        { asset_ref: "ssh-private", type: "ssh", name: "host" },
        { asset_ref: "docker-private", type: "docker", name: "dock" },
        { asset_ref: "db-private", type: "database", name: "database" },
      ],
    },
  });
  value.ingestContainers("docker:1", {
    structuredContent: {
      containers: [{ id: "container-private", name: "api" }],
    },
  });
  return value;
}

test("asset and container selectors adapt to each exact remote field", async () => {
  const assets = registry();
  const shell = await prepareHexHubInput({
    spec: spec("shell"),
    params: { asset: "docker:1", container: "container:1", command: "pwd" },
    registry: assets,
    cwd: "/tmp",
  });
  assert.deepEqual(shell.remoteArgs, {
    asset_ref: "docker-private",
    container_id: "container-private",
    command: "pwd",
  });

  const logs = await prepareHexHubInput({
    spec: spec("docker_container_logs"),
    params: { asset: "dock", container: "api" },
    registry: assets,
    cwd: "/tmp",
  });
  assert.deepEqual(logs.remoteArgs, {
    asset_ref: "docker-private",
    container_name: "api",
    tail_lines: DEFAULT_DOCKER_LOG_TAIL,
  });
  await assert.rejects(
    prepareHexHubInput({
      spec: spec("shell"),
      params: { asset: "docker:1", command: "pwd" },
      registry: assets,
      cwd: "/tmp",
    }),
    /container is required/,
  );
});

test("read offset and limit stay local and list_assets gets an empty pattern", async () => {
  const assets = registry();
  const read = await prepareHexHubInput({
    spec: spec("read"),
    params: { asset: "ssh:1", file_path: "/etc/app", offset: 10, limit: 20 },
    registry: assets,
    cwd: "/tmp",
  });
  assert.deepEqual(read.remoteArgs, {
    asset_ref: "ssh-private",
    file_path: "/etc/app",
  });
  assert.deepEqual(read.resultOptions, {
    fileWindow: { offset: 10, limit: 20 },
  });
  assert.ok(read.internal.fileKey);

  const list = await prepareHexHubInput({
    spec: spec("list_assets"),
    params: {},
    registry: assets,
    cwd: "/tmp",
  });
  assert.deepEqual(list.remoteArgs, { pattern: "" });
});

test("SCP local path is transformed only through the injected platform hook", async () => {
  const assets = registry();
  let context: unknown;
  const prepared = await prepareHexHubInput({
    spec: spec("scp_transfer"),
    params: {
      asset: "host",
      direction: "upload",
      local_path: "@file.txt",
      remote_path: "/tmp/file.txt",
    },
    registry: assets,
    cwd: "/work",
    localPath(path, suppliedContext) {
      context = suppliedContext;
      assert.equal(path, "@file.txt");
      return "D:\\work\\file.txt";
    },
  });
  assert.equal(prepared.remoteArgs.local_path, "D:\\work\\file.txt");
  assert.deepEqual(context, { cwd: "/work", direction: "upload" });
});

test("SQL context is never guessed", async () => {
  const assets = registry();
  await assert.rejects(
    prepareHexHubInput({
      spec: spec("execute_sql"),
      params: { asset: "db:1", schema: "public", sql: "select 1" },
      registry: assets,
      cwd: "/tmp",
    }),
    /SQL db is required/,
  );
});

test("write adapters require evidence for the exact short asset/container/path key", async () => {
  const assets = registry();
  const evidence = new HexHubFileReadEvidence();
  const writeContext = {
    spec: spec("write"),
    params: { asset: "ssh:1", file_path: "/etc/app", content: "new" },
    registry: assets,
    cwd: "/tmp",
    evidence,
  };
  await assert.rejects(prepareHexHubInput(writeContext), /hexhub_read/);
  const read = await prepareHexHubInput({
    spec: spec("read"),
    params: { asset: "ssh:1", file_path: "/etc/app" },
    registry: assets,
    cwd: "/tmp",
    evidence,
  });
  evidence.mark(read.internal.fileKey!);
  const write = await prepareHexHubInput(writeContext);
  assert.equal(write.internal.fileKey, read.internal.fileKey);
});

test("keyed mutation queue serializes one target while allowing different targets", async () => {
  const queue = new KeyedMutationQueue();
  let sameActive = 0;
  let sameMax = 0;
  let differentOverlap = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue.run("same", async () => {
    sameActive += 1;
    sameMax = Math.max(sameMax, sameActive);
    await gate;
    sameActive -= 1;
  });
  const second = queue.run("same", async () => {
    sameActive += 1;
    sameMax = Math.max(sameMax, sameActive);
    sameActive -= 1;
  });
  const other = queue.run("other", async () => {
    differentOverlap = sameActive === 1;
  });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([first, second, other]);
  assert.equal(sameMax, 1);
  assert.equal(differentOverlap, true);
  assert.equal(queue.pendingKeys, 0);
});
