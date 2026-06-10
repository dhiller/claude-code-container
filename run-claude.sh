#!/bin/bash
set -euo pipefail

IMAGE_NAME="claude-code-kubevirt"
IMAGE_TAG="latest"
WORKSPACE="${CLAUDE_WORKSPACE:-${HOME}/Projects/github.com}"

# ── Vertex AI auth ──
if [ -z "${ANTHROPIC_VERTEX_PROJECT_ID:-}" ] && [ -z "${CLAUDE_GCP_PROJECT_ID:-}" ]; then
    echo "ERROR: ANTHROPIC_VERTEX_PROJECT_ID (or CLAUDE_GCP_PROJECT_ID) is not set."
    echo "Export them before running:"
    echo "  export CLAUDE_GCP_PROJECT_ID=itpc-gcp-hcm-pe-eng-claude"
    echo "  export CLAUDE_CODE_USE_VERTEX=1"
    echo "  export CLOUD_ML_REGION=global"
    echo "  export ANTHROPIC_VERTEX_PROJECT_ID=\$CLAUDE_GCP_PROJECT_ID"
    exit 1
fi

# Resolve ANTHROPIC_VERTEX_PROJECT_ID from CLAUDE_GCP_PROJECT_ID if needed
export ANTHROPIC_VERTEX_PROJECT_ID="${ANTHROPIC_VERTEX_PROJECT_ID:-${CLAUDE_GCP_PROJECT_ID}}"
export CLAUDE_CODE_USE_VERTEX="${CLAUDE_CODE_USE_VERTEX:-1}"
export CLOUD_ML_REGION="${CLOUD_ML_REGION:-global}"

# ── GitHub token ──
GH_TOKEN="${GH_TOKEN:-$(gh auth token 2>/dev/null || true)}"
if [ -z "$GH_TOKEN" ]; then
    echo "WARNING: No GitHub token available. gh CLI will not work inside container."
fi

# ── SSH agent ──
SSH_MOUNT=()
if [ -n "${SSH_AUTH_SOCK:-}" ] && [ -S "$SSH_AUTH_SOCK" ]; then
    SSH_MOUNT=(
        -v "${SSH_AUTH_SOCK}:/tmp/ssh-agent.sock:Z"
        -e "SSH_AUTH_SOCK=/tmp/ssh-agent.sock"
    )
else
    echo "WARNING: No SSH agent socket found. Git SSH operations won't work."
fi

# ── Podman run ──
exec podman run --rm -it \
    --hostname "claude-kubevirt" \
    --userns=keep-id \
    --security-opt label=disable \
    --network=host \
    \
    -e "ANTHROPIC_VERTEX_PROJECT_ID" \
    -e "CLAUDE_CODE_USE_VERTEX" \
    -e "CLOUD_ML_REGION" \
    -e "GH_TOKEN=${GH_TOKEN}" \
    -e "TERM=${TERM:-xterm-256color}" \
    \
    -v "${WORKSPACE}:/workspace:Z" \
    --mount "type=tmpfs,destination=/workspace/kubevirt.io/secrets" \
    \
    -v "${HOME}/.gitconfig:/home/claude/.gitconfig:ro,Z" \
    -v "${HOME}/.ssh/known_hosts:/home/claude/.ssh/known_hosts:ro,Z" \
    -v "${HOME}/.config/gcloud:/home/claude/.config/gcloud:ro,Z" \
    \
    "${SSH_MOUNT[@]}" \
    \
    -v "claude-code-config:/home/claude/.claude" \
    -v "go-module-cache:/home/claude/go" \
    \
    "${IMAGE_NAME}:${IMAGE_TAG}" "$@"
