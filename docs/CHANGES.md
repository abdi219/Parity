# Specification: Parity Engine Upgrade (Repository Audit, Multi-Language Contracts & Hybrid Extraction)

## Objective

Upgrade Parity from a single-file TypeScript regex demo into a repository-level API contract auditor supporting folder and repository scans, arbitrary Markdown documentation, multiple backend languages, structured contract extraction, evidence-backed drift detection, and closed-loop verification.

The core architecture must remain deterministic wherever possible.

LLMs are used primarily to understand ambiguous or unstructured documentation. They must not be responsible for deciding whether drift exists.

The system should never send an entire repository or arbitrary folder to an LLM. Source code must first be discovered, classified, and reduced to contract-relevant structures.

Core pipeline:

Repository  
→ Discover Structure  
→ Identify Relevant Documentation & Code  
→ Extract Contracts  
→ Normalize Contracts  
→ Deterministic Drift Analysis  
→ Evidence  
→ Patch  
→ Re-Audit  
→ Verify

---

## 1. Environment & Dependencies

- Add Groq SDK support:
  ```bash
  npm install groq-sdk
  ```

- `.env.local`:
  ```env
  GROQ_API_KEY=your_groq_api_key_here
  GITHUB_TOKEN=your_github_token_here
  ```

- `GITHUB_TOKEN` is optional.
- If `GITHUB_TOKEN` is present, use it for authenticated GitHub API requests.
- If `GITHUB_TOKEN` is missing, continue with unauthenticated GitHub access and handle rate-limit errors gracefully.
- Never expose `GROQ_API_KEY` or `GITHUB_TOKEN` to the client/browser.
- Graceful degradation if either key is missing.
- App must remain usable without Groq for deterministic paths.
- Groq usage must be targeted and bounded.
- Never send an entire repository or arbitrary folder to Groq.

---

## 2. UI & Fetching Layer

### A. Clear All

Reset:

- `repoUrl`
- `docPath`
- `codePath`
- findings
- audit log
- error/status state
- repository map
- discovered files
- contract extraction state
- patch state
- verification state

### B. URL Sanitization

- Strip unnecessary wrappers.
- Normalize GitHub root URLs.
- Handle `/blob/` and `/tree/` URLs safely.
- Prevent accidental inclusion of irrelevant subpaths when repository-level analysis is requested.

### C. Cache Buster

For raw GitHub content where appropriate:

```text
raw.githubusercontent.com/...?...t=${Date.now()}
```

Use appropriate `Cache-Control` / `Pragma` headers when needed.

### D. Request Budget

- Avoid one GitHub API request per discovered file when possible.
- Use the GitHub Trees API to discover repository structure in a single structural request where possible.
- Fetch only files selected for analysis.
- Cache fetched file contents during a single audit.
- Never repeatedly fetch the same file during one audit.
- Surface rate-limit errors clearly instead of silently failing.

---

## 3. Repository Discovery & Scope Analysis

- Repository discovery via GitHub Trees API.
- Classify files as:
  - Documentation
  - API / route implementation
  - Controllers / handlers
  - Middleware
  - Models / DTOs / types
  - Configuration
  - Tests
  - Generated / dependency files
  - Other

### Documentation Priority

Prioritize:

- `README.md`
- `README.mdx`
- `docs/**/*.md`
- `docs/**/*.mdx`
- `openapi.yaml`
- `openapi.yml`
- `openapi.json`
- API-specific Markdown documentation

### Source Priority

Prioritize:

- `src/routes`
- `src/controllers`
- `src/api`
- `src/handlers`
- `src/middleware`
- `src/types`
- `src/models`
- `routes`
- `controllers`
- `api`
- `handlers`

### Ignored Paths

Ignore by default:

- `node_modules`
- `dist`
- `build`
- `.git`
- generated output
- binary files
- lock files
- large static assets
- `coverage`
- `tests`
- `__tests__`

Tests may be included only when explicitly required to understand a contract relationship.

### Repository Map

Generate a concise repository map showing:

- discovered files
- documentation files
- API-relevant source files
- ignored directories
- supported languages
- extraction methods

Do not display fabricated metrics. All counts must come from actual runtime analysis.

---

## 4. Multi-File & Folder Crawling

- `codePath` may represent a file, directory, or repository root.
- If a directory/repository root is supplied:
  - discover the tree
  - filter supported source files
  - exclude ignored paths
  - prioritize API-relevant files
  - fetch relevant files
  - analyze files independently
  - aggregate results into a `ContractBundle`

### File Selection Rules

Do not blindly analyze every file.

Prioritize:

1. route files
2. controllers / handlers
3. middleware
4. request / DTO models
5. response models
6. OpenAPI specifications
7. related type definitions

Lower priority:

- unrelated utilities
- UI code
- configuration
- generic helpers
- unrelated business logic

Fetch additional files only when a contract relationship requires them.

### Crawl Safety Cap

To prevent excessive API calls and serverless execution time:

- Default maximum API-relevant source files analyzed per repository scan: **10**
- Default maximum documentation files analyzed per repository scan: **5**
- Prefer the highest-priority files first.
- Allow the architecture to support a configurable limit later.
- If more relevant files exist than the cap, clearly report that the scan was bounded.
- Do not silently claim that the entire repository was analyzed when the safety cap was reached.

### No Large LLM Payloads

Never concatenate an entire directory or repository into a single LLM request.

Each source file must first be reduced to contract-relevant structures locally or through a targeted extraction step.

---

## 5. Universal Normalized Contract Schema

```ts
export interface ContractEndpoint {
  path: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  params: string[];
  auth?: "Bearer" | "Cookie" | "ApiKey" | "None" | string;
  responseShape?: "array" | "object" | string;
  sourceFile: string;
  lineNumber?: number;
  sourceType?: "documentation" | "implementation";
  extractionMethod?: "AST" | "REGEX" | "OPENAPI" | "GROQ";
}

export interface ContractBundle {
  endpoints: ContractEndpoint[];
}
```

Every contract must retain provenance.

The system must know:

- which file produced the contract
- which line produced the contract where available
- whether the source was documentation or implementation
- which extraction method produced it

---

## 6. Hybrid Extraction Engine

### A. Documentation Extractor (`lib/docExtractor.ts`)

Groq is primarily responsible for understanding ambiguous or unstructured documentation.

Supported documentation structures:

- prose
- paragraphs
- tables
- bullets
- code fences
- endpoint descriptions
- authentication descriptions
- request descriptions
- response descriptions

### Extraction Flow

```text
Markdown File
→ Local Markdown Parsing
→ Identify API-Relevant Sections
→ Deterministic Extraction Where Possible
→ Groq Only for Ambiguous / Prose-Heavy Sections
→ ContractBundle JSON
→ Schema Validation
→ Attach File + Line Provenance
```

Requirements:

- Use `llama-3.3-70b-versatile`.
- Request only structured `ContractBundle` JSON.
- Do not allow the model to invent unsupported endpoints or fields.
- Validate the returned structure before accepting it.
- If Groq is unavailable, fails, times out, or returns invalid JSON:
  - fall back to deterministic Markdown/code-fence extraction
  - continue the audit where possible
  - clearly identify the fallback extraction method

Groq should receive only the relevant documentation section, not an entire repository.

---

## 7. Deterministic Source-Code Analysis

### A. Core Principle

Analyze locally whenever deterministic extraction is practical.

Do not use Groq simply to discover obvious routes in TypeScript/JavaScript.

The pipeline is:

```text
Source File
→ Language Detection
→ Framework Detection
→ Local Static Analysis
→ Relevant Contract Structures
→ ContractEndpoint
```

### B. TypeScript / JavaScript

Provide the deepest deterministic support for:

- TypeScript
- JavaScript
- Express
- Next.js API routes

Use AST/static analysis where practical, with deterministic regex/parsing fallback.

Extract where detectable:

- HTTP method
- route path
- body/query/path parameters
- authentication middleware
- authentication headers
- cookies
- response structure
- source file
- line number

### C. Python

Support representative patterns for:

- FastAPI
- Flask

Do **not** require Python compiler/runtime installation inside the Node.js application.

Use a two-stage approach:

1. **Lightweight local candidate detection**
   - Scan source text for route decorators and obvious API patterns.
   - Detect patterns such as `@app.get(...)`, `@app.post(...)`, `@router.get(...)`, and `@router.post(...)`.
   - Identify the smallest relevant function/route region.
   - Do not attempt full Python AST parsing inside the Next.js deployment.

2. **Targeted Groq fallback**
   - Only if local inspection cannot determine the required contract details.
   - Send only the small relevant route/function fragment.
   - Never send the entire Python file merely because it contains one API route.
   - Never send an entire controller/module/folder.

Extract where detectable:

- route decorators
- HTTP methods
- paths
- request models
- authentication dependencies
- response structures

### D. Go

Support representative patterns for:

- `net/http`
- Gin
- Fiber

Do **not** install or bundle a Go compiler/toolchain into the Next.js application.

Use a two-stage approach:

1. **Lightweight local candidate detection**
   - Scan source text for route registration patterns.
   - Detect patterns such as `http.HandleFunc(...)`, `router.GET(...)`, `router.POST(...)`, and equivalent framework patterns.
   - Identify the smallest relevant handler region.
   - Do not attempt full Go AST/toolchain execution inside the Next.js deployment.

2. **Targeted Groq fallback**
   - Only if local inspection cannot determine the required contract details.
   - Send only the small relevant handler fragment and minimum surrounding context.
   - Never send the entire Go source file merely because it contains one API route.
   - Never send an entire package/folder.

Extract where detectable:

- routes
- HTTP methods
- handlers
- request structures
- middleware
- response structures

### E. Java

Support representative patterns for:

- Spring mappings
- controller classes
- DTOs

Do **not** install or bundle a Java compiler/JDK into the Next.js application.

Use a two-stage approach:

1. **Lightweight local candidate detection**
   - Scan source text for Spring mapping annotations.
   - Detect patterns such as `@GetMapping(...)`, `@PostMapping(...)`, and `@RequestMapping(...)`.
   - Identify the smallest relevant controller method/class region.
   - Do not attempt full Java AST parsing or JDK execution inside the Next.js deployment.

2. **Targeted Groq fallback**
   - Only if local inspection cannot determine the required contract details.
   - Send only the small relevant controller/method fragment.
   - Never send the entire Java source file merely because it contains one API endpoint.
   - Never send an entire controller package/folder.

Extract where detectable:

- endpoint paths
- HTTP methods
- DTO fields
- authentication annotations/middleware where detectable
- response types

### F. Multi-Language Grounding Rule

The Node.js/Next.js application must not attempt to install full language toolchains solely to analyze repository source files.

Do not add:

- Python runtimes
- Go compilers
- Java JDKs
- native compiler toolchains

to `package.json`, Vercel configuration, or the deployment environment.

For the hackathon MVP:

- TypeScript/JavaScript gets the strongest local deterministic analysis.
- Python/Go/Java first use lightweight local pattern detection to find API candidates.
- Groq is used only when local extraction cannot resolve the required contract details.
- Groq receives only the smallest relevant code fragment, not the whole source file, controller, module, folder, or repository.
- The normalized `ContractEndpoint` schema remains identical across languages.
- All extraction results must preserve provenance.

### G. Targeted LLM Fallback for Code

Groq must **not** become the primary parser for Python, Go, or Java.

Use Groq only after lightweight local filtering has identified a specific unresolved API construct.

Required flow:

```text
Source File
→ Lightweight Local Pattern Detection
→ Identify Candidate Route
→ Extract Small Relevant Code Region
→ Can Local Extraction Resolve Contract?
      ↓ YES                    ↓ NO
  Use Local Result       Send Small Fragment to Groq
      ↓                         ↓
      └──────────────→ ContractEndpoint
                              ↓
                    Deterministic Drift Engine
```

Rules:

- Never send the entire repository.
- Never send an entire folder.
- Never send an entire controller/module/source file when only one route is relevant.
- Never send unrelated source files.
- First identify the smallest relevant function, handler, controller method, route, or class region locally.
- Send only that fragment plus the minimum surrounding context required.
- Prefer a small bounded fragment, typically only the relevant route/function and nearby declarations needed to understand parameters, authentication, or response structure.
- Require a `ContractBundle`-compatible structured response.
- Mark the result with `extractionMethod = "GROQ"`.
- Treat the result as an extraction candidate, not proof of drift.
- The LLM must never decide that documentation and code contradict each other.
- The deterministic drift engine remains responsible for all contradiction decisions.

---

## 8. Contract Relationship & Evidence Engine

Establish relationships between:

- documentation claims
- endpoints
- route handlers
- controllers
- authentication middleware
- request models
- response models

Retain:

- documentation source
- implementation source
- endpoint
- HTTP method
- request fields
- authentication mechanism
- response structure
- extraction methods
- line numbers where available

Every final finding must be backed by concrete source evidence.

---

## 9. Deterministic Comparison Engine (`lib/driftEngine.ts`)

The LLM must never decide whether drift exists.

Compare normalized contracts deterministically.

### Route Check

Detect:

- path mismatch
- HTTP method mismatch
- documented endpoint missing from implementation

### Parameter Check

Detect:

- missing documented parameters
- undocumented implementation parameters
- parameter name mismatches

### Authentication Check

Detect:

- Bearer vs Cookie
- Bearer vs ApiKey
- authenticated vs unauthenticated
- other clearly contradictory mechanisms

### Response Check

Detect:

- array vs object
- wrapped object vs raw array
- clearly contradictory response structures

### Finding Requirements

Each finding must contain:

- ID
- severity
- endpoint
- documentation file
- documentation line
- documentation claim
- implementation file
- implementation line
- implementation reality
- explanation
- proposed correction

No finding may be emitted without source evidence.

---

## 10. Patch Generation

Generate the smallest documentation correction necessary.

Requirements:

- target only the contradicted text
- do not reformat unrelated documentation
- do not refactor unrelated code
- show the proposed diff
- allow applying the patch to local audit state
- preserve the original evidence
- base the patch on the deterministic finding
- do not allow a free-form LLM rewrite to redefine the finding

---

## 11. Closed-Loop Verification

The workflow must remain:

```text
DETECT
→ PROVE
→ FIX
→ VERIFY
```

Verification must perform a fresh comparison after the patch.

Do not simply mark the previous finding as resolved.

The desired demo flow is:

```text
Repository
→ Audit
→ 3 Drifts Found
→ Inspect Evidence
→ Generate Diff
→ Apply Patch
→ Re-Audit
→ 0 Drifts Remaining
```

---

## 12. Analysis Transparency

Show extraction provenance in the interface.

Examples:

```text
README.md:14 → GROQ
src/routes/auth.ts:21 → AST
openapi.yaml:38 → OPENAPI
```

Do not display fabricated AI confidence scores.

The system should explain **how** evidence was obtained rather than pretending to know an unsupported confidence percentage.

---

## 13. Repository Analysis Summary

Display actual runtime information such as:

- files discovered
- documentation files
- API source files
- endpoints extracted
- ignored directories
- languages detected
- extraction methods used
- whether the crawl was bounded by the safety cap

No fake metrics.

---

## 14. Audit Interface

Organize the interface around evidence rather than chatbot interaction.

Recommended sections:

1. Repository
2. Repository Map
3. Contract Surface
4. Findings
5. Evidence
6. Diff
7. Verification

The interface should feel like a serious developer auditing tool rather than a generic AI chat application.

---

## 15. Error Handling & Graceful Degradation

Handle:

- invalid GitHub URLs
- private repositories
- missing files
- missing branches
- GitHub API failures
- GitHub rate limits
- unsupported languages
- malformed Markdown
- malformed source files
- missing Groq key
- Groq failures
- Groq timeouts
- invalid Groq JSON
- empty repositories
- repositories with no API-relevant files
- repositories exceeding the analysis safety cap
- Vercel/serverless execution constraints

When a failure occurs:

- provide a useful error
- preserve successful partial results where safe
- continue deterministic analysis when possible
- never silently fabricate an extraction result

---

## 16. GitHub API Rate-Limit Protection

GitHub unauthenticated API access may be limited.

Implement the crawler so it minimizes requests.

Requirements:

- Prefer the GitHub Trees API for repository structure discovery.
- Do not make unnecessary per-directory listing requests.
- Cache all fetched files within an audit.
- Never fetch the same path twice during one audit.
- Respect the maximum source/documentation file caps.
- If `GITHUB_TOKEN` is available, use authenticated requests server-side.
- If the API returns a rate-limit response, stop additional GitHub requests and report the issue clearly.
- Do not retry aggressively in a loop.
- The application must remain usable for local/demo repositories even when GitHub fetching is unavailable.

---

## 17. Vercel / Serverless Execution Safety

The application may run in a serverless Next.js environment.

Design the audit workflow to avoid long-running requests.

Requirements:

- Keep repository crawling bounded.
- Fetch independent files concurrently where safe.
- Use `Promise.all()` or controlled concurrency for independent file fetches.
- Do not create unbounded parallel requests.
- Do not perform unnecessary sequential network calls.
- Cache fetched content during the audit.
- Keep Groq calls targeted and minimal.
- Prefer deterministic extraction over multiple LLM calls.
- Avoid sending multiple separate Groq requests for the same documentation section.
- Where practical, aggregate related ambiguous documentation into **one bounded Groq extraction request per audit** rather than making many tiny requests.
- If the audit cannot complete within the available serverless execution budget, fail gracefully with partial evidence rather than hanging or timing out.

Do not assume that a specific Vercel plan timeout is universal. Treat execution limits as deployment-dependent and design conservatively.

---

## 18. Performance & Token-Efficiency Rules

### Never

- send the entire repository to Groq
- concatenate all source files
- concatenate an entire folder
- send `node_modules`
- send `dist`
- send build output
- send unrelated UI code
- send large static assets
- repeat the same file unnecessarily
- make unbounded GitHub requests
- make unbounded Groq requests

### Prefer

- repository structure discovery
- targeted file selection
- local TypeScript/JavaScript analysis
- lightweight local route detection for Python/Go/Java
- extracting the smallest relevant code fragment before any Groq call
- targeted Groq extraction only for unresolved fragments
- API-relevant Markdown
- minimal Groq context
- per-audit caching
- bounded concurrency
- deterministic comparison

Groq is a targeted extraction tool, not the primary drift-analysis engine.

---

## 19. Verification Steps

Before considering the implementation complete:

### Build

```bash
npm run build
```

### Core Demo

Run the canonical repository:

```text
https://github.com/abdi219/parity-test-api
```

Verify:

- repository mapping
- documentation discovery
- TypeScript/JavaScript deterministic extraction
- Python representative fixture
- Go representative fixture
- Java representative fixture
- prose README extraction with Groq
- deterministic Markdown fallback when Groq is unavailable
- targeted Groq fallback for ambiguous source constructs
- no entire-folder/repository concatenation to Groq
- provenance on every extracted contract
- evidence-backed drift findings
- patch generation
- diff display
- patch application
- closed-loop re-audit
- `0` unresolved findings after the canonical patch flow
- Clear All
- UI remains functional without Groq
- GitHub rate-limit handling
- bounded repository crawling
- graceful handling of partial/failed scans

### Bob Grounding Requirements

When implementing this specification in IBM Bob:

- Follow the architecture and boundaries in this document.
- Do not introduce full Python, Go, or Java toolchains into the Next.js project.
- Do not replace deterministic drift comparison with an LLM judgment.
- Do not remove provenance requirements.
- Do not remove the repository crawl safety cap.
- Do not remove GitHub request caching.
- Do not send entire repositories or folders to Groq.
- Keep the canonical demo deterministic and reproducible.

## FAQ

* **Supported Languages:** Full local analysis for TypeScript and JavaScript, plus pattern matching for Python (FastAPI/Flask), Go (Gin/Fiber), and Java (Spring)[cite: 4].
* **Folder & Repo Audits:** Scan single files, specific folders (like `src/routes`), or entire repos with a built-in 10-file safety cap[cite: 4].
* **Privacy & Low Token Use:** Never dumps full repos or folders into an LLM—code is filtered locally first, sending only tiny, unresolved snippets to Groq[cite: 4].
* **Zero AI Hallucinations:** Groq only extracts messy documentation; the actual drift diffing is 100% deterministic code logic with line-level proof[cite: 4].
* **Closed-Loop Verification:** Detects drift, shows exact line evidence, generates a minimal patch, and re-audits down to 0 errors[cite: 4].
* **Offline / No-Key Fallback:** If your Groq key is missing or rate-limited, it automatically falls back to local regex so audits never crash[cite: 4].