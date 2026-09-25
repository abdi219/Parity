# Task 2: Audit API Route

## Objective
Create the Next.js API route at `web/src/app/api/audit/route.ts`.

## Requirements
- Accept POST requests with `{ target: 'demo' | 'custom', repoUrl?: string }`.
- If `demo`, read `dummy-auth-service/README.md` and `dummy-auth-service/src/auth.ts` from disk.
- Call `runDriftAudit()` and return the `AuditReport` JSON.
- Return clean HTTP 200 responses on success and 400/500 on errors.