# Task 1: Core Drift Engine

## Objective
Build the analysis engine in `web/src/lib/driftEngine.ts` to detect documentation drift.

## Requirements
- Strictly follow the `DriftFinding` and `AuditReport` interfaces from `docs/PRD.md`.
- Parse endpoint routes, parameters, auth headers, and response bodies from Markdown docs.
- Parse Express/TypeScript handler signatures from code.
- Detect:
  1. Route mismatch (`POST /api/login` vs `POST /api/v1/auth/login`)
  2. Param mismatch (`username` vs `email`)
  3. Auth mismatch (Redis cookie vs Bearer JWT)
  4. Response mismatch (`User[]` vs `{ users, total }`)
- Export: `runDriftAudit(docContent: string, codeContent: string): AuditReport`.