# Claude Code and Kilo Containers for kubevirt.io

Separate Podman images package Claude Code or Kilo CLI with Go development and
CI tooling. They share build defaults, but differ in authentication, workspace
layout, persistent state, and agent permissions. CLI policies are approval
boundaries, not an OS sandbox or a guarantee that approved operations are safe.

## Prerequisites

- Rootless Podman and an existing workspace (default: `$HOME/Projects/github.com`).
- Claude: GCP application-default credentials and a Vertex AI project.
- Kilo: current host Kilo settings and credentials for your chosen provider.
- Host `kilo` for version detection, or an explicit `KILO_VERSION` when building.
- Optional GitHub authentication (`gh auth login` or a token) and an SSH agent
  for GitHub operations; neither is required just to start Kilo.

## Quick Start

### Claude Code

The Claude launcher is configured for Vertex AI, not a generic provider setup.
It requires `ANTHROPIC_VERTEX_PROJECT_ID` or its alias `CLAUDE_GCP_PROJECT_ID`.

```bash
gcloud auth application-default login
export ANTHROPIC_VERTEX_PROJECT_ID=your-gcp-project
export CLAUDE_CODE_USE_VERTEX=1
export CLOUD_ML_REGION=global
mkdir -p "$HOME/.claude-container"
./build.sh
./run-claude.sh
```

The launcher defaults `CLAUDE_CODE_USE_VERTEX` to `1` and `CLOUD_ML_REGION` to
`global`. It expects host `.gitconfig`, `.ssh/known_hosts`, `.config/gcloud`, and
`.kube` bind sources; prepare those needed by your setup before launching.

### Kilo

Configure your provider with the host Kilo CLI first. Kilo reuses host settings,
authentication, plugins, history, and TUI state rather than requiring Vertex AI.

```bash
./build-kilo.sh
./run-kilo.sh

# Without a host CLI, supply an explicit version (example):
KILO_VERSION=7.3.50 ./build-kilo.sh
```

`build-kilo.sh` pins `@kilocode/cli` to `KILO_VERSION`, defaulting to the output
of host `kilo --version`. Keep host and container CLI versions aligned because
they share writable state and databases. An override skips host version lookup;
it does not validate compatibility with existing state.

Both launchers forward arguments to their respective CLI:

```bash
./run-claude.sh --resume
./run-kilo.sh --help
```

## Builds and Tools

| Setting      | Default                                       | Source             |
| ------------ | --------------------------------------------- | ------------------ |
| Claude image | `quay.io/dhiller/claude-code-kubevirt:latest` | `defaults.sh`      |
| Kilo image   | `quay.io/dhiller/kilo-code-kubevirt:latest`   | `defaults-kilo.sh` |
| Go version   | `1.27.3`                                      | `defaults-kilo.sh` |
| Kilo version | Host `kilo --version`, or `KILO_VERSION`      | `build-kilo.sh`    |

Both builds use the shared `GO_VERSION` for the Go tools stage and runtime
toolchain, independently of host Go selection such as `GIMME_GO_VERSION`.
Claude Code is installed without a version pin; Kilo is pinned as above.

Both images include Node.js 22, Go, gopls, golangci-lint v2, goimports, shfmt,
mikefarah/yq, ci-failures, gh, git/git-lfs, SSH client, ripgrep, jq, ShellCheck,
yamllint, and skopeo. Go tools are built at `latest`; ci-failures is built from
the current ci-health source. Kilo additionally includes Python 3 and venv.
Installing gopls and kubernetes-mcp-server does not register MCP servers.

```bash
GO_VERSION=1.27.4 ./build.sh
GO_VERSION=1.27.4 ./build-kilo.sh --no-cache
KILO_IMAGE=localhost/kilo-dev:latest ./build-kilo.sh
KILO_IMAGE=localhost/kilo-dev:latest ./run-kilo.sh
```

`KILO_IMAGE` overrides both Kilo build and run image selection. Claude image
selection is defined in `defaults.sh`. Build scripts match host UID/GID; Kilo
also builds with the host home path. Rebuild when these change. Claude's runtime
Go download is amd64-specific; Kilo selects the Debian architecture dynamically.

## Workspace and State

| Behavior        | Claude Code        | Kilo                                 |
| --------------- | ------------------ | ------------------------------------ |
| Workspace input | `CLAUDE_WORKSPACE` | `KILO_WORKSPACE`                     |
| Container path  | `/workspace`       | Same absolute path as host           |
| Container home  | `/home/claude`     | Same absolute path as host `$HOME`   |
| Starting cwd    | `/workspace`       | Host cwd within workspace, else root |
| Go cache volume | `go-module-cache`  | `kilo-go-module-cache`               |

Both workspace inputs default to `$HOME/Projects/github.com` and mount
read-write. Kilo resolves and validates the workspace directory. Its starting
cwd falls back to the workspace root when launched outside it.

```bash
CLAUDE_WORKSPACE=/path/to/workspace ./run-claude.sh
KILO_WORKSPACE=/path/to/workspace ./run-kilo.sh
```

Claude bind-mounts `$HOME/.claude-container` at `/home/claude/.claude`; this is
**not a named volume**. Its entrypoint regenerates `.claude/CLAUDE.md` with
container hints on startup. The `go-module-cache` named volume mounts at
`/home/claude/go`. The image also links `/home/dhiller/Projects/github.com` to
`/workspace` for existing absolute-path hooks.

Kilo shares these host directories read-write at their original absolute paths,
creating the four XDG Kilo directories when absent:

- `${XDG_CONFIG_HOME:-$HOME/.config}/kilo`
- `${XDG_DATA_HOME:-$HOME/.local/share}/kilo`
- `${XDG_STATE_HOME:-$HOME/.local/state}/kilo`
- `${XDG_CACHE_HOME:-$HOME/.cache}/kilo`
- Existing `$HOME/.kilo`, `$HOME/.claude`, `$HOME/.agents`, and `KILO_CONFIG_DIR`.

Settings mounts recursively include existing symlink targets, including external
skills directories, while skipping traversal through `.git` and `node_modules`.
The `kilo-go-module-cache` named volume mounts at `$HOME/go`. Removing a container
does not remove these host settings or named volumes. To discard Go caches:

```bash
podman volume rm go-module-cache
podman volume rm kilo-go-module-cache
```

## Credentials and Environment

Claude forwards its Vertex variables and `GH_TOKEN` (falling back to
`gh auth token`). It mounts GCP configuration, Kubernetes configuration, Git
configuration, and SSH known hosts read-only under `/home/claude`. A supplied
`KUBECONFIG` becomes `/home/claude/.kube/<basename>`; this is not general
multi-file path forwarding.

Kilo preserves provider configuration and exported provider variables, including
arbitrary `{env:...}` substitutions and multiline `KILO_CONFIG_CONTENT`. Existing
`KILO_CONFIG`, `KILO_TUI_CONFIG`, credential and CA file paths are mounted
read-only, as are Git configuration, SSH known hosts, GCP configuration
(`CLOUDSDK_CONFIG` or the XDG default), `.aws`, `.kube`, and existing colon-separated
`KUBECONFIG` entries. Missing optional paths are skipped. `GH_TOKEN` or
`GITHUB_TOKEN` suppresses fallback to host `gh auth token`.

Host permission overrides are deliberately **not** preserved. Kilo excludes
`KILO_PERMISSION`, `KILO_TEST_MANAGED_CONFIG_DIR`, `KILO_PURE`,
`KILO_CONTAINER_WORKSPACE`, and `KILO_DISABLE_AUTOUPDATE`. The launcher supplies
the trusted workspace value; the image disables auto-updates. It also excludes
executable injection variables `BASH_ENV`, `ENV`, `NODE_OPTIONS`, `BUN_OPTIONS`,
`LD_PRELOAD`, and `LD_LIBRARY_PATH`.

Other excluded host metadata includes `PATH`, shell/cwd/user/hostname metadata,
`TMPDIR`, `XDG_RUNTIME_DIR`, SSH agent metadata, `GOROOT`, `GOPATH`, `GOBIN`,
`KILO_BIN_PATH`, `KILO_PID`, `KILO_RUN_ID`, and `KILO_PROCESS_ROLE`.
`HOME` is set explicitly; a valid SSH agent socket is forwarded separately.

## Managed Permissions

### Claude Code: Legacy Policy

`/etc/claude-code/managed-settings.json` installs the existing PreToolUse
`readonly-gate.sh` hook and broad legacy allowlist. File reads, many shell
patterns, selected skills, selected web operations, and explicitly named gopls
and Kubernetes MCP tools can be auto-approved. `Edit(/tmp/**)` is also allowed.
Other operations normally require approval.

This is **not a guaranteed read-only shell allowlist**: patterns such as
`git branch *`, `git remote *`, `gh api *`, `xargs *`, `gopls *`, and
`goimports *` can mutate state. The policy denies specified Read paths for
secrets/SSH/tokens/config, certain `git push origin` spellings, `sudo`, and
`rm -rf /` or `rm -rf /*`. These are tool/pattern restrictions, not universal
filesystem or command execution restrictions. MCP permissions are explicit
tool names, not blanket approval of every tool on either server.

### Kilo: Image-Owned Policy and Plugin

The image owns `/etc/kilo/kilo.json` and the root-owned plugin
`/usr/local/share/kilo/kilo-security.mjs`. Host `/etc/kilo` is not mounted.
The launcher rejects mounts that shadow either managed policy directory.
The plugin replaces merged permissions, removes inherited legacy `tools`, and
strips agent/mode permission and tool overrides while keeping provider settings.

- Every Bash call defaults to ask, including `git status`, `git diff`, builds,
  and tests. Existing native session approvals remain a limitation below.
- Ordinary native reads, glob/grep/list searches, skills, and todo updates allow.
- Native edits ask except in `/tmp/kilo`; permission patterns are generated
  relative to the worktree. Scratch symlink escapes and renames out are rejected.
- Web fetch/search, tasks, semantic search, unknown tools, and external-directory
  access ask, with the configured scratch external-directory exception.
- Native credential-path reads, edits, patches, and path-based searches deny.
  Protected roots include `.ssh`, `.tokens`, `.config`, `.aws`, `.kube`, XDG
  config, explicit Kilo/GCP/AWS/Kubernetes config paths, Kilo `auth.json`/`mcp-auth.json`,
  Claude credentials/settings, and workspace `kubevirt.io/secrets`. Symlink
  aliases are checked; recursive searches encompassing protected roots are
  rejected, so search a narrower repo.
- Managed policy writes deny. Known `sudo`, filesystem-root removal, and
  `git push origin` spellings are rejected by a guard, not a full shell parser.
- Managed settings disable Kilo session sharing, automatic updates, and
  experimental OpenTelemetry. This is not a guarantee of zero network traffic.

The plugin and integration check target Kilo `7.3.50`. Rerun these checks after
changing CLI versions; permission matching and plugin APIs are version-sensitive.

Both policies explicitly allow these read-oriented MCP names **only when servers
are configured with the names `gopls` and `kubernetes`** (Kilo uses
`<server>_<tool>`; Claude uses `mcp__<server>__<tool>`):

- gopls: `go_workspace`, `go_search`, `go_file_context`, `go_package_api`,
  `go_diagnostics`, `go_symbol_references`.
- kubernetes: `pods_list`, `pods_list_in_namespace`, `pods_get`, `pods_log`,
  `pods_top`, `resources_list`, `resources_get`, `namespaces_list`, `events_list`,
  `configuration_contexts_list`, `configuration_view`, `nodes_top`, `nodes_log`,
  `nodes_stats_summary`.

## Isolation Limits

Both launchers use host networking, `--userns=keep-id`, and
`--security-opt label=disable`. Neither mounts Docker or its socket; an SSH agent
socket is explicitly forwarded when available. Workspace secrets are masked by
tmpfs (conditionally, when the directory exists, for Kilo).

Claude includes passwordless sudo but denies it through agent policy. Kilo has
no sudo, drops all capabilities, and sets `no-new-privileges`. These harden the
container but do not make CLI approval policy an OS sandbox:

- Kilo's native saved-session grants can override `ask` decisions.
- Arbitrary trusted plugins can execute code. Plugin loader errors fail open;
  the security plugin is not a sandbox or a fail-closed loader boundary.
- Same-UID shared state is writable. All exported credential variables forwarded
  to Kilo are exposed to approved shell commands, MCP processes, and plugins.
- Native credential-path denials do not prevent shell/MCP/plugin access.
  Read-only credential mounts prevent writes, not disclosure.
- Host networking permits broad access. The `origin`-name guard is not a network
  ACL and does not block pushes to the same destination through another name/URL.

## Tests

Run the launcher/build mock tests and plugin unit tests without building images:

```bash
./test-kilo.sh
node --test test-kilo-security.mjs
```

These cover forwarding, mounts, workspace selection, version pinning, policy
reset, protected paths, symlinks, scratch handling, and known command spellings.
They do not prove live CLI loader behavior, provider access, MCP registration,
or end-to-end container isolation.

After building Kilo, run the offline integration check without mounting host
settings or credentials:

```bash
podman run --rm --network=none --userns=keep-id --cap-drop=all \
  --security-opt=no-new-privileges --security-opt=label=disable \
  --entrypoint node \
  -v "$PWD/test-kilo-container.mjs:/test-kilo-container.mjs:ro" \
  quay.io/dhiller/kilo-code-kubevirt:latest /test-kilo-container.mjs
```

This checks image policy ownership, actual managed-plugin loading, preservation
of synthetic provider settings, and effective agent rule ordering against
conflicting global, project, external, and inline configuration. It uses fresh
state, performs no model or MCP calls, and does not simulate approval prompts or
claim that saved-session grants cannot override them. The validator's symlink
and command handling is covered separately by the direct plugin tests.
