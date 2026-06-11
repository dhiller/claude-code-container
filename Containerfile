# =============================================================================
# Stage 1: Build Go development tools
# =============================================================================
FROM docker.io/library/golang:1.26-bookworm AS go-tools

RUN go install golang.org/x/tools/gopls@latest && \
    go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest && \
    go install golang.org/x/tools/cmd/goimports@latest

# =============================================================================
# Stage 2: Runtime — Node.js + Go + Claude Code + system packages
# =============================================================================
FROM docker.io/library/node:22-bookworm

ARG GO_VERSION=1.24.4
ARG USER_NAME=claude
ARG USER_UID=1000
ARG USER_GID=1000

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    git-lfs \
    openssh-client \
    less \
    procps \
    sudo \
    jq \
    vim \
    ripgrep \
    curl \
    ca-certificates \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# GitHub CLI — install from official repo
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y --no-install-recommends gh && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Go toolchain
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \
    | tar -C /usr/local -xz

# Go tools from build stage
COPY --from=go-tools /go/bin/gopls /usr/local/bin/
COPY --from=go-tools /go/bin/golangci-lint /usr/local/bin/
COPY --from=go-tools /go/bin/goimports /usr/local/bin/

# Non-root user matching host UID/GID
RUN userdel -r node 2>/dev/null || true && \
    groupadd --gid ${USER_GID} ${USER_NAME} 2>/dev/null || true && \
    useradd --uid ${USER_UID} --gid ${USER_GID} -m -s /bin/bash ${USER_NAME} && \
    echo "${USER_NAME} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${USER_NAME}

ENV GOROOT=/usr/local/go
ENV GOPATH=/home/${USER_NAME}/go
ENV PATH="${GOPATH}/bin:${GOROOT}/bin:${PATH}"

# Claude Code and MCP servers
ENV WORKDIR=/workspace
RUN npm install -g @anthropic-ai/claude-code kubernetes-mcp-server

# Managed settings — enforced read-allow/write-ask permission policy
RUN mkdir -p /etc/claude-code
COPY managed-settings.json /etc/claude-code/managed-settings.json

# Entrypoint
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Directories
RUN mkdir -p /workspace /home/${USER_NAME}/.claude /home/${USER_NAME}/.ssh \
      /home/${USER_NAME}/go && \
    echo '{"hasCompletedOnboarding":true,"projects":{"/workspace":{"hasTrustDialogAccepted":true,"allowedTools":[]}}}' > /home/${USER_NAME}/.claude.json && \
    chown -R ${USER_NAME}:${USER_NAME} /home/${USER_NAME} /workspace

# Symlink host path so git hooks with absolute paths resolve correctly
RUN mkdir -p /home/dhiller/Projects && \
    ln -s /workspace /home/dhiller/Projects/github.com

ENV DEVCONTAINER=true
ENV DISABLE_AUTOUPDATER=1
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
ENV NODE_OPTIONS="--max-old-space-size=4096"
ENV TERM=xterm-256color

WORKDIR /workspace
USER ${USER_NAME}

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD []
