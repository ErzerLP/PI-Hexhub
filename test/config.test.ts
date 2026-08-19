import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_HEXHUB_CONFIG,
  loadHexHubConfig,
  normalizeHexHubUrl,
  parseHexHubToolGroups,
  resolveHexHubAuthHeaders,
  saveGlobalHexHubConfig,
  summarizeHexHubConfig,
} from "../extensions/hexhub/config.js";
import { runHexHubConfigCommand } from "../extensions/hexhub/config-ui.js";
import type {
  HexHubConfig,
  LoadedHexHubConfig,
} from "../extensions/hexhub/contracts.js";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-hexhub-config-"));
}

function loaded(
  config: HexHubConfig,
  root = "/tmp/hexhub-test",
): LoadedHexHubConfig {
  return {
    config,
    globalPath: join(root, "agent", "hexhub.json"),
    projectPath: join(root, ".pi", "hexhub.json"),
    globalLoaded: true,
    projectLoaded: false,
    deprecatedKeys: [],
  };
}

test("normalizes root URLs and rejects unsafe endpoints", () => {
  assert.equal(
    normalizeHexHubUrl("http://127.0.0.1:17321"),
    "http://127.0.0.1:17321/mcp",
  );
  assert.equal(
    normalizeHexHubUrl("https://example.test/base/#fragment"),
    "https://example.test/base/mcp",
  );
  assert.throws(
    () => normalizeHexHubUrl("ftp://example.test"),
    /http or https/,
  );
  assert.throws(
    () => normalizeHexHubUrl("http://user:secret@example.test"),
    /credentials/,
  );
});

test("loads environment fallback and only trusted project behavior overrides", async (t) => {
  const root = await temporaryDirectory();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(projectDir, ".pi"), { recursive: true });
  await writeFile(
    join(agentDir, "hexhub.json"),
    JSON.stringify({
      version: 1,
      url: "https://global.example/mcp",
      transport: "direct",
      timeoutMs: 4_000,
      auth: { type: "env", env: "GLOBAL_TOKEN", header: "authorization" },
      initialGroups: ["shell"],
    }),
  );
  await writeFile(
    join(projectDir, ".pi", "hexhub.json"),
    JSON.stringify({
      version: 1,
      url: "http://attacker.invalid/mcp",
      auth: { type: "token", token: "project-secret" },
      transport: "windows-helper",
      initialGroups: ["database-meta", "shell", "database-meta"],
    }),
  );

  const untrusted = await loadHexHubConfig({
    cwd: projectDir,
    agentDir,
    projectTrusted: false,
    env: { HEXHUB_MCP_URL: "https://env.example" },
  });
  assert.equal(untrusted.projectLoaded, false);
  assert.equal(untrusted.config.url, "https://global.example/mcp");
  assert.deepEqual(untrusted.config.initialGroups, ["shell"]);

  const trusted = await loadHexHubConfig({
    cwd: projectDir,
    agentDir,
    projectTrusted: true,
    env: {},
  });
  assert.equal(trusted.config.url, "https://global.example/mcp");
  assert.equal(trusted.config.transport, "direct");
  assert.deepEqual(trusted.config.auth, {
    type: "env",
    env: "GLOBAL_TOKEN",
    header: "authorization",
  });
  assert.deepEqual(trusted.config.initialGroups, ["database-meta", "shell"]);
  assert.deepEqual(trusted.deprecatedKeys.sort(), [
    "project.auth",
    "project.transport",
    "project.url",
  ]);
});

test("uses environment defaults when no file exists", async (t) => {
  const root = await temporaryDirectory();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const result = await loadHexHubConfig({
    cwd: root,
    agentDir: join(root, "agent"),
    env: {
      HEXHUB_MCP_URL: "https://env.example",
      HEXHUB_TRANSPORT: "windows-helper",
      HEXHUB_TIMEOUT_MS: "2500",
      HEXHUB_TOKEN: "not-materialized",
      HEXHUB_AUTH_HEADER: "x-hexhub-mcp-token",
      HEXHUB_INITIAL_GROUPS: "files-read,shell",
    },
  });
  assert.equal(result.config.url, "https://env.example/mcp");
  assert.equal(result.config.transport, "windows-helper");
  assert.equal(result.config.timeoutMs, 2500);
  assert.deepEqual(result.config.auth, {
    type: "env",
    env: "HEXHUB_TOKEN",
    header: "x-hexhub-token",
  });
  assert.deepEqual(result.config.initialGroups, ["files-read", "shell"]);
});

test("resolves auth headers while summaries redact plaintext tokens", () => {
  const config: HexHubConfig = {
    ...DEFAULT_HEXHUB_CONFIG,
    auth: { type: "token", token: "very-secret", header: "authorization" },
    initialGroups: [],
  };
  assert.deepEqual(resolveHexHubAuthHeaders(config), {
    Authorization: "Bearer very-secret",
  });
  const serialized = JSON.stringify(summarizeHexHubConfig(config));
  assert.doesNotMatch(serialized, /very-secret/);
  assert.match(serialized, /\[redacted\]/);

  assert.deepEqual(
    resolveHexHubAuthHeaders(
      {
        auth: { type: "env", env: "TOKEN", header: "x-hexhub-token" },
      },
      { TOKEN: "env-secret" },
    ),
    { "X-HexHub-MCP-Token": "env-secret" },
  );
  assert.deepEqual(parseHexHubToolGroups(""), []);
});

test("writes global config atomically with private POSIX permissions", async (t) => {
  const root = await temporaryDirectory();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const agentDir = join(root, "agent");
  const config: HexHubConfig = {
    ...DEFAULT_HEXHUB_CONFIG,
    auth: { type: "none" },
    initialGroups: ["shell"],
  };
  const path = await saveGlobalHexHubConfig(config, {
    agentDir,
    cwd: root,
    env: {},
  });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), config);
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(agentDir)).mode & 0o777, 0o700);
  }
  await assert.rejects(readFile(agentDir, "utf8"));
});

test("wizard saves and awaits runtime reload; slash arguments cannot contain secrets", async () => {
  const original: HexHubConfig = {
    ...DEFAULT_HEXHUB_CONFIG,
    auth: { type: "none" },
    initialGroups: [],
  };
  const events: string[] = [];
  const inputValues = ["https://hexhub.example", "4500", "shell,files-read"];
  const selectValues = ["direct", "No authentication"];
  let savedConfig: HexHubConfig | undefined;
  const notices: string[] = [];
  const ctx = {
    cwd: "/tmp/project",
    hasUI: true,
    isProjectTrusted: () => true,
    ui: {
      input: async () => inputValues.shift(),
      select: async () => selectValues.shift(),
      confirm: async () => true,
      notify: (message: string) => notices.push(message),
    },
  };
  await runHexHubConfigCommand("", ctx, {
    load: async () => loaded(savedConfig ?? original),
    save: async (config) => {
      events.push("save");
      savedConfig = config;
      return loaded(config);
    },
    reload: async (value) => {
      assert.equal(value.config.url, "https://hexhub.example/mcp");
      events.push("reload-start");
      await Promise.resolve();
      events.push("reload-end");
    },
  });
  assert.deepEqual(events, ["save", "reload-start", "reload-end"]);
  assert.equal(savedConfig?.transport, "direct");
  assert.deepEqual(savedConfig?.initialGroups, ["shell", "files-read"]);

  await runHexHubConfigCommand("token super-secret", ctx, {
    load: async () => {
      throw new Error("must not load");
    },
    reload: async () => undefined,
  });
  assert.equal(
    notices.some((message) => message.includes("super-secret")),
    false,
  );
  assert.match(notices.at(-1) ?? "", /Usage/);
});

test("wizard rejects remote HTTP before saving or probing for secrets", async () => {
  const notices: string[] = [];
  let reloaded = false;
  const ctx = {
    cwd: "/tmp/project",
    hasUI: true,
    isProjectTrusted: () => true,
    ui: {
      input: async () => "http://hexhub.example/mcp",
      select: async () => {
        throw new Error("transport selection must not run");
      },
      confirm: async () => {
        throw new Error("remote HTTP must not be confirmable");
      },
      notify: (message: string) => notices.push(message),
    },
  };

  await runHexHubConfigCommand("", ctx, {
    load: async () => loaded(DEFAULT_HEXHUB_CONFIG as HexHubConfig),
    reload: async () => {
      reloaded = true;
    },
  });

  assert.equal(reloaded, false);
  assert.match(notices.at(-1) ?? "", /must use HTTPS/);
});
