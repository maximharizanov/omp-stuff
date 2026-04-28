# OMP review agents and commands

This repository contains the current custom OMP review assets from `~/.omp`.

## Commands

- `review`
  - Interactive general code-review command.
  - Supports reviewing against a base branch, uncommitted changes, a specific commit, or a GitHub PR checked out into a temporary sibling worktree.
  - Produces a review request for the `reviewer` agent, with diff context and file distribution guidance.

- `style-review`
  - Interactive style-guide review command.
  - Supports the same diff modes as `review`, including GitHub PR review in a sibling worktree.
  - Produces a review request for the `style-guide-reviewer` agent, using the embedded style guide and patch-focused instructions.

- `openspec-verify`
  - Interactive OpenSpec verification command.
  - Verifies a diff against a selected OpenSpec change and delta spec, using `openspec list`, `openspec status`, and `openspec instructions apply` to resolve the relevant artifacts.
  - Supports base-branch, uncommitted, commit, and GitHub PR review modes, and hands the result to the `openspec-verifier` agent with the resolved spec/design/proposal/tasks context.


## Skills

- `spec-review`
  - Workflow skill for reviewing OpenSpec proposal/design/spec/tasks artifacts before implementation.
  - Intended to run after `openspec-propose` and before `openspec-apply-change`, using the `spec-reviewer` agent.

## Agents

- `reviewer`
  - General correctness and quality reviewer.
  - Checks whether a patch introduces bugs, correctness issues, or release blockers.

- `style-guide-reviewer`
  - Style-guide compliance reviewer.
  - Checks a patch against the embedded TypeScript/design/testing/logging/readability rules and reports hard or advisory style violations.

- `openspec-verifier`
  - OpenSpec change verifier.
  - Checks whether a patch aligns with the selected OpenSpec delta spec and supporting artifacts, including requirement coverage, design alignment, and unscoped changes.

- `spec-reviewer`
  - Pre-implementation OpenSpec artifact reviewer.
  - Checks proposal, design, spec, and tasks for gaps, contradictions, ambiguous requirements, missing scenarios, task omissions, and implementation smells.

## Files

- Agent definitions
  - `.omp/agent/agents/reviewer.md`
  - `.omp/agent/agents/style-guide-reviewer.md`
  - `.omp/agent/agents/openspec-verifier.md`
  - `.omp/agent/agents/spec-reviewer.md`
- Command implementations
  - `.omp/agent/commands/review/index.ts`
  - `.omp/agent/commands/style-review/index.ts`
  - `.omp/agent/commands/openspec-verify/index.ts`
- Skills
  - `.agents/skills/spec-review/SKILL.md`
- Installer
  - `install.sh`

## Install

From the repository root:

```bash
chmod +x install.sh
./install.sh
```

The script installs the files into `~/.omp/agent/...` and `~/.agents/skills/...`, creating missing directories if needed.
