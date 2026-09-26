# Parity — API Documentation Drift Engine

**Parity** compares your API documentation against your actual source code and tells you exactly where they disagree — with file and line citations, side-by-side evidence, and ready-to-apply patches.

---

## The Problem

Documentation drifts silently. A route gets renamed, a parameter changes from `username` to `email`, authentication switches from cookies to Bearer tokens — and the README never gets updated. Clients break. Integrations fail. Nobody knows why until the damage is done.

Parity closes that gap automatically, without running your service.

---

## How It Works

```
GitHub Repo URL
  └─ Tree Discovery (single GitHub Trees API call)
       ├─ Documentation Files  ──► Doc Extractor (regex + Groq LLM fallback)
       └─ Source Code Files    ──► Code Extractor (AST-level scoped regex)
                                        │
                               Drift Comparison Engine
                               (100% deterministic — no LLM decides drift)
                                        │
                          ┌────────────────────────────┐
                          │  Findings with file:line   │
                          │  provenance on both sides  │
                          └────────────────────────────┘
                                        │
                               Unified Diff Patches
                               + Closed-Loop Re-Audit
```

---

## Core Features

### Deterministic Code Extraction
Source files are parsed with AST-level scoped regex — handler bodies are isolated by brace-counting so parameters from one route never bleed into another. TypeScript/JavaScript gets the deepest analysis. Python (FastAPI/Flask), Go (Gin/Fiber/net-http), and Java (Spring) use lightweight local pattern detection with targeted LLM fallback only when local extraction is inconclusive.

### Hybrid Documentation Parsing
Structured documentation (tables, `Route:` labels, code fences) is handled entirely by deterministic regex patterns. Conversational prose READMEs that describe endpoints in natural language ("sends a POST request to /api/v1/register…") are sent to a Groq LLM as a targeted fallback. Groq never decides whether drift exists — it only helps extract contract structure from ambiguous text.

### Line-Level Provenance
Every finding carries the exact `file:line` from both the documentation and the implementation. No approximations. The line numbers come from the extractors, not from the model.

### Actionable Patches
Parity generates minimal unified diffs targeting only the contradicted text. Click **Apply Recommended Patches** to apply them in-memory, see the diff inline, and trigger an immediate re-audit. The closed-loop verification confirms drift count reaches 0.

### Repository Map
When auditing a GitHub repository, Parity shows a real-time summary of files discovered, documentation files, API source files, detected languages, extraction methods used, and whether the crawl was bounded by the safety cap — all from actual runtime data, no fabricated metrics.

---

## Quickstart

### Prerequisites
- Node.js 18 or later
- A free [Groq API key](https://console.groq.com) (optional but recommended for prose documentation)

### 1. Clone the repository

```bash
git clone https://github.com/your-username/parity.git
cd parity
```

### 2. Install dependencies

```bash
cd web
npm install
```

### 3. Configure environment variables

```bash
cp .env.example .env.local
```

Open `.env.local` and fill in your values:

```env
# Required for LLM documentation extraction (free tier works)
GROQ_API_KEY=your_groq_api_key_here

# Optional — raises GitHub API rate limit from 60 to 5,000 requests/hr
GITHUB_TOKEN=your_github_token_here
```

### 4. Run the development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### 5. Try the built-in demo

Click **Inspect Auth Service (Demo)** to run a live audit against the included `dummy-auth-service` fixture. It finds three intentional drifts — a renamed parameter, a mismatched auth scheme, and a wrong response shape — and lets you apply and verify the patches in one flow.

---

## Auditing a Public GitHub Repository

1. Switch to the **Public Repo** tab.
2. Paste a GitHub URL — e.g. `https://github.com/owner/repo`.
3. Set the doc path (default: `README.md`) and code path (default: `src/auth.ts`).
4. Click **Audit Public Repo**.

Parity will discover the repository tree, extract contracts from both sides, compare them deterministically, and display findings with provenance badges showing how each contract was extracted (`REGEX`, `AST`, or `GROQ`).

---

## Supported Languages

| Language | Extraction Method | Frameworks |
|---|---|---|
| TypeScript / JavaScript | Deterministic (AST-level regex) | Express, Next.js API routes |
| Python | Local pattern detection + Groq fallback | FastAPI, Flask |
| Go | Local pattern detection + Groq fallback | Gin, Fiber, net/http |
| Java | Local pattern detection + Groq fallback | Spring MVC |

---

## Drift Classifications

| Type | Severity | Description |
|---|---|---|
| `ROUTE_MISMATCH` | CRITICAL | A documented endpoint has no matching implementation |
| `PARAM_MISMATCH` | CRITICAL | Request body or query parameter names differ |
| `AUTH_MISMATCH` | CRITICAL | Authentication scheme contradicts (e.g. Cookie vs Bearer) |
| `RESPONSE_MISMATCH` | WARNING | Response shape contradicts (e.g. raw array vs wrapped object) |

---

## FAQ

**How does Parity read messy or conversational documentation?**
It tries deterministic regex patterns first — these cover structured formats like `Route: POST /path`, Markdown tables, and code fences. If regex finds no endpoints in a section, that section is sent to a Groq LLM as a targeted extraction request. Groq is only responsible for understanding the *structure* of the documentation, never for deciding whether drift exists.

**Does Parity execute my code or make requests to my service?**
No. Parity does purely static analysis. It reads source files as plain text and parses them with regex and AST-level pattern matching. No server is started, no endpoints are called, and no code is executed.

**What kinds of drift does Parity detect?**
Missing or renamed routes, mismatched request body and query parameter names, contradictory authentication schemes (Bearer vs Cookie vs API Key), and response shape mismatches (raw array vs wrapped JSON object).

**Do I need a paid AI subscription?**
No. Parity works fully offline for TypeScript/JavaScript repositories — the deterministic extractor needs no external services. For prose-heavy documentation in any language, a free-tier Groq API key is sufficient. Groq's free tier covers well beyond what a single audit requires.

**What happens if I hit GitHub API rate limits?**
Parity uses a single GitHub Trees API call to discover repository structure, then fetches only the selected files. Unauthenticated access allows 60 requests per hour, which is enough for most audits. Adding a `GITHUB_TOKEN` in `.env.local` raises the limit to 5,000 requests per hour. Rate-limit errors are surfaced clearly in the UI rather than failing silently.

---

## Project Structure

```
parity/
├── web/                        # Next.js application
│   ├── src/
│   │   ├── app/
│   │   │   ├── api/audit/      # POST /api/audit — main audit endpoint
│   │   │   ├── api/audit-source/ # GET /api/audit-source — demo doc source
│   │   │   └── page.tsx        # Main UI
│   │   ├── lib/
│   │   │   ├── driftEngine.ts  # Deterministic comparison engine
│   │   │   ├── docExtractor.ts # Documentation contract extractor
│   │   │   ├── codeExtractor.ts# Source code contract extractor
│   │   │   └── patchEngine.ts  # Unified diff and patch application
│   │   └── types/
│   │       └── contract.ts     # Normalized ContractEndpoint schema
│   └── .env.example
└── dummy-auth-service/         # Demo fixture with intentional drifts
    ├── README.md               # Documentation (contains 3 drift errors)
    └── src/auth.ts             # TypeScript implementation (ground truth)
```

---

## License

MIT
