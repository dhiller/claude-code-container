import { readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const managedRoots = ["/etc/kilo", "/usr/local/share/kilo"];
const scratch = "/tmp/kilo";
const mcpTools = {
  gopls: [
    "go_workspace", "go_search", "go_file_context", "go_package_api",
    "go_diagnostics", "go_symbol_references",
  ],
  kubernetes: [
    "pods_list", "pods_list_in_namespace", "pods_get", "pods_log", "pods_top",
    "resources_list", "resources_get", "namespaces_list", "events_list",
    "configuration_contexts_list", "configuration_view", "nodes_top",
    "nodes_log", "nodes_stats_summary",
  ],
};

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

// Resolve existing ancestors too, so a new file under a symlink is checked.
async function canonical(target, links = 0) {
  if (links >= 40) deny("too many symlinks");
  try {
    return await realpath(target);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    let link;
    try {
      link = await readlink(target);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EINVAL"].includes(error.code)) throw error;
    }
    if (link !== undefined) return canonical(path.resolve(path.dirname(target), link), links + 1);
    const parent = path.dirname(target);
    if (parent === target) return target;
    return path.join(await canonical(parent, links), path.basename(target));
  }
}

function deny(message) {
  throw new Error(`Managed Kilo policy: ${message}`);
}

// Deliberately not a shell parser or an auto-approval classifier. All bash asks.
function checkCommand(command) {
  const tokens = (command.match(/"[^"\n]*"|'[^'\n]*'|[^\s;&|()<>]+|[;&|()<>\n]/g) ?? [])
    .map((token) => token.replace(/["']/g, "").replace(/\\(.)/g, "$1"));
  for (let i = 0; i < tokens.length; i++) {
    const executable = path.basename(tokens[i]);
    if (executable === "sudo") deny("sudo is denied");
    const end = tokens.slice(i + 1).findIndex((token) => /^[;&|()<>\n]$/.test(token));
    const args = tokens.slice(i + 1, end === -1 ? undefined : i + 1 + end);
    if (executable === "rm" && args.some((arg) => /^\/(?:\*+)?$/.test(arg) || (arg.startsWith("/") && path.normalize(arg) === "/"))) {
      deny("removing the filesystem root is denied");
    }
    if (executable === "git" && args.includes("push") && args.some((arg) => arg === "origin" || arg === "--repo=origin")) {
      deny("git push to origin is denied");
    }
  }
  // Conservative defense in depth, including redirects; OS ownership is primary.
  if (/(?:\/etc\/kilo|\/usr\/local\/share\/kilo)(?:[\/\s'";|&<>)]|$)/.test(command)) {
    deny("shell references to managed policy paths are denied");
  }
}

// Export only the plugin: v7.3.50 invokes all legacy function exports as plugins.
export default async function kiloSecurity(context) {
  const env = { ...process.env };
  const directory = path.resolve(context.directory);
  const worktree = path.resolve(context.worktree);
  const home = env.HOME || homedir();
  const data = env.XDG_DATA_HOME || path.join(home, ".local/share");
  const secrets = [
    ...[".ssh", ".tokens", ".config", ".aws", ".kube"].map((name) => path.join(home, name)),
    ...[".credentials.json", "settings.json", "settings.local.json"].map((name) => path.join(home, ".claude", name)),
    env.XDG_CONFIG_HOME,
    env.KILO_CONFIG,
    env.KILO_CONFIG_DIR,
    env.KILO_TUI_CONFIG,
    env.CLOUDSDK_CONFIG,
    ...(env.KUBECONFIG ?? "").split(":").filter(Boolean),
    env.GOOGLE_APPLICATION_CREDENTIALS,
    env.AWS_CONFIG_FILE,
    env.AWS_SHARED_CREDENTIALS_FILE,
    path.join(data, "kilo/auth.json"),
    path.join(data, "kilo/mcp-auth.json"),
    path.join(env.KILO_CONTAINER_WORKSPACE || worktree, "kubevirt.io/secrets"),
  ].filter(Boolean).map((target) => path.resolve(directory, target));

  async function variants(roots) {
    return [...new Set((await Promise.all(roots.map(async (root) => [root, await canonical(root)]))).flat())];
  }

  async function checkPath(target, write = false, recursive = false) {
    const absolute = path.resolve(directory, target);
    const resolved = await canonical(absolute);
    const roots = await variants(write ? [...secrets, ...managedRoots] : secrets);
    if (roots.some((root) => inside(root, absolute) || inside(root, resolved)
      || (recursive && (inside(absolute, root) || inside(resolved, root))))) {
      deny(`protected path: ${absolute}`);
    }
    // An allowed /tmp/kilo spelling must not redirect writes elsewhere.
    if (write && inside(scratch, absolute) && !inside(scratch, resolved)) {
      deny("scratch symlink escapes /tmp/kilo; use the real destination for native approval");
    }
  }

  return {
    async config(config) {
      config.autoupdate = false;
      config.share = "disabled";
      config.experimental = { ...config.experimental, openTelemetry: false };
      const read = { "*": "allow" };
      const edit = { "*": "ask" };
      const relativeScratch = path.relative(worktree, scratch);
      edit[relativeScratch || "*"] = "allow";
      if (relativeScratch) edit[`${relativeScratch}/*`] = "allow";
      if (inside(scratch, worktree)) {
        // Local and ancestor-sibling paths stay in scratch until this boundary.
        edit["*"] = "allow";
        const outside = path.relative(worktree, path.dirname(scratch));
        edit[outside] = "ask";
        edit[`${outside}/*`] = "ask";
      }
      for (const root of await variants(secrets)) {
        const relative = path.relative(worktree, root);
        read[relative] = "deny";
        read[`${relative}/*`] = "deny";
        edit[relative] = "deny";
        edit[`${relative}/*`] = "deny";
      }
      for (const root of await variants(managedRoots)) {
        const relative = path.relative(worktree, root);
        edit[relative] = "deny";
        edit[`${relative}/*`] = "deny";
      }
      // Replace, never merge: inherited nested allows must not survive.
      config.permission = {
        "*": "ask", read, glob: "allow", grep: "allow", list: "allow", edit,
        bash: "ask", external_directory: { "*": "ask", "/tmp/kilo/*": "allow" },
        webfetch: "ask", websearch: "ask", skill: "allow", task: "ask",
        todowrite: "allow", semantic_search: "ask",
        ...Object.fromEntries(Object.entries(mcpTools).flatMap(([server, tools]) =>
          tools.map((tool) => [`${server}_${tool}`, "allow"]))),
      };
      delete config.tools;
      for (const collection of [config.agent, config.mode]) {
        for (const agent of Object.values(collection ?? {})) {
          if (!agent || typeof agent !== "object") continue;
          delete agent.permission;
          delete agent.tools;
        }
      }
      config.agent ??= {};
      config.agent.code ??= {};
      // The built-in code agent appends semantic_search allow after user rules.
      config.agent.code.permission = { semantic_search: "ask" };
    },

    async "tool.execute.before"({ tool }, { args }) {
      if (tool === "bash") {
        checkCommand(args.command ?? "");
        return;
      }
      if (tool === "apply_patch") {
        const text = (args.patchText ?? "").replace(/\r\n?/g, "\n");
        let source;
        for (const line of text.split("\n")) {
          const header = /^\*\*\* (Add File|Update File|Delete File|Move to):\s*(.*)$/.exec(line);
          if (!header) continue;
          const target = header[2].trim();
          await checkPath(target, true);
          if (header[1] === "Move to" && source && inside(scratch, path.resolve(directory, source)) && !inside(scratch, path.resolve(directory, target))) {
            deny("scratch rename escapes /tmp/kilo; use a separate write for native approval");
          }
          if (header[1] !== "Move to") source = target;
        }
        return;
      }
      if (["read", "edit", "write"].includes(tool)) {
        if (typeof args.filePath === "string") await checkPath(args.filePath, tool !== "read");
        return;
      }
      if (tool === "glob" && typeof args.pattern === "string") {
        // Match v7.3.50 glob.split: only absolute patterns override path/cwd.
        const pattern = args.pattern.replaceAll("\\", "/");
        let base = args.path ?? directory;
        if (path.isAbsolute(pattern)) {
          const index = pattern.search(/[*?{[]/);
          if (index === -1) base = pattern;
          else {
            const cut = pattern.slice(0, index).lastIndexOf("/");
            base = cut > 0 ? pattern.slice(0, cut) : "/";
          }
        }
        await checkPath(base, false, true);
        return;
      }
      if (["grep", "list", "semantic_search"].includes(tool)) {
        // Native grep/glob permissions do not apply per-file read deny rules.
        await checkPath(args.path ?? directory, false, true);
      }
    },
  };
}
