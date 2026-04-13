#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$SCRIPT_DIR/.omp/agent"
TARGET_ROOT="${HOME}/.omp/agent"

mkdir -p \
  "$TARGET_ROOT/agents" \
  "$TARGET_ROOT/commands/review" \
  "$TARGET_ROOT/commands/style-review" \
  "$TARGET_ROOT/commands/openspec-verify"

install -m 0644 "$SOURCE_ROOT/agents/reviewer.md" "$TARGET_ROOT/agents/reviewer.md"
install -m 0644 "$SOURCE_ROOT/agents/style-guide-reviewer.md" "$TARGET_ROOT/agents/style-guide-reviewer.md"
install -m 0644 "$SOURCE_ROOT/agents/openspec-verifier.md" "$TARGET_ROOT/agents/openspec-verifier.md"
install -m 0644 "$SOURCE_ROOT/commands/review/index.ts" "$TARGET_ROOT/commands/review/index.ts"
install -m 0644 "$SOURCE_ROOT/commands/style-review/index.ts" "$TARGET_ROOT/commands/style-review/index.ts"
install -m 0644 "$SOURCE_ROOT/commands/openspec-verify/index.ts" "$TARGET_ROOT/commands/openspec-verify/index.ts"

echo "Installed reviewer, style-guide-reviewer, and openspec-verifier assets into $HOME/.omp/agent"
