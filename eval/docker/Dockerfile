# Image every eval task runs in. Tropos is copied in per run (built from the commit under test);
# Claude Code is pinned here so both agents are compared at known versions.
FROM oven/bun:1.4.0

ARG CLAUDE_CODE_VERSION=2.1.296

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates procps lsof nodejs npm \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force \
  && useradd -m -s /bin/bash agent \
  && git config --system user.name agent \
  && git config --system user.email agent@localhost \
  && git config --system --add safe.directory /work

# Claude Code refuses --dangerously-skip-permissions as root; both agents run as this user.
USER agent
WORKDIR /work
