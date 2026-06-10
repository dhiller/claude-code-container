# Claude Code Container for kubevirt.io

Container-based AI development harness for working on kubevirt.io repositories. Packages Claude Code CLI with Go tooling (gopls, golangci-lint, goimports) and enforces a strict permission model: all read operations are auto-approved, all write operations require confirmation.

## Prerequisites

- Podman (rootless)
- GCP application-default credentials (`gcloud auth application-default login`)
- GitHub CLI authenticated (`gh auth login`)
- SSH agent running with your GitHub key

## Quick Start

```bash
# 1. Build the image
./build.sh

# 2. Set Vertex AI env vars
export CLAUDE_GCP_PROJECT_ID=itpc-gcp-hcm-pe-eng-claude
export CLAUDE_CODE_USE_VERTEX=1
export CLOUD_ML_REGION=global
export ANTHROPIC_VERTEX_PROJECT_ID=$CLAUDE_GCP_PROJECT_ID

# 3. Run
./run-claude.sh
```

## What's Inside

| Tool | Version | Purpose |
|------|---------|---------|
| Claude Code | latest | AI assistant CLI |
| Go | 1.24.4 | kubevirt workspace Go version |
| gopls | latest | Go language server (MCP) |
| golangci-lint | latest (v2) | Go linting |
| goimports | latest | Import formatting |
| gh | latest | GitHub CLI |
| ripgrep | system | Fast code search |
| git | system | Version control |

## Permission Model

The container enforces a read-allow/write-ask policy via managed settings at `/etc/claude-code/managed-settings.json`:

**Auto-approved (no prompt):**
- All file reads (`Read` tool)
- Read-only shell commands: `ls`, `find`, `cat`, `head`, `tail`, `grep`, `rg`, `diff`, `tree`, etc.
- Read-only git: `status`, `log`, `diff`, `show`, `branch`, `blame`, etc.
- Read-only Go: `go doc`, `go list`, `go env`
- Read-only GitHub CLI: `gh pr view/list`, `gh issue view/list`, `gh api`, etc.
- All gopls and kubernetes MCP tools
- Web search and fetch for CI/GitHub domains

**Requires approval:**
- File edits and writes
- `git commit`, `git push fork`, `git checkout -b`
- `go build`, `go test`, `golangci-lint run`
- Any command not explicitly in the read-only allowlist

**Blocked entirely:**
- `git push origin` (all variants)
- Reading `kubevirt.io/secrets`, `.ssh`, `.tokens`, `.config`
- `sudo`, `rm -rf /`

## Workspace Layout

The container bind-mounts your host workspace:

```
/workspace/                     # ~/Projects/github.com (read-write)
  kubevirt.io/                  # Active development repos
    secrets/                    # Hidden by tmpfs overlay
  kubernetes/                   # Reference (from host)
  kubernetes-sigs/              # Reference (from host)
  .claude/                      # Project settings (from host)
  AGENTS.md                     # Agent rules (from host)
```

## Persistent Volumes

Two named Podman volumes survive container restarts:

| Volume | Mount | Purpose |
|--------|-------|---------|
| `claude-code-config` | `/home/claude/.claude` | Claude Code session data, MCP registrations |
| `go-module-cache` | `/home/claude/go` | Go module cache (avoids re-downloading dependencies) |

To reset either volume:

```bash
podman volume rm claude-code-config
podman volume rm go-module-cache
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_VERTEX_PROJECT_ID` | Yes* | — | GCP project for Vertex AI |
| `CLAUDE_GCP_PROJECT_ID` | Yes* | — | Alias for the above |
| `CLAUDE_CODE_USE_VERTEX` | No | `1` | Enable Vertex AI backend |
| `CLOUD_ML_REGION` | No | `global` | Vertex AI region |
| `GH_TOKEN` | No | from `gh auth token` | GitHub API token |
| `CLAUDE_WORKSPACE` | No | `~/Projects/github.com` | Host workspace path |

\* At least one of `ANTHROPIC_VERTEX_PROJECT_ID` or `CLAUDE_GCP_PROJECT_ID` must be set.

### Custom Workspace Path

```bash
CLAUDE_WORKSPACE=/path/to/workspace ./run-claude.sh
```

### Passing Arguments to Claude Code

Arguments after the script are forwarded to `claude`:

```bash
# Start with a specific prompt
./run-claude.sh -p "list all kubevirt.io repos"

# Resume a session
./run-claude.sh --resume
```

## Rebuilding

```bash
# Rebuild with different Go version
./build.sh  # edit GO_VERSION in build.sh

# Force full rebuild (no cache)
podman build --no-cache --tag claude-code-kubevirt:latest -f Containerfile .
```

## Troubleshooting

**"SSH agent not accessible"** — make sure `ssh-agent` is running and `SSH_AUTH_SOCK` is set on the host.

**"gh CLI will not work"** — run `gh auth login` on the host first. The token is extracted automatically.

**GCP auth errors** — run `gcloud auth application-default login` on the host. The credentials at `~/.config/gcloud/` are mounted read-only into the container.

**Permission denied on bind mounts** — the container uses `--userns=keep-id` to map your host UID. If your UID is not 1000, rebuild with `--build-arg USER_UID=$(id -u) --build-arg USER_GID=$(id -g)`.

**gopls not finding modules** — `cd` into a specific repo directory inside Claude Code before using Go language tools. gopls needs a `go.mod` in the working directory tree.
