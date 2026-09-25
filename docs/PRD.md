# Product Requirements Document (PRD) — DriftGuard

## 1. Executive Summary & Problem Space
Software documentation rots silently. When backend engineers update routes, payloads, or authentication, markdown documentation (`README.md`, `/docs`) is rarely updated.

DriftGuard is an evidence-backed documentation-to-code drift verification engine. It extracts technical contracts from documentation, cross-references them against actual TypeScript/Express route handlers, surfaces exact line-level contradictions, and verifies the resolution in a closed loop.

---

## 2. In-Scope vs. Out-of-Scope (Strict MVP Boundaries)

### In-Scope (Hackathon MVP)
- Target Documentation: `README.md` and Markdown files.
- Target Implementation: TypeScript / JavaScript route handlers (Express/Next.js) using AST-based extraction where applicable with deterministic fallback parsing.
- Supported Drift Checks:
  1. Route / Path mismatches (`POST /api/login` vs `POST /api/v1/auth/login`)
  2. Request parameter mismatches (`username` vs `email`)
  3. Authentication mismatches (Redis session cookie vs Bearer JWT)
  4. Response schema mismatches (raw array `User[]` vs wrapped object `{ users: [], total }`)
- Canonical Demo Target: `dummy-auth-service` is the primary demonstration target with 3 deterministic drift cases. All core demo features must work locally without external network dependencies.
- Closed-Loop Verification: Audit -> 3 Drifts Found -> Apply Patch (modifies demo state) -> Re-Audit -> 0 Drifts Remaining.

### Out-of-Scope (Do Not Build)
- Multi-language support (No Python, Go, Rust, Java).
- Automatic GitHub PR creation via OAuth (outputs local diff, in-memory patch application, and copyable snippet).
- Database persistence (stateless execution).
- Runtime network traffic interception.

---

## 3. The Core Evidence Schema

```typescript
export interface DriftFinding {
  id: string; // e.g. "DRIFT-001"
  type: 'ROUTE_MISMATCH' | 'PARAM_MISMATCH' | 'AUTH_MISMATCH' | 'RESPONSE_MISMATCH';
  severity: 'CRITICAL' | 'WARNING';
  endpoint: string; // e.g. "POST /api/v1/auth/login"
  documentationFile: string; // e.g. "dummy-auth-service/README.md"
  documentationLine: number; // e.g. 14
  documentationClaim: string; // e.g. "Body requires username and password"
  codeFile: string; // e.g. "dummy-auth-service/src/auth.ts"
  codeLine: number; // e.g. 12
  codeReality: string; // e.g. "const { email, password } = req.body"
  explanation: string;
  proposedPatch: string; // Markdown replacement snippet
}

export interface AuditReport {
  timestamp: string;
  targetRepository: string;
  totalChecks: number;
  driftCount: number;
  findings: DriftFinding[];
  isClean: boolean;
}