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

# ── gopls MCP server ──
if command -v gopls &>/dev/null; then
    if [ ! -f "$HOME/.claude.json" ]; then
        echo '{}' > "$HOME/.claude.json"
    fi
    if ! claude mcp get gopls &>/dev/null 2>&1; then
        claude mcp add --scope user --transport stdio gopls -- gopls mcp 2>/dev/null || true
        echo "gopls MCP: registered"
    fi
fi

echo "──────────────────────────────────────"
echo "Claude Code container ready"
echo "  Workspace: /workspace"
echo "  Go:        $(go version 2>/dev/null | awk '{print $3}')"
echo "  gopls:     $(gopls version 2>/dev/null | head -1)"
echo "──────────────────────────────────────"

exec claude "$@"
