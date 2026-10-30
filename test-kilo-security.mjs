import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as pluginModule from "./kilo-security.mjs";

const managed = JSON.parse(await readFile(new URL("./managed-kilo.json", import.meta.url), "utf8"));
const legacy = JSON.parse(await readFile(new URL("./managed-settings.json", import.meta.url), "utf8"));
const environmentKeys = [
  "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "KILO_CONFIG", "KILO_CONFIG_DIR",
  "GOOGLE_APPLICATION_CREDENTIALS", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE",
  "KILO_CONTAINER_WORKSPACE", "CLOUDSDK_CONFIG", "KUBECONFIG", "KILO_TUI_CONFIG",
];

async function fixture(t, overrides = {}, workspaceCwd = false, context = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kilo-security-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const worktree = path.join(workspace, "kubevirt.io/repo");
  const directory = workspaceCwd ? workspace : path.join(worktree, "src");
  await mkdir(directory, { recursive: true });
  await mkdir(home);
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(root, "custom-config"),
    XDG_DATA_HOME: path.join(root, "custom-data"),
    KILO_CONFIG: path.join(root, "provider-config.json"),
    KILO_CONFIG_DIR: path.join(root, "kilo-config"),
    GOOGLE_APPLICATION_CREDENTIALS: path.join(root, "google.json"),
    AWS_CONFIG_FILE: path.join(root, "aws-config"),
    AWS_SHARED_CREDENTIALS_FILE: path.join(root, "aws-credentials"),
    CLOUDSDK_CONFIG: path.join(root, "external-gcloud"),
    KUBECONFIG: `:${path.join(root, "external-kube/first")}::${path.join(root, "other-kube/second")}:`,
    KILO_TUI_CONFIG: path.join(root, "external-tui/kilo.json"),
    KILO_CONTAINER_WORKSPACE: workspace,
    ...overrides,
  };
  const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  let hooks;
  try {
    for (const key of environmentKeys) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    hooks = await pluginModule.default({ worktree, directory, ...context });
  } finally {
    for (const key of environmentKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
  const config = {};
  await hooks.config(config);
  return {
    root, home, workspace, worktree, directory, env, config, hooks,
    call: (tool, args) => hooks["tool.execute.before"]({ tool, sessionID: "test", callID: "test" }, { args }),
  };
}

test("loader-safe default export and supported hook shape", async (t) => {
  assert.deepEqual(Object.keys(pluginModule), ["default"]);
  assert.equal(pluginModule.default.constructor.name, "AsyncFunction");
  const { hooks } = await fixture(t);
  assert.deepEqual(Object.keys(hooks), ["config", "tool.execute.before"]);
  assert.deepEqual(managed.plugin, ["file:///usr/local/share/kilo/kilo-security.mjs"]);
});

test("config replaces inherited permissions, tools and agent/mode overrides", async (t) => {
  const { hooks } = await fixture(t);
  const inherited = { bash: { "*": "allow", "git *": "allow" }, read: { "*": "allow" }, "evil_*": "allow" };
  const config = {
    permission: inherited,
    tools: { bash: true, edit: true },
    agent: {
      code: { prompt: "keep", permission: { "*": "allow" }, tools: { bash: true } },
      custom: { model: "provider/model", options: { keep: true }, permission: { edit: "allow" }, tools: { write: true } },
    },
    mode: { legacy: { description: "keep", tools: { bash: true }, permission: { bash: "allow" } } },
  };
  await hooks.config(config);
  assert.notEqual(config.permission, inherited);
  assert.equal(config.permission.bash, "ask");
  assert.equal(config.permission["evil_*"], undefined);
  assert.equal(config.tools, undefined);
  assert.deepEqual(config.agent.code, { prompt: "keep", permission: { semantic_search: "ask" } });
  assert.deepEqual(config.agent.custom, { model: "provider/model", options: { keep: true } });
  assert.deepEqual(config.mode.legacy, { description: "keep" });
  const policy = config.permission;
  policy.edit["inherited/*"] = "allow";
  await hooks.config(config);
  assert.notEqual(config.permission, policy);
  assert.equal(config.permission.edit["inherited/*"], undefined);
});

test("managed baseline and runtime policy agree; MCP allows are exact translations only", async (t) => {
  const { config } = await fixture(t);
  for (const [key, action] of Object.entries(managed.permission)) {
    if (["read", "edit", "external_directory"].includes(key)) continue;
    assert.equal(config.permission[key], action, key);
  }
  const expected = legacy.permissions.allow.filter((name) => name.startsWith("mcp__"))
    .map((name) => name.slice(5).replace("__", "_"));
  const actual = Object.keys(config.permission).filter((name) => /^(gopls|kubernetes)_/.test(name));
  assert.deepEqual(actual.sort(), expected.sort());
  for (const key of actual) assert.equal(config.permission[key], "allow");
  assert.equal(config.permission["*"], "ask");
  assert.equal(config.permission["gopls_*"], undefined);
  assert.equal(config.permission["kubernetes_*"], undefined);
  assert.equal(config.permission.kubernetes_resources_create, undefined);
  assert.equal(config.permission.gopls_go_rename_symbol, undefined);
  assert.equal(config.agent.code.permission.semantic_search, "ask");
});

test("privacy settings cannot be re-enabled; unrelated experimental and provider settings survive", async (t) => {
  const { hooks, config: defaults } = await fixture(t);
  assert.equal(managed.autoupdate, false);
  assert.equal(managed.share, "disabled");
  assert.equal(managed.experimental.openTelemetry, false);
  assert.equal(defaults.autoupdate, false);
  assert.equal(defaults.share, "disabled");
  assert.equal(defaults.experimental.openTelemetry, false);
  const provider = { example: { options: { baseURL: "https://example.invalid", apiKey: "synthetic" } } };
  const experimental = { codebase_search: true, custom: { keep: true } };
  const config = { model: "example/model", provider, experimental: { ...experimental } };
  for (const [autoupdate, share] of [[true, "auto"], ["notify", "manual"]]) {
    config.autoupdate = autoupdate;
    config.share = share;
    config.experimental.openTelemetry = true;
    await hooks.config(config);
    assert.equal(config.autoupdate, false);
    assert.equal(config.share, "disabled");
    assert.deepEqual(config.experimental, { ...experimental, openTelemetry: false });
    assert.equal(config.experimental.custom, experimental.custom);
    assert.equal(config.provider, provider);
    assert.equal(config.model, "example/model");
  }
});

test("native read and edit patterns are worktree-relative with specific rules last", async (t) => {
  const { config, worktree, env, home } = await fixture(t);
  const { permission } = config;
  assert.equal(permission.read["*"], "allow");
  assert.equal(permission.edit["*"], "ask");
  const scratch = path.relative(worktree, "/tmp/kilo");
  assert.equal(permission.edit[scratch], "allow");
  assert.equal(permission.edit[`${scratch}/*`], "allow");
  assert.deepEqual(permission.external_directory, { "*": "ask", "/tmp/kilo/*": "allow" });
  const roots = [
    ...[".ssh", ".tokens", ".config", ".aws", ".kube"].map((name) => path.join(home, name)),
    ...[".credentials.json", "settings.json", "settings.local.json"].map((name) => path.join(home, ".claude", name)),
    ...Object.entries(env).filter(([key, value]) => key !== "KUBECONFIG" && ![home, env.KILO_CONTAINER_WORKSPACE, env.XDG_DATA_HOME].includes(value)).map(([, value]) => value),
    ...env.KUBECONFIG.split(":").filter(Boolean),
    path.join(env.XDG_DATA_HOME, "kilo/auth.json"),
    path.join(env.XDG_DATA_HOME, "kilo/mcp-auth.json"),
    path.join(env.KILO_CONTAINER_WORKSPACE, "kubevirt.io/secrets"),
  ];
  for (const root of roots) {
    const relative = path.relative(worktree, root);
    assert.equal(permission.read[relative], "deny", root);
    assert.equal(permission.read[`${relative}/*`], "deny", root);
    assert.equal(permission.edit[relative], "deny", root);
    assert.equal(permission.edit[`${relative}/*`], "deny", root);
  }
  for (const root of ["/etc/kilo", "/usr/local/share/kilo"]) {
    assert.equal(permission.edit[path.relative(worktree, root)], "deny");
  }
  assert.equal(Object.keys(permission.edit)[0], "*");
});

test("scratch-root and nested worktrees allow scratch edits but ask beyond the normalized boundary", async (t) => {
  for (const [worktree, relativeScratch, outside] of [
    ["/tmp/kilo", "", ".."],
    ["/tmp/kilo/repo", "..", "../.."],
    ["/tmp/kilo/repo/src", "../..", "../../.."],
  ]) {
    // Only the plugin context points at scratch; the fixture creates no files there.
    const f = await fixture(t, {}, false, { worktree, directory: worktree });
    const edit = f.config.permission.edit;
    const prefix = [["*", "allow"]];
    if (relativeScratch) prefix.push([relativeScratch, "allow"], [`${relativeScratch}/*`, "allow"]);
    prefix.push([outside, "ask"], [`${outside}/*`, "ask"]);
    assert.deepEqual(Object.entries(edit).slice(0, prefix.length), prefix, worktree);
    assert.equal(edit[""], undefined);
    assert.equal(edit["/*"], undefined);
    assert.equal(path.relative(worktree, "/tmp/kilo"), relativeScratch);
    assert.equal(path.relative(worktree, "/tmp"), outside);

    // Native requests are normalized by path.relative before wildcard matching.
    assert.equal(path.relative(worktree, `${worktree}/ordinary.txt`), "ordinary.txt");
    for (const target of ["/tmp/kilo/peer.txt", "/tmp/kilo/repo/peer/file", "/tmp/kilo/other/file"]) {
      const requested = path.relative(worktree, target);
      assert.equal(requested === outside || requested.startsWith(`${outside}/`), false, target);
    }
    for (const [target, suffix] of [["/tmp", ""], ["/tmp/other/file", "/other/file"], ["/other/file", "/../other/file"]]) {
      const requested = path.relative(worktree, target);
      assert.equal(requested, `${outside}${suffix}`, target);
      assert.equal(requested === outside || requested.startsWith(`${outside}/`), true, target);
    }
    const keys = Object.keys(edit);
    const boundaryIndex = keys.indexOf(`${outside}/*`);
    for (const protectedRoot of [path.join(f.home, ".ssh"), "/etc/kilo", "/usr/local/share/kilo"]) {
      const relative = path.relative(worktree, protectedRoot);
      assert.equal(edit[relative], "deny");
      assert.equal(edit[`${relative}/*`], "deny");
      assert.ok(keys.indexOf(relative) > boundaryIndex);
      assert.ok(keys.indexOf(`${relative}/*`) > boundaryIndex);
    }
  }
});

test("guards protected paths for reads, writes and path-based searches", async (t) => {
  const f = await fixture(t);
  const targets = [
    ...[".ssh", ".tokens", ".config", ".aws", ".kube"].map((name) => path.join(f.home, name)),
    ...[".credentials.json", "settings.json", "settings.local.json"].map((name) => path.join(f.home, ".claude", name)),
    f.env.XDG_CONFIG_HOME, f.env.KILO_CONFIG, f.env.KILO_CONFIG_DIR,
    f.env.KILO_TUI_CONFIG, f.env.CLOUDSDK_CONFIG, ...f.env.KUBECONFIG.split(":").filter(Boolean),
    f.env.GOOGLE_APPLICATION_CREDENTIALS, f.env.AWS_CONFIG_FILE, f.env.AWS_SHARED_CREDENTIALS_FILE,
    path.join(f.env.XDG_DATA_HOME, "kilo/auth.json"),
    path.join(f.env.XDG_DATA_HOME, "kilo/mcp-auth.json"),
    path.join(f.workspace, "kubevirt.io/secrets"),
  ];
  for (const target of targets) {
    for (const tool of ["read", "edit", "write"]) {
      await assert.rejects(f.call(tool, { filePath: target }), /protected path/);
      await assert.rejects(f.call(tool, { filePath: path.relative(f.directory, path.join(target, "child")) }), /protected path/);
    }
    for (const tool of ["glob", "grep", "list", "semantic_search"]) {
      await assert.rejects(f.call(tool, { path: target, pattern: "*" }), /protected path/);
    }
    await assert.rejects(f.call("glob", { pattern: `${target}/**` }), /protected path/);
    await assert.rejects(f.call("glob", { path: path.relative(f.directory, target), pattern: "**" }), /protected path/);
  }
});

test("canonicalization denies symlink aliases, new descendants and changed symlinks", async (t) => {
  const f = await fixture(t);
  const protectedDir = path.join(f.home, ".ssh");
  await mkdir(protectedDir);
  await writeFile(path.join(protectedDir, "synthetic-key"), "not a credential");
  const alias = path.join(f.directory, "alias");
  await symlink(protectedDir, alias);
  for (const tool of ["read", "edit", "write"]) {
    await assert.rejects(f.call(tool, { filePath: "alias/synthetic-key" }), /protected path/);
    await assert.rejects(f.call(tool, { filePath: "alias/new/deep/file" }), /protected path/);
  }
  await assert.rejects(f.call("glob", { path: "alias", pattern: "**" }), /protected path/);
  await assert.rejects(f.call("grep", { path: "alias", pattern: "key" }), /protected path/);
  await rm(alias);
  await symlink(f.directory, alias);
  await f.call("read", { filePath: "alias/ordinary.txt" });
  await rm(alias);
  await symlink(protectedDir, alias);
  await assert.rejects(f.call("read", { filePath: "alias/ordinary.txt" }), /protected path/);
});

test("recursive search roots cannot encompass protected descendants", async (t) => {
  const f = await fixture(t);
  for (const tool of ["glob", "grep", "list", "semantic_search"]) {
    await assert.rejects(f.call(tool, { path: f.workspace, pattern: "**" }), /protected path/);
    await assert.rejects(f.call(tool, { path: f.home, pattern: "**" }), /protected path/);
    await assert.rejects(f.call(tool, { path: "/", pattern: "**" }), /protected path/);
  }
  await symlink(f.workspace, path.join(f.directory, "workspace-alias"));
  await assert.rejects(f.call("grep", { path: "workspace-alias", pattern: "secret" }), /protected path/);
  await assert.rejects(f.call("glob", { pattern: `${f.workspace}/**` }), /protected path/);
  await assert.rejects(f.call("glob", { path: "workspace-alias", pattern: "**" }), /protected path/);
});

test("absolute glob bases stop before wildcard-bearing components, not at literal prefixes", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.home, ".ssh"));
  await mkdir(path.join(f.home, ".config"));
  await symlink(f.home, path.join(f.directory, "home-alias"));
  await symlink(path.join(f.home, ".ssh"), path.join(f.directory, "ssh-alias"));
  for (const pattern of [
    `${f.home}/.ss*/**`, `${f.home}/.con*/**`, `${f.home}/.ss?/**`,
    `${f.home}/.con[fi]*/**`, `${f.home}/{.ssh,.config}/**`,
    `${f.home}/.claude/settings*.json`, `${f.directory}/home-alias/.ss*/**`,
    `${f.directory}/home-alias/.con*/**`, `${f.directory}/ssh-alias/**`,
    `${f.directory}/ssh-alias`, `${f.home}/.ssh`, `${f.home}/.config/`,
    "/*.md",
  ]) {
    await assert.rejects(f.call("glob", { pattern }), /protected path/, pattern);
    // An explicit safe path is ignored by native glob for absolute patterns.
    await assert.rejects(f.call("glob", { path: f.directory, pattern }), /protected path/, pattern);
  }
  // Native splitting is not escape-aware: backslashes become path separators.
  await f.call("glob", { pattern: `${f.home}/.ss\\*/**` });
  await assert.rejects(f.call("glob", { pattern: `${f.home}/.ssh\\*/**` }), /protected path/);
  await assert.rejects(f.call("glob", { pattern: `${f.home}/.con*/**`.replaceAll("/", "\\") }), /protected path/);
});

test("safe absolute glob bases ignore unused protected cwd and explicit path", async (t) => {
  const f = await fixture(t, {}, true);
  const safe = path.join(f.worktree, "src");
  await mkdir(safe, { recursive: true });
  await symlink(safe, path.join(f.workspace, "safe-alias"));
  await assert.rejects(f.call("glob", { pattern: "**" }), /protected path/);
  for (const pattern of [
    `${safe}/*.mjs`, `${safe}/f*.mjs`, `${safe}/**`, safe, `${safe}/`,
    `${f.worktree}/src*/**`, `${f.workspace}/safe-alias/*.mjs`,
    `${safe}/*.mjs`.replaceAll("/", "\\"),
  ]) {
    await f.call("glob", { pattern });
    await f.call("glob", { path: f.home, pattern });
  }
  // Relative patterns do not narrow native cwd, even with a literal prefix.
  await assert.rejects(f.call("glob", { pattern: "kubevirt.io/repo/src/*.mjs" }), /protected path/);
  await assert.rejects(f.call("glob", { pattern: "kubevirt.io/repo/src" }), /protected path/);
  await f.call("glob", { path: "kubevirt.io/repo", pattern: "src/*.mjs" });
  await f.call("glob", { path: safe, pattern: "*.mjs" });
});

test("relative glob patterns use explicit path or cwd without reinterpreting pattern components", async (t) => {
  const f = await fixture(t);
  await symlink(f.home, path.join(f.directory, "home-alias"));
  for (const pattern of [".ss*/**", ".con*/**", ".ssh", "nested/*.mjs"]) {
    await assert.rejects(f.call("glob", { path: f.home, pattern }), /protected path/);
    await assert.rejects(f.call("glob", { path: "home-alias", pattern }), /protected path/);
    await assert.rejects(f.call("glob", { path: path.relative(f.directory, f.home), pattern }), /protected path/);
    await f.call("glob", { pattern });
    await f.call("glob", { path: ".", pattern });
  }
});

test("external credential mounts and Claude settings deny aliases and recursive parent searches", async (t) => {
  const f = await fixture(t);
  const targets = [
    path.join(f.env.CLOUDSDK_CONFIG, "credentials.db"),
    ...f.env.KUBECONFIG.split(":").filter(Boolean),
    f.env.KILO_TUI_CONFIG,
    ...[".credentials.json", "settings.json", "settings.local.json"].map((name) => path.join(f.home, ".claude", name)),
  ];
  for (const [index, target] of targets.entries()) {
    const alias = path.join(f.directory, `credential-alias-${index}`);
    await symlink(target, alias);
    for (const tool of ["read", "edit", "write"]) {
      await assert.rejects(f.call(tool, { filePath: alias }), /protected path/);
    }
    for (const tool of ["glob", "grep", "list", "semantic_search"]) {
      await assert.rejects(f.call(tool, { path: path.dirname(target), pattern: "**" }), /protected path/);
    }
    await assert.rejects(f.call("glob", { pattern: `${path.dirname(target)}/**` }), /protected path/);
    await assert.rejects(f.call("apply_patch", { patchText: `*** Begin Patch\n*** Delete File: ${alias}\n*** End Patch` }), /protected path/);
  }
  // Empty KUBECONFIG entries must not protect the entire tool working directory.
  await f.call("read", { filePath: "ordinary.txt" });
  await f.call("grep", { path: f.directory, pattern: "ordinary" });
  await f.call("read", { filePath: path.join(f.home, ".claude/skills/example/SKILL.md") });
});

test("unset and empty optional credential environment values do not protect ordinary paths", async (t) => {
  for (const value of [undefined, "", "::"]) {
    const f = await fixture(t, { KUBECONFIG: value, CLOUDSDK_CONFIG: undefined, KILO_TUI_CONFIG: undefined });
    await f.call("read", { filePath: "ordinary.txt" });
    await f.call("write", { filePath: "ordinary.txt" });
    await f.call("grep", { path: f.directory, pattern: "ordinary" });
    assert.equal(f.config.permission.read[""], undefined);
    assert.equal(f.config.permission.edit[""], undefined);
  }
});

test("protected roots that are themselves symlinks also protect the real path", async (t) => {
  const f = await fixture(t);
  const real = path.join(f.root, "real-keys");
  await mkdir(real);
  await symlink(real, path.join(f.home, ".ssh"));
  await assert.rejects(f.call("read", { filePath: path.join(real, "new") }), /protected path/);
  await f.hooks.config(f.config);
  assert.equal(f.config.permission.read[path.relative(f.worktree, real)], "deny");
});

test("dangling protected aliases and symlink loops fail closed", async (t) => {
  const f = await fixture(t);
  await symlink(path.join(f.home, ".ssh"), path.join(f.directory, "dangling"));
  await assert.rejects(f.call("write", { filePath: "dangling/new/deep/file" }), /protected path/);
  await symlink("loop", path.join(f.directory, "loop"));
  await assert.rejects(f.call("read", { filePath: "loop/file" }), /ELOOP|too many symlinks/);
  await writeFile(path.join(f.directory, "file"), "synthetic data");
  await f.call("read", { filePath: "file/not-a-directory" });
});

test("scratch symlinks cannot turn automatic edits into writes elsewhere", async (t) => {
  const f = await fixture(t);
  let created = false;
  try {
    await mkdir("/tmp/kilo");
    created = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const temporary = await mkdtemp("/tmp/kilo/security-test-");
  t.after(async () => {
    await rm(temporary, { recursive: true, force: true });
    if (created) await rmdir("/tmp/kilo").catch((error) => {
      if (error.code !== "ENOTEMPTY") throw error;
    });
  });
  await symlink(f.directory, path.join(temporary, "outside"));
  for (const tool of ["edit", "write"]) {
    await assert.rejects(f.call(tool, { filePath: path.join(temporary, "outside/new") }), /scratch symlink escapes/);
    await f.call(tool, { filePath: path.join(temporary, "ordinary/new") });
  }
  await assert.rejects(f.call("apply_patch", {
    patchText: `*** Begin Patch\n*** Add File: ${temporary}/outside/new\n+test\n*** End Patch`,
  }), /scratch symlink escapes/);
  await f.call("apply_patch", {
    patchText: `*** Begin Patch\n*** Update File: ${temporary}/source\n*** Move to: ${temporary}/destination\n*** End Patch`,
  });
});

test("workspace fallback and default Kilo data directory remain protected", async (t) => {
  const f = await fixture(t, { KILO_CONTAINER_WORKSPACE: undefined, XDG_DATA_HOME: undefined });
  await assert.rejects(f.call("read", { filePath: path.join(f.worktree, "kubevirt.io/secrets/file") }), /protected path/);
  for (const file of ["auth.json", "mcp-auth.json"]) {
    await assert.rejects(f.call("read", { filePath: path.join(f.home, ".local/share/kilo", file) }), /protected path/);
  }
});

test("apply_patch checks every add/update/delete/rename header including CRLF and relative aliases", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.home, ".tokens"));
  await symlink(path.join(f.home, ".tokens"), path.join(f.directory, "token-alias"));
  for (const operation of ["Add File", "Update File", "Delete File", "Move to"]) {
    const header = `*** ${operation}: token-alias/new/file`;
    await assert.rejects(f.call("apply_patch", { patchText: `*** Begin Patch\r\n*** Update File: normal.txt\r\n${header}\r\n*** End Patch` }), /protected path/);
  }
  for (const target of ["/etc/kilo/kilo.json", "/usr/local/share/kilo/kilo-security.mjs"]) {
    await assert.rejects(f.call("apply_patch", { patchText: `*** Begin Patch\n*** Update File: normal.txt\n*** Move to: ${target}\n*** End Patch` }), /protected path/);
  }
  await assert.rejects(f.call("apply_patch", { patchText: `*** Begin Patch\n*** Update File: /tmp/kilo/source\n*** Move to: ${f.directory}/destination\n*** End Patch` }), /scratch rename/);
  await f.call("apply_patch", { patchText: "*** Begin Patch\n*** Update File: normal.txt\n*** Move to: renamed.txt\n@@\n-old\n+new\n*** End Patch" });
  await f.call("apply_patch", { patchText: "*** Begin Patch\n*** Add File: /tmp/kilo/new\n+test\n*** End Patch" });
});

test("managed policy writes and symlink aliases are denied; direct reads remain allowed", async (t) => {
  const f = await fixture(t);
  for (const root of ["/etc/kilo", "/usr/local/share/kilo"]) {
    await f.call("read", { filePath: `${root}/policy.json` });
    await symlink(root, path.join(f.directory, "policy-alias"));
    for (const tool of ["edit", "write"]) {
      await assert.rejects(f.call(tool, { filePath: `${root}/policy.json` }), /protected path/);
      await assert.rejects(f.call(tool, { filePath: "policy-alias/new.json" }), /protected path/);
    }
    await rm(path.join(f.directory, "policy-alias"));
  }
});

test("ordinary operations pass the guard without changing native approval policy", async (t) => {
  const f = await fixture(t);
  for (const tool of ["read", "edit", "write"]) {
    await f.call(tool, { filePath: "ordinary.txt" });
    await f.call(tool, { filePath: "/tmp/kilo/ordinary.txt" });
  }
  for (const tool of ["glob", "grep", "list", "semantic_search"]) {
    await f.call(tool, { pattern: "*.mjs" });
    await f.call(tool, { path: ".", pattern: "*.mjs" });
  }
  await f.call("glob", { path: "..", pattern: "src/*.mjs" });
  await f.call("read", { filePath: `${f.home}/.ssh-not-secret/file` });
  await f.call("kubernetes_resources_create", { path: f.home });
  assert.equal(f.config.permission.bash, "ask");
  assert.equal(f.config.permission.task, "ask");
  assert.equal(f.config.permission.semantic_search, "ask");
  assert.equal(f.config.permission.edit["*"], "ask");
});

test("known dangerous shell spellings are denied, including flag and compound variants", async (t) => {
  const { call } = await fixture(t);
  for (const command of [
    "sudo true", "/usr/bin/sudo -n true", "env sudo --user=root id", "true && sudo id",
    "su\\do id", "'sudo' id", "rm -rf /", "rm -fr /*", "rm --recursive --force -- /",
    "/bin/rm -r -f /./", "true; rm -rf /**", "git push origin main", "git push -f origin main",
    "git push --force origin main", "git push --force-with-lease origin main",
    "git -C /tmp/repo push --atomic --all origin", "git push --repo=origin main",
    "git push --repo origin main", "true | /usr/bin/git push origin main", "true\ngit push origin main",
    "git -c foo=bar push 'origin' main", "cp file /etc/kilo/kilo.json",
    "printf x > /usr/local/share/kilo/kilo-security.mjs",
    "printf '%s' $(sudo id)", "printf '%s' $(git push origin main)", "sudo id > output.txt",
  ]) {
    await assert.rejects(call("bash", { command }), /Managed Kilo policy/, command);
  }
});

test("normal shell commands are not auto-allowed or rejected", async (t) => {
  const { call, config } = await fixture(t);
  for (const command of [
    "git status", "git diff", "git push fork main", "git -C /tmp/repo push --force-with-lease fork main",
    "rm -rf /tmp/kilo/old", "npm test", "node --test", "printf 'hello world'", "true && git status",
    "git log --oneline", "echo https://github.com/org/repo", "git status; npm test",
    "git status > status.txt", "printf x >> output.txt", "wc -l < input.txt",
    "printf '%s' $(git status)", "git status | wc -l", "printf x > output.txt | wc -c",
  ]) {
    await call("bash", { command });
    assert.equal(config.permission.bash, "ask", command);
  }
});
