---
name: spec-review
description: >-
  Review OpenSpec proposal, design, spec, and tasks artifacts before implementation.
  Use after openspec-propose and before openspec-apply-change to catch gaps,
  contradictions, ambiguous requirements, missing scenarios, task omissions, and
  implementation smells while the OpenSpec artifacts are still cheap to revise.
---

# Spec Review

Use this skill after `openspec-propose` creates artifacts and before anyone starts implementation.

## Goal

Catch artifact problems early:
- gaps between proposal, design, spec, and tasks
- contradictions or term drift
- requirements that cannot be implemented or tested as written
- missing failure/edge scenarios
- missing migration, contract, rollout, or verification tasks
- AI-slop smells: vague acceptance, scope creep, speculative design, or hidden decisions

## Workflow

1. Identify the change directory or artifact paths.
   - Preferred: `openspec/changes/<change-name>/`
   - Review: `.openspec.yaml`, `proposal.md`, `design.md`, `tasks.md`, and `specs/**/spec.md`
   - Read current `openspec/specs/**/spec.md` only when needed to understand baseline semantics.
2. Run a dedicated review with the `spec-reviewer` subagent when available.
   - Scope it to the OpenSpec artifacts only.
   - Tell it the review is pre-implementation and read-only.
   - Do not include implementation diffs unless the user explicitly asks for post-implementation verification.
3. Triage findings before implementation starts.
   - Fix P0/P1 artifact issues first.
   - Fix P2 issues when they affect testability, data shape, API behavior, or task completeness.
   - Treat P3 findings as cleanup unless they would confuse the implementer.
4. After revisions, rerun `spec-reviewer` on the same artifact set if P0/P1 findings were fixed.

## What to ask the reviewer to check

- Proposal: clear problem, scope, non-goals, affected systems/users, success criteria.
- Spec: behavior-focused `MUST` requirements, concrete actors/inputs/outputs, happy/failure/edge scenarios, unambiguous validation and error behavior.
- Design: state ownership, API/data shape, migration/backfill plan, concurrency/idempotency, authorization, failure modes, observability, rollout, alternatives.
- Tasks: every requirement and design decision has implementation and verification work; order is coherent; no hidden integration or migration work is omitted.
- Cross-artifact: same concept has one name, every promise appears in spec/tasks, no task violates a non-goal, no design decision contradicts a requirement.

## Suggested task prompt

```text
Review these OpenSpec artifacts before implementation:
- openspec/changes/<change-name>/.openspec.yaml
- openspec/changes/<change-name>/proposal.md
- openspec/changes/<change-name>/design.md
- openspec/changes/<change-name>/tasks.md
- openspec/changes/<change-name>/specs/**/spec.md

Focus only on artifact quality and readiness. Catch gaps, contradictions, ambiguous requirements, missing scenarios, task omissions, and implementation smells. Do not review implementation code. Do not modify files. Report actionable artifact-anchored findings only.
```

## Review bar

Report a finding only when it can change implementation, testing, scope, or future verification. Do not report grammar, formatting, or preference-only documentation nits.

## Relationship to other OpenSpec skills

- `openspec-propose`: creates the artifacts.
- `spec-review`: checks whether those artifacts are ready to implement.
- `openspec-apply-change`: implements after artifacts are clean enough.
- `openspec-verify-change` / `openspec-verifier`: checks implementation against artifacts after code exists.
