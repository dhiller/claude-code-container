// Run only inside the built image, with --network=none and this file mounted ro.
// This inspects configuration, not tool hooks or model execution. Native saved
// approvals/session overrides can still turn an ask into allow; fresh state here
// deliberately does not claim to test or prevent that behavior.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const managedFile = "/etc/kilo/kilo.json";
const pluginFile = "/usr/local/share/kilo/kilo-security.mjs";
const marker = "synthetic-not-a-secret";
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), 90_000);
const interrupt = () => controller.abort();
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
let root;
let scratchProject;
let child;
let exited;

// Match the API's ordered rules, using Kilo's last-match-wins convention.
// No permission endpoint, session, prompt, model or tool is invoked.
function effective(rules, permission, target) {
  const matches = (value, pattern) => {
    let expression = pattern.replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*").replace(/\?/g, ".");
    if (expression.endsWith(" .*")) expression = expression.slice(0, -3) + "( .*)?";
    return new RegExp(`^${expression}$`, "s").test(value.replaceAll("\\", "/"));
  };
  return rules.findLast((rule) => matches(permission, rule.permission) && matches(target, rule.pattern))?.action ?? "ask";
}

try {
  assert.ok(process.platform === "linux" && process.getuid() !== 0 && process.geteuid() !== 0,
    "run as the image's nonroot user on Linux");
  const status = await readFile("/proc/self/status", "utf8");
  assert.ok(/^CapEff:\s+0+$/m.test(status), "run with --cap-drop=all");
  assert.ok(/^NoNewPrivs:\s+1$/m.test(status), "run with --security-opt=no-new-privileges");

  // Checking ancestors matters: a read-only file inside a writable directory
  // could otherwise be replaced, and a writable ancestor could shadow its tree.
  const protectedPaths = new Set([managedFile, pluginFile]);
  for (const file of [managedFile, pluginFile]) {
    for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
      protectedPaths.add(parent);
      if (parent === "/") break;
    }
  }
  for (const target of protectedPaths) {
    const stat = await lstat(target);
    assert.ok(stat.uid === 0 && !(stat.mode & 0o022) && !stat.isSymbolicLink(),
      `managed path must be root-owned, not group/other writable or a symlink: ${target}`);
    assert.ok(await realpath(target) === target, `managed path must not redirect: ${target}`);
    await assert.rejects(access(target, constants.W_OK),
      (error) => ["EACCES", "EPERM", "EROFS"].includes(error.code),
      `current nonroot process must not replace or shadow: ${target}`);
  }
  const managed = JSON.parse(await readFile(managedFile, "utf8"));
  assert.ok(managed.plugin?.includes(`file://${pluginFile}`), "image config must load the image plugin");
  console.log("ok: image policy and ancestors are root-owned and inaccessible for writes");

  root = await mkdtemp("/tmp/kilo-container-test-");
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const xdg = Object.fromEntries(["CONFIG", "DATA", "STATE", "CACHE", "RUNTIME"].map((name) =>
    [`XDG_${name}_HOME`, path.join(root, name.toLowerCase())]));
  // XDG runtime uses DIR rather than HOME.
  xdg.XDG_RUNTIME_DIR = xdg.XDG_RUNTIME_HOME;
  delete xdg.XDG_RUNTIME_HOME;
  const externalFile = path.join(root, "external-provider.json");
  const configDirectory = path.join(xdg.XDG_CONFIG_HOME, "kilo");
  for (const directory of [home, project, configDirectory, ...Object.values(xdg)]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const permissive = (source) => ({
    permission: { "*": "allow", bash: { "*": "allow", [`${source}-only *`]: "allow" }, edit: "allow" },
    tools: { bash: true, read: true, edit: true, semantic_search: true },
    agent: {
      code: { permission: { "*": "allow", semantic_search: "allow" }, tools: { bash: true, semantic_search: true } },
      [`${source}-bypass`]: {
        description: `synthetic ${source} agent`,
        permission: { "*": "allow", bash: { "*": "allow", [`${source}-agent *`]: "allow" }, edit: "allow" },
        tools: { bash: true, read: true, edit: true, semantic_search: true },
      },
    },
  });
  await writeFile(path.join(configDirectory, "kilo.json"), JSON.stringify(permissive("global")));
  await writeFile(path.join(project, "kilo.json"), JSON.stringify(permissive("project")));
  await writeFile(externalFile, JSON.stringify({
    ...permissive("external"),
    provider: {
      "integration-marker": {
        name: "Synthetic provider configuration, never enabled",
        options: { apiKey: "{env:SYNTHETIC_KILO_PROVIDER_KEY}", baseURL: "http://127.0.0.1:9" },
      },
    },
  }));

  // Avoid Kilo's automatic config-directory package installation. The managed
  // file plugin has no dependencies, so no package contents are needed here.
  await mkdir(path.join(configDirectory, "node_modules"));
  await writeFile(path.join(configDirectory, "package.json"), JSON.stringify({ private: true }));
  await writeFile(path.join(configDirectory, "package-lock.json"), JSON.stringify({
    lockfileVersion: 3, packages: { "": { dependencies: { "@kilocode/plugin": "synthetic" } } },
  }));

  // Deliberately do not inherit process.env, including proxy, auth, injected
  // runtimes, pure mode, managed-dir overrides and the caller's HOME/XDG paths.
  const env = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    ...xdg,
    KILO_DB: ":memory:",
    KILO_DISABLE_MODELS_FETCH: "1",
    KILO_DISABLE_DEFAULT_PLUGINS: "1",
    KILO_DISABLE_CLAUDE_CODE: "1",
    KILO_DISABLE_EXTERNAL_SKILLS: "1",
    KILO_DISABLE_AUTOUPDATE: "1",
    KILO_CONFIG: externalFile,
    CLOUDSDK_CONFIG: path.join(root, "gcloud"),
    KUBECONFIG: `${path.join(root, "kube-one")}:${path.join(root, "kube-two")}`,
    KILO_CONFIG_CONTENT: JSON.stringify({
      ...permissive("inline"),
      enabled_providers: [],
      snapshot: false,
      autoupdate: true,
      share: "auto",
      experimental: { openTelemetry: true },
    }),
    SYNTHETIC_KILO_PROVIDER_KEY: marker,
    // Defense in depth if a future loader tries to install a dependency.
    npm_config_offline: "true",
    npm_config_registry: "http://127.0.0.1:9",
  };
  const git = spawnSync("git", ["init", "--quiet", "--template=", project], {
    cwd: root, env, stdio: "ignore", timeout: 5_000,
  });
  assert.ok(!git.error && git.status === 0, "initialize only the synthetic git repository");

  child = spawn("kilo", ["serve", "--hostname", "127.0.0.1", "--port", "0", "--no-mdns"], {
    cwd: project, env, stdio: ["ignore", "pipe", "pipe"], detached: false,
  });
  exited = new Promise((resolve) => child.once("exit", resolve));
  // Drain but never print server logs, which might contain configuration data.
  child.stderr.resume();
  const origin = await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => finish(new Error("server startup timed out")), 30_000);
    const abort = () => finish(new Error("container test interrupted or timed out"));
    const onExit = () => finish(new Error("server exited before announcing its listener"));
    const onError = () => finish(new Error("could not spawn image kilo executable"));
    const onData = (chunk) => {
      output = (output + chunk.toString("utf8")).slice(-16_384);
      // --port 0 lets Kilo bind atomically (4096 preferred, ephemeral fallback).
      // Never probe a guessed port or accept a non-loopback listener URL.
      const match = /kilo server listening on (http:\/\/127\.0\.0\.1:(\d+))\/?[ \t]*\r?\n/.exec(output);
      if (match && Number(match[2]) > 0 && Number(match[2]) <= 65535) finish(null, match[1]);
    };
    function finish(error, value) {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", abort);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stdout.off("data", onData);
      if (error) reject(error);
      else resolve(value);
    }
    child.once("error", onError);
    child.once("exit", onExit);
    child.stdout.on("data", onData);
    controller.signal.addEventListener("abort", abort, { once: true });
    if (controller.signal.aborted) abort();
  });
  child.stdout.resume();
  const get = async (endpoint, directory = project) => {
    const url = new URL(endpoint, origin);
    url.searchParams.set("directory", directory);
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
    });
    assert.ok(response.ok, `${endpoint} must return success (HTTP ${response.status})`);
    return response.json();
  };
  const paths = await get("/path");
  assert.ok(paths.home === home && paths.directory === project && paths.worktree === project,
    "/path must identify only the synthetic HOME, directory and git worktree");
  assert.ok(paths.config === configDirectory && paths.state === path.join(xdg.XDG_STATE_HOME, "kilo"),
    "/path must use synthetic XDG configuration and state");

  const config = await get("/config");
  assert.ok(config.enabled_providers?.length === 0 && Array.isArray(config.enabled_providers), "no provider may be enabled");
  assert.ok(config.snapshot === false && config.experimental?.openTelemetry === false, "snapshots and telemetry must be disabled");
  assert.ok(config.autoupdate === false && config.share === "disabled", "managed privacy and version settings must override inline values");
  assert.ok(config.provider?.["integration-marker"]?.options?.apiKey === marker,
    "non-default external provider config must survive and interpolate the fake environment marker");
  assert.ok(config.provider["integration-marker"].options.baseURL === "http://127.0.0.1:9", "synthetic provider URL must survive");
  assert.ok(config.permission?.bash === "ask" && config.tools === undefined, "top-level bash and legacy tool bypass must be replaced");
  const secret = path.relative(paths.worktree, path.join(home, ".ssh"));
  const scratch = path.relative(paths.worktree, "/tmp/kilo");
  assert.ok(config.permission.read?.[`${secret}/*`] === "deny", "plugin must generate dynamic synthetic HOME read deny");
  assert.ok(config.permission.edit?.[`${scratch}/*`] === "allow", "plugin must generate worktree-relative scratch edit allow");
  for (const source of ["global", "external", "project", "inline"]) {
    const agent = config.agent?.[`${source}-bypass`];
    assert.ok(agent?.description === `synthetic ${source} agent`, `${source} config must actually load`);
    assert.ok(agent.permission === undefined && agent.tools === undefined, `${source} custom agent bypass must be removed`);
  }
  console.log("ok: managed plugin initialized; all conflicting config layers loaded; fake provider data preserved");

  const agents = await get("/agent");
  assert.ok(Array.isArray(agents), "/agent must expose effective agents with ordered rules");
  for (const name of ["code", "global-bypass", "external-bypass", "project-bypass", "inline-bypass"]) {
    const agent = agents.find((item) => item.name === name);
    assert.ok(agent && Array.isArray(agent.permission) && agent.permission.length > 0, `${name} must have effective rules`);
    const rules = agent.permission;
    assert.ok(rules.every((rule) => typeof rule.permission === "string" && typeof rule.pattern === "string"
      && ["allow", "ask", "deny"].includes(rule.action)), `${name} rule shape must be understood`);
    for (const source of ["global", "external", "project", "inline"]) {
      assert.ok(!rules.some((rule) => rule.permission === "bash"
        && [`${source}-only *`, `${source}-agent *`].includes(rule.pattern)), `${name}: inherited bash patterns must be removed`);
      assert.ok(effective(rules, "bash", `${source}-only harmless`) === "ask", `${name}: specific inherited bash allow must not win`);
    }
    assert.ok(effective(rules, "bash", "git status") === "ask", `${name}: managed bash ask must beat native allowlists`);
    assert.ok(effective(rules, "read", `${secret}/synthetic-key`) === "deny", `${name}: dynamic read deny must win in effective rule order`);
    for (const target of [xdg.XDG_CONFIG_HOME, externalFile,
      env.CLOUDSDK_CONFIG, ...env.KUBECONFIG.split(":"),
      path.join(home, ".claude/.credentials.json"),
      path.join(xdg.XDG_DATA_HOME, "kilo/auth.json"), path.join(xdg.XDG_DATA_HOME, "kilo/mcp-auth.json")]) {
      assert.ok(effective(rules, "read", path.relative(paths.worktree, target)) === "deny", `${name}: synthetic config/auth paths must be denied`);
    }
    assert.ok(effective(rules, "read", "ordinary.txt") === "allow", `${name}: ordinary reads remain allowed`);
    assert.ok(effective(rules, "edit", `${scratch}/synthetic.txt`) === "allow", `${name}: relative scratch allow must win`);
    assert.ok(effective(rules, "edit", "ordinary.txt") === "ask", `${name}: ordinary edits must ask`);
    for (const target of [managedFile, pluginFile]) {
      assert.ok(effective(rules, "edit", path.relative(paths.worktree, target)) === "deny", `${name}: managed policy edits must be denied`);
    }
    assert.ok(effective(rules, "semantic_search", "*") === "ask", `${name}: semantic_search must ask after native agent defaults`);
    assert.ok(effective(rules, "synthetic_unknown_tool", "*") === "ask", `${name}: custom wildcard allow must not survive`);
  }
  console.log("ok: effective agent rule order enforces read deny, scratch allow, bash ask and semantic_search ask");
  await mkdir("/tmp/kilo", { recursive: true });
  scratchProject = await mkdtemp("/tmp/kilo/policy-project-");
  const scratchGit = spawnSync("git", ["init", "--quiet", "--template=", scratchProject], {
    env, stdio: "ignore", timeout: 5_000,
  });
  assert.ok(!scratchGit.error && scratchGit.status === 0, "initialize only the synthetic scratch repository");
  const scratchAgents = await get("/agent", scratchProject);
  const scratchCode = scratchAgents.find((agent) => agent.name === "code");
  assert.ok(scratchCode && Array.isArray(scratchCode.permission), "scratch repository must have effective code rules");
  assert.ok(effective(scratchCode.permission, "edit", "local.txt") === "allow", "scratch-local edits must be allowed");
  assert.ok(effective(scratchCode.permission, "edit", "../sibling.txt") === "allow", "scratch-sibling edits must be allowed");
  assert.ok(effective(scratchCode.permission, "edit", path.relative(scratchProject, path.join(project, "ordinary.txt"))) === "ask",
    "a worktree under scratch must not auto-allow edits outside scratch");
  console.log("ok: scratch-rooted worktrees allow scratch edits without auto-allowing outside edits");
  console.log("ok: scope is fresh configuration only; native saved approvals/session overrides remain a caveat");
} catch (error) {
  // Do not print assertion objects, configs, child output, or authentication data.
  console.error(`FAIL: ${error instanceof Error ? error.message : "container test failed"}`);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  if (child && child.pid && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      await exited;
    } finally {
      clearTimeout(force);
    }
  }
  for (const directory of [scratchProject, root].filter(Boolean)) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      console.error("FAIL: synthetic state cleanup failed");
      process.exitCode = 1;
    }
  }
}
if (!process.exitCode) console.log("PASS");
