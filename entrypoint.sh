#!/bin/bash
set -e

# ── Git identity ──
if [ ! -f "$HOME/.gitconfig" ]; then
    echo "[WARNING] No .gitconfig mounted. Setting minimal git config."
    git config --global user.name "${GIT_USER_NAME:-Claude Code Container}"
    git config --global user.email "${GIT_USER_EMAIL:-noreply@container}"
fi

# ── SSH agent ──
if [ -n "$SSH_AUTH_SOCK" ]; then
    if ssh-add -l &>/dev/null; then
        echo "SSH agent: connected ($(ssh-add -l | wc -l) key(s))"
    else
        echo "[WARNING] SSH_AUTH_SOCK set but agent not accessible"
    fi
fi

# ── Vertex AI ──
if [ -n "${CLAUDE_CODE_USE_VERTEX:-}" ]; then
    echo "Vertex AI: project=${ANTHROPIC_VERTEX_PROJECT_ID:-unset} region=${CLOUD_ML_REGION:-unset}"
fi

# ── GitHub CLI ──
if [ -n "$GH_TOKEN" ]; then
    echo "GitHub CLI: token configured"
fi

# ── gopls ──
if command -v gopls &>/dev/null; then
    echo "gopls: available (plugin: gopls-lsp@claude-plugins-official)"
fi

# ── Generate ~/.claude/CLAUDE.md ──
generate_claude_hints() {
    local out="$HOME/.claude/CLAUDE.md"

    # Probe tool versions (suppress errors for missing tools)
    local go_ver gopls_ver lint_ver imports_ver shfmt_ver yq_ver
    local gh_ver jq_ver rg_ver shellcheck_ver skopeo_ver yamllint_ver
    local ci_failures_ver
    go_ver=$(go version 2>/dev/null | awk '{print $3}') || go_ver="not installed"
    gopls_ver=$(gopls version 2>/dev/null | head -1 | awk '{print $2}') || gopls_ver="not installed"
    lint_ver=$(golangci-lint version 2>/dev/null | head -1 | grep -oP 'v[\d.]+') || lint_ver="not installed"
    imports_ver=$(goimports --help 2>&1 | head -1) && imports_ver="installed" || imports_ver="not installed"
    shfmt_ver=$(shfmt --version 2>/dev/null) || shfmt_ver="not installed"
    yq_ver=$(yq --version 2>/dev/null | awk '{print $NF}') || yq_ver="not installed"
    gh_ver=$(gh version 2>/dev/null | head -1 | awk '{print $3}') || gh_ver="not installed"
    jq_ver=$(jq --version 2>/dev/null) || jq_ver="not installed"
    rg_ver=$(rg --version 2>/dev/null | head -1 | awk '{print $2}') || rg_ver="not installed"
    shellcheck_ver=$(shellcheck --version 2>/dev/null | grep '^version:' | awk '{print $2}') || shellcheck_ver="not installed"
    skopeo_ver=$(skopeo --version 2>/dev/null | awk '{print $3}') || skopeo_ver="not installed"
    yamllint_ver=$(yamllint --version 2>/dev/null | awk '{print $2}') || yamllint_ver="not installed"
    ci_failures_ver=$(ci-failures --version 2>/dev/null) && ci_failures_ver="installed" || ci_failures_ver="installed (no version flag)"

    cat > "$out" << 'HEADER'
# Container Environment

You are running inside a containerized Claude Code environment. This file describes the pre-installed tools, MCP integrations, and permission policy so you know what is available without probing.

## Installed Tools

HEADER

    cat >> "$out" << EOF
| Tool | Version | Purpose |
|------|---------|---------|
| go | ${go_ver} | Go toolchain |
| gopls | ${gopls_ver} | Go language server |
| golangci-lint | ${lint_ver} | Go linter |
| goimports | ${imports_ver} | Go import organizer |
| shfmt | ${shfmt_ver} | Shell script formatter |
| yq | ${yq_ver} | YAML processor (mikefarah/yq) |
| ci-failures | ${ci_failures_ver} | kubevirt/ci-health CI failure analyzer |
| gh | ${gh_ver} | GitHub CLI |
| jq | ${jq_ver} | JSON processor |
| rg | ${rg_ver} | ripgrep (fast search) |
| shellcheck | ${shellcheck_ver} | Shell script linter |
| skopeo | ${skopeo_ver} | Container image inspector |
| yamllint | ${yamllint_ver} | YAML linter |
EOF

    cat >> "$out" << 'BODY'

## MCP Servers

- **kubernetes-mcp-server** — Kubernetes cluster operations (pods, resources, events, logs, node stats)
- **gopls LSP plugin** (gopls-lsp@claude-plugins-official) — Go workspace, search, diagnostics, references

## Permission Policy

A managed-settings policy controls what is auto-allowed vs. requires user approval.

### Auto-allowed (no prompt)

- **Read**: all files except secrets/SSH/tokens/config paths
- **Bash read-only**: `ls`, `find`, `cat`, `head`, `tail`, `grep`, `rg`, `wc`, `file`, `stat`, `du`, `diff`, `tree`, `sort`, `uniq`, `column`, `awk`, `sed -n`, `which`, `echo`, `pwd`, `date`, `id`, `env`, `xargs`
- **Git read-only**: `status`, `log`, `diff`, `show`, `branch`, `remote`, `tag`, `rev-parse`, `ls-files`, `ls-tree`, `blame`, `shortlog`, `stash list`, `config --get`, `config --list`, `worktree list`
- **Go tooling**: `go doc`, `go list`, `go version`, `go env`, `gopls`, `golangci-lint`, `goimports`, `yamllint`
- **GitHub CLI read-only**: `gh pr view/list/checks/diff`, `gh issue view/list`, `gh api`, `gh auth status`, `gh repo view`, `gh search`, `gh run view/list`
- **Container tools**: `skopeo inspect`, `skopeo list-tags`
- **All MCP server tools** (kubernetes, gopls)
- **All registered skills**

### Denied (hard block)

- `git push origin` (any form including `--force`, `--force-with-lease`, `-f`) — push to `fork` remote instead
- Reading `/workspace/kubevirt.io/secrets`, `~/.ssh`, `~/.tokens`, `~/.config`
- `rm -rf /` or `rm -rf /*`
- `sudo`

### Requires user approval

Everything else — file writes, `git commit`, `git push fork`, `go build`, `go test`, etc. A PreToolUse hook (readonly-gate) auto-approves read-only operations and prompts for writes.

## Key Constraints

- **Non-root user** (`claude`, UID 1000) — `sudo` is denied by policy
- **Workspace**: `/workspace` — all repos are mounted here
- **No pushing to `origin`** — always push to the `fork` remote
- **Write operations need approval** — the readonly-gate hook will prompt
BODY

    echo "Generated $out"
}

generate_claude_hints

echo "──────────────────────────────────────"
echo "Claude Code container ready"
echo "  Workspace: /workspace"
echo "  Go:        $(go version 2>/dev/null | awk '{print $3}')"
echo "  gopls:     $(gopls version 2>/dev/null | head -1)"
echo "──────────────────────────────────────"

exec claude "$@"
