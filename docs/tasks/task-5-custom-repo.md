# Task 5 — Live GitHub Repository Auditing & Responsive Polish

## Scope

Extend Parity from a local-only demo into an open, online audit engine capable of fetching and verifying contracts directly from public GitHub repositories, paired with full mobile layout responsiveness.

## Requirements

### 1. API Route Extension (`web/src/app/api/audit/route.ts`)

- Support `target: "custom"` alongside `target: "demo"`.
- Accept `repoUrl`, `docPath` (default: `README.md`), and `codePath` (default: `src/auth.ts`) in the POST request body.
- Parse GitHub URLs to extract owner and repository names while stripping `.git` or sub-paths.
- Fetch raw file contents from `raw.githubusercontent.com` across `main` with a fallback to `master`.
- Run `runDriftAudit(docContent, codeContent)` on retrieved files.
- Return explicit HTTP 400 (bad input / invalid URL) and HTTP 404/502 (file missing or network error) status codes.

### 2. Dashboard UI & Mode Switching (`web/src/app/page.tsx`)

- Implement a discrete tab switcher between "Demo" mode and "Public Repo" mode.
- Provide editable inputs for repository URL, documentation path, and code file path.
- Add an "Audit Public Repo" trigger with loading state disablement.
- Stream real-time fetch and resolution steps to the execution terminal.
- Gracefully scope in-memory patching to local demo audits where patch rules are verified.

### 3. Responsive Overhaul & Layout Hygiene

- Replace artificial margin spacing with flexbox-driven viewport docking (`min-h-screen flex flex-col justify-between`).
- Implement full mobile wrapping across navbar, control bar, cards, and execution logs using standard Tailwind breakpoints (`sm:`).
- Eliminate all horizontal scroll leaks on viewports under 640px.

## Acceptance Criteria

- `tsc --noEmit` exits with code 0 under `strict: true`.
- Zero emojis and zero non-standard colors; strict adherence to `docs/RULES.md`.
- Public repositories fetch in under 1 second without personal tokens or API keys.
