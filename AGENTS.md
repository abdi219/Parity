# AGENTS.md — Parity Context

## What is Parity?

Parity is an evidence-backed documentation-to-code drift verification tool built for a hackathon. It inspects documentation (`README.md`) against actual backend route handlers (`auth.ts`), detects contradictions with exact line citations, and generates unified markdown diffs.

## Engineering Invariants

- Strictly follow `docs/RULES.md` (no emojis, no neon glow, no fake metrics, no generic card bloat).
- Strictly adhere to `DriftFinding` and `AuditReport` interfaces in `docs/PRD.md`.
- Keep implementations deterministic, lightweight, and offline-first.
- Execute tasks in order from `docs/tasks/`.
