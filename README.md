# OMP review agents and commands

This repository contains the current custom OMP review assets from `~/.omp`:

- Agent definitions
  - `.omp/agent/agents/reviewer.md`
  - `.omp/agent/agents/style-guide-reviewer.md`
  - `.omp/agent/agents/openspec-verifier.md`
- Command implementations
  - `.omp/agent/commands/review/index.ts`
  - `.omp/agent/commands/style-review/index.ts`
  - `.omp/agent/commands/openspec-verify/index.ts`
- Installer
  - `install.sh`

## Install

From the repository root:

```bash
chmod +x install.sh
./install.sh
```

The script installs the files into `~/.omp/agent/...`, creating missing directories if needed.
