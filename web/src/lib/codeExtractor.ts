/**
 * Source-Code Contract Extractor — Section 7
 *
 * Extraction pipeline per spec:
 *   Source File
 *   → Language Detection
 *   → Framework Detection
 *   → Local Static Analysis
 *   → Relevant Contract Structures
 *   → ContractEndpoint
 *
 * Language support levels:
 *   TypeScript/JavaScript — strongest: deterministic AST-level regex (Section 7.B)
 *   Python               — lightweight local candidate detection + targeted Groq fallback (Section 7.C)
 *   Go                   — lightweight local candidate detection + targeted Groq fallback (Section 7.D)
 *   Java                 — lightweight local candidate detection + targeted Groq fallback (Section 7.E)
 *
 * Section 7.F: No Python/Go/Java runtimes or compilers are installed.
 * Section 7.G: Groq receives ONLY the smallest isolated route/handler fragment —
 *              never the whole file, folder, or repository.
 */

import Groq from "groq-sdk";
import type { ContractBundle, ContractEndpoint, HttpMethod } from "@/types/contract";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_TIMEOUT_MS = 15_000;
/** Hard cap on characters sent to Groq per code-fragment call. */
const GROQ_FRAGMENT_MAX_CHARS = 4_000;
/** Lines of context to include around a detected route handler. */
const HANDLER_CONTEXT_LINES = 40;

// ---------------------------------------------------------------------------
// Groq client — shared, lazily initialised
// ---------------------------------------------------------------------------

let _groqClient: Groq | null = null;

function getGroqClient(): Groq | null {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  if (!_groqClient) {
    _groqClient = new Groq({ apiKey: key });
  }
  return _groqClient;
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

export type SupportedLanguage = "typescript" | "javascript" | "python" | "go" | "java" | "unknown";

const EXTENSION_MAP: Record<string, SupportedLanguage> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".java": "java",
};

export function detectLanguage(filePath: string): SupportedLanguage {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return "unknown";
  const ext = filePath.slice(dot).toLowerCase();
  return EXTENSION_MAP[ext] ?? "unknown";
}

// ---------------------------------------------------------------------------
// Framework detection
// ---------------------------------------------------------------------------

export type Framework =
  | "express"
  | "nextjs"
  | "fastapi"
  | "flask"
  | "gin"
  | "fiber"
  | "nethttp"
  | "spring"
  | "unknown";

export function detectFramework(source: string, language: SupportedLanguage): Framework {
  switch (language) {
    case "typescript":
    case "javascript":
      // Next.js API route — exports named GET/POST/PUT/PATCH/DELETE handlers
      if (/export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/.test(source) ||
          /export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=/.test(source)) {
        return "nextjs";
      }
      // Express — router.get/post/put/patch/delete or app.get/post...
      if (/\b(router|app)\.(get|post|put|patch|delete)\s*\(/.test(source)) {
        return "express";
      }
      return "unknown";

    case "python":
      if (/@(app|router)\.(get|post|put|patch|delete)\s*\(/.test(source)) {
        return /from\s+fastapi|import\s+fastapi/i.test(source) ? "fastapi" : "flask";
      }
      if (/from\s+flask|import\s+flask/i.test(source)) return "flask";
      if (/from\s+fastapi|import\s+fastapi/i.test(source)) return "fastapi";
      return "unknown";

    case "go":
      if (/gin\.Default\(\)|gin\.New\(\)|gin\.RouterGroup/.test(source)) return "gin";
      if (/fiber\.New\(\)|fiber\.App/.test(source)) return "fiber";
      if (/http\.HandleFunc\s*\(|http\.Handle\s*\(|mux\.HandleFunc/.test(source)) return "nethttp";
      return "unknown";

    case "java":
      if (/@(Get|Post|Put|Patch|Delete|Request)Mapping/.test(source)) return "spring";
      return "unknown";

    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// HTTP method helpers
// ---------------------------------------------------------------------------

const HTTP_METHODS = new Set<string>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function isHttpMethod(value: string): value is HttpMethod {
  return HTTP_METHODS.has(value.toUpperCase());
}

// ---------------------------------------------------------------------------
// Section 7.B — TypeScript / JavaScript deterministic extractor
// ---------------------------------------------------------------------------

/**
 * Patterns for Express-style route registrations.
 *   router.get('/path', ...)   app.post('/path', ...)
 */
const EXPRESS_ROUTE_RE = /\b(?:router|app)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi;

/**
 * Patterns for Next.js route handlers (file-based or named exports).
 *   export async function POST(req: NextRequest)
 *   export const GET = async (req) => { ... }
 */
const NEXTJS_HANDLER_RE = /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g;

/** JSDoc route annotation: "* POST /api/v1/auth/login" */
const JSDOC_ROUTE_RE = /\*\s*(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)/gi;

/** req.body destructuring: const { email, password } = req.body */
const DESTRUCTURE_BODY_RE = /const\s*\{([^}]+)\}\s*=\s*req\.body/g;

/** Interface field: "  fieldName: type;" inside a body/param interface */
const INTERFACE_FIELD_RE = /^\s{2,}([a-zA-Z_][a-zA-Z0-9_]*):\s*\w[\w<>,\s|]*;/;

/** Bearer token check in code */
const BEARER_CODE_RE = /Bearer/i;
/** Cookie / session in code */
const COOKIE_CODE_RE = /(?:session|Set-Cookie)/i;
/** res.json({ — wrapped object response */
const WRAPPED_JSON_RE = /res\.(?:status\s*\(\s*\d+\s*\)\s*\.)?json\s*\(\s*\{/;
/** res.json(identifier — raw array/variable response */
const RAW_ARRAY_JSON_RE = /res\.(?:status\s*\(\s*\d+\s*\)\s*\.)?json\s*\(\s*[A-Za-z_$]/;
/** return NextResponse.json({ — wrapped object */
const NEXT_WRAPPED_RE = /NextResponse\.json\s*\(\s*\{/;
/** return NextResponse.json(variable — raw array */
const NEXT_RAW_RE = /NextResponse\.json\s*\(\s*[A-Za-z_$]/;

/**
 * Extract API-relevant interface blocks (for parameter detection).
 * Returns a map of interface name → field names.
 */
/**
 * Parse all interface declarations in a file.
 * Returns a Map of interface name → { fields, startLine, endLine } so callers
 * can check whether a handler body actually references the interface by name
 * before attributing its fields to that handler.
 */
interface InterfaceInfo {
  fields: string[];
  startLine: number; // 1-based, line of the "interface Foo {" declaration
  endLine: number;   // 1-based, line of the closing "}"
}

function extractInterfaces(lines: string[]): Map<string, InterfaceInfo> {
  const interfaces = new Map<string, InterfaceInfo>();
  let current: string | null = null;
  let fields: string[] = [];
  let startLine = 0;
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (current === null) {
      const m = /interface\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/.exec(line);
      if (m) {
        current = m[1];
        fields = [];
        startLine = i + 1; // 1-based
        depth = 1;
      }
    } else {
      for (const ch of line) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      if (depth <= 0) {
        interfaces.set(current, { fields, startLine, endLine: i + 1 });
        current = null;
        depth = 0;
      } else {
        const fm = INTERFACE_FIELD_RE.exec(line);
        if (fm) fields.push(fm[1]);
      }
    }
  }
  return interfaces;
}

// Patterns for query/path params (scoped to handler body only, used for GET)
const DESTRUCTURE_QUERY_RE = /const\s*\{([^}]+)\}\s*=\s*req\.query/g;
const DESTRUCTURE_PARAMS_RE = /const\s*\{([^}]+)\}\s*=\s*req\.params/g;

export function extractTypeScriptContracts(source: string, sourceFile: string): ContractEndpoint[] {
  const lines = source.split("\n");
  const endpoints: ContractEndpoint[] = [];

  const interfaces = extractInterfaces(lines);

  // Determine framework to guide extraction
  const framework = detectFramework(source, "typescript");

  // Collect routes with their line numbers
  const routes: Array<{ method: HttpMethod; path: string; lineNumber: number }> = [];

  if (framework === "express") {
    let m: RegExpExecArray | null;
    EXPRESS_ROUTE_RE.lastIndex = 0;
    while ((m = EXPRESS_ROUTE_RE.exec(source)) !== null) {
      const method = m[1].toUpperCase();
      if (!isHttpMethod(method)) continue;
      const lineNumber = source.slice(0, m.index).split("\n").length;
      routes.push({ method, path: m[2], lineNumber });
    }
  }

  if (framework === "nextjs") {
    const routePath = filePathToNextjsRoute(sourceFile);
    let m: RegExpExecArray | null;
    NEXTJS_HANDLER_RE.lastIndex = 0;
    while ((m = NEXTJS_HANDLER_RE.exec(source)) !== null) {
      const method = m[1].toUpperCase() as HttpMethod;
      const lineNumber = source.slice(0, m.index).split("\n").length + 1;
      routes.push({ method, path: routePath, lineNumber });
    }
  }

  // Always scan JSDoc annotations (used in the demo service and many TS codebases)
  {
    let m: RegExpExecArray | null;
    JSDOC_ROUTE_RE.lastIndex = 0;
    while ((m = JSDOC_ROUTE_RE.exec(source)) !== null) {
      const method = m[1].toUpperCase();
      if (!isHttpMethod(method)) continue;
      const lineNumber = source.slice(0, m.index).split("\n").length + 1;
      if (!routes.some((r) => r.method === method && r.path === m![2])) {
        routes.push({ method, path: m[2], lineNumber });
      }
    }
  }

  // Sort routes by line number so we can compute tight handler boundaries
  routes.sort((a, b) => a.lineNumber - b.lineNumber);

  for (let ri = 0; ri < routes.length; ri++) {
    const route = routes[ri];
    const ep: ContractEndpoint = {
      path: route.path,
      method: route.method,
      params: [],
      sourceFile,
      lineNumber: route.lineNumber,
      sourceType: "implementation",
      extractionMethod: "REGEX",
    };

    // --- Fix 2: tight handler body extraction ---
    // Bound the scan region to the actual function body of this handler,
    // stopping before the next route declaration so we never bleed into
    // sibling handlers in the same file.
    const nextRouteStart = ri + 1 < routes.length ? routes[ri + 1].lineNumber - 1 : lines.length;
    const handlerBody = extractHandlerBody(lines, route.lineNumber, nextRouteStart);

    // --- Fix 3: GET routes only get query/path params, not body params ---
    const isGetLike = route.method === "GET" || route.method === "DELETE";

    if (!isGetLike) {
      // POST / PUT / PATCH — scan req.body destructuring
      let m: RegExpExecArray | null;
      DESTRUCTURE_BODY_RE.lastIndex = 0;
      while ((m = DESTRUCTURE_BODY_RE.exec(handlerBody)) !== null) {
        const fields = m[1].split(",").map((f) => f.trim()).filter(Boolean);
        for (const f of fields) {
          if (!ep.params.includes(f)) ep.params.push(f);
        }
      }
    }

    // All methods: scan req.query and req.params
    for (const re of [DESTRUCTURE_QUERY_RE, DESTRUCTURE_PARAMS_RE]) {
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(handlerBody)) !== null) {
        const fields = m[1].split(",").map((f) => f.trim()).filter(Boolean);
        for (const f of fields) {
          if (!ep.params.includes(f)) ep.params.push(f);
        }
      }
    }

    // --- Fix 1: interface fields only when the handler body references the interface name ---
    if (!isGetLike) {
      for (const [name, info] of interfaces) {
        if (!/body|request|input|dto/i.test(name)) continue;
        // The handler body must contain a reference to this interface name
        // (type annotation, instantiation, or generic usage)
        const nameRe = new RegExp(`\\b${name}\\b`);
        if (nameRe.test(handlerBody)) {
          for (const f of info.fields) {
            if (!ep.params.includes(f)) ep.params.push(f);
          }
        }
      }
    }

    // Auth — scoped to handler body
    if (BEARER_CODE_RE.test(handlerBody) && !COOKIE_CODE_RE.test(handlerBody)) {
      ep.auth = "Bearer";
    } else if (COOKIE_CODE_RE.test(handlerBody)) {
      ep.auth = "Cookie";
    }

    // Response shape — scoped to handler body
    if (WRAPPED_JSON_RE.test(handlerBody) || NEXT_WRAPPED_RE.test(handlerBody)) {
      ep.responseShape = "object";
    } else if (RAW_ARRAY_JSON_RE.test(handlerBody) || NEXT_RAW_RE.test(handlerBody)) {
      ep.responseShape = "array";
    }

    endpoints.push(ep);
  }

  return endpoints;
}

/** Derive a Next.js route path from the source file path. */
function filePathToNextjsRoute(filePath: string): string {
  // e.g. src/app/api/users/route.ts  →  /api/users
  //      app/api/auth/login/route.ts →  /api/auth/login
  const normalized = filePath.replace(/\\/g, "/");
  const match = /\/api\/(.+?)(?:\/route\.[jt]sx?)?$/.exec(normalized);
  if (match) return `/api/${match[1]}`;
  // Fallback: strip src/app prefix and extension
  return "/" + normalized.replace(/^.*?(?:src\/)?(?:app\/)?/, "").replace(/\/route\.[jt]sx?$/, "").replace(/\.[jt]sx?$/, "");
}

/**
 * Extract the actual function body of a handler by brace-counting.
 *
 * Starts scanning from `startLine` (1-based) and walks forward until the
 * opening `{` of the handler function is found, then continues until the
 * matching closing `}`. Never reads past `hardStop` (1-based, exclusive),
 * which is set to the start of the next sibling route — preventing bleed-over
 * into adjacent handlers.
 *
 * Falls back to a 40-line window if no opening brace is found within 10 lines
 * of the declaration (handles arrow-function one-liners etc.).
 */
function extractHandlerBody(lines: string[], startLine: number, hardStop: number): string {
  const from = Math.max(0, startLine - 2); // 0-based
  const stop = Math.min(lines.length, hardStop); // 0-based exclusive

  // Walk forward to find the first `{` that opens the handler body
  let bodyStart = -1;
  let depth = 0;
  for (let i = from; i < stop; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        if (depth === 0) bodyStart = i;
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0 && bodyStart >= 0) {
          // Found the complete handler body [bodyStart, i]
          return lines.slice(bodyStart, i + 1).join("\n");
        }
      }
    }
  }

  // No clean brace-matched body found — fall back to a capped window
  const fallbackTo = Math.min(stop, from + HANDLER_CONTEXT_LINES);
  return lines.slice(from, fallbackTo).join("\n");
}

/** Extract a window of lines — kept for Python/Go/Java candidate extraction. */
function extractHandlerRegion(lines: string[], startLine: number, windowSize: number): string {
  const from = Math.max(0, startLine - 2);
  const to = Math.min(lines.length, from + windowSize);
  return lines.slice(from, to).join("\n");
}

// ---------------------------------------------------------------------------
// Section 7.C — Python (FastAPI / Flask) lightweight local extractor
// ---------------------------------------------------------------------------

/**
 * Route decorator patterns:
 *   @app.get("/path")
 *   @router.post("/path")
 *   @api.put("/path")
 *   @bp.delete("/path")
 */
const PYTHON_ROUTE_RE = /@(?:\w+)\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi;

/**
 * Dependency injection parameter patterns (FastAPI):
 *   user: User = Depends(get_current_user)
 *   token: str = Depends(oauth2_scheme)
 */
const FASTAPI_DEPENDS_AUTH_RE = /=\s*Depends\s*\(/i;

export function extractPythonCandidates(source: string): Array<{
  method: string;
  path: string;
  lineNumber: number;
  fragment: string;
}> {
  const lines = source.split("\n");
  const candidates: Array<{ method: string; path: string; lineNumber: number; fragment: string }> = [];

  let m: RegExpExecArray | null;
  PYTHON_ROUTE_RE.lastIndex = 0;
  while ((m = PYTHON_ROUTE_RE.exec(source)) !== null) {
    const method = m[1].toUpperCase();
    const path = m[2];
    const lineNumber = source.slice(0, m.index).split("\n").length + 1;
    // Extract the smallest relevant function fragment
    const fragment = extractHandlerRegion(lines, lineNumber, HANDLER_CONTEXT_LINES);
    candidates.push({ method, path, lineNumber, fragment });
  }

  return candidates;
}

/**
 * Resolve a Python route candidate deterministically.
 * Returns a ContractEndpoint if enough information can be extracted locally,
 * otherwise returns null so the caller can escalate to Groq.
 */
function resolvePythonLocal(
  candidate: { method: string; path: string; lineNumber: number; fragment: string },
  sourceFile: string
): ContractEndpoint | null {
  if (!isHttpMethod(candidate.method)) return null;

  const ep: ContractEndpoint = {
    path: candidate.path,
    method: candidate.method as HttpMethod,
    params: [],
    sourceFile,
    lineNumber: candidate.lineNumber,
    sourceType: "implementation",
    extractionMethod: "REGEX",
  };

  const fragment = candidate.fragment;

  // Auth: Depends(...) pattern is a clear FastAPI auth signal
  if (FASTAPI_DEPENDS_AUTH_RE.test(fragment)) {
    if (/token|jwt|bearer/i.test(fragment)) {
      ep.auth = "Bearer";
    } else if (/session|cookie/i.test(fragment)) {
      ep.auth = "Cookie";
    } else if (/api_key|apikey|x.api.key/i.test(fragment)) {
      ep.auth = "ApiKey";
    }
  }

  // Params: Pydantic model field declarations (simple heuristic)
  // e.g.   username: str    password: str = Field(...)
  const PYDANTIC_FIELD_RE = /^\s{4}([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*\w/gm;
  let fm: RegExpExecArray | null;
  PYDANTIC_FIELD_RE.lastIndex = 0;
  while ((fm = PYDANTIC_FIELD_RE.exec(fragment)) !== null) {
    const name = fm[1];
    if (!["self", "cls", "request", "response", "db", "session"].includes(name)) {
      if (!ep.params.includes(name)) ep.params.push(name);
    }
  }

  // Response: return {} vs return []
  if (/return\s+\[/.test(fragment)) {
    ep.responseShape = "array";
  } else if (/return\s+\{/.test(fragment) || /JSONResponse\s*\(\s*\{/.test(fragment)) {
    ep.responseShape = "object";
  }

  // We have at minimum method + path — that is sufficient for contract comparison
  return ep;
}

// ---------------------------------------------------------------------------
// Section 7.D — Go (net/http / Gin / Fiber) lightweight local extractor
// ---------------------------------------------------------------------------

/**
 * Route patterns for common Go routers:
 *   http.HandleFunc("/path", handler)
 *   mux.HandleFunc("/path", handler)
 *   router.GET("/path", handler)    (Gin)
 *   router.POST("/path", handler)   (Gin/Fiber)
 *   app.Get("/path", handler)       (Fiber)
 *   app.Post("/path", handler)      (Fiber)
 */
const GO_GIN_FIBER_RE = /(?:router|r|app|api)\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)\s*\(\s*"([^"]+)"/gi;
const GO_NETHTTP_RE = /(?:http|mux|serveMux)\.HandleFunc\s*\(\s*"([^"]+)"\s*,\s*(\w+)/gi;

export function extractGoCandidates(source: string): Array<{
  method: string;
  path: string;
  lineNumber: number;
  fragment: string;
}> {
  const lines = source.split("\n");
  const candidates: Array<{ method: string; path: string; lineNumber: number; fragment: string }> = [];

  // Gin / Fiber explicit method routes
  let m: RegExpExecArray | null;
  GO_GIN_FIBER_RE.lastIndex = 0;
  while ((m = GO_GIN_FIBER_RE.exec(source)) !== null) {
    const method = m[1].toUpperCase();
    const path = m[2];
    const lineNumber = source.slice(0, m.index).split("\n").length + 1;
    const fragment = extractHandlerRegion(lines, lineNumber, HANDLER_CONTEXT_LINES);
    candidates.push({ method, path, lineNumber, fragment });
  }

  // net/http HandleFunc — method inferred from handler body or left as unknown
  GO_NETHTTP_RE.lastIndex = 0;
  while ((m = GO_NETHTTP_RE.exec(source)) !== null) {
    const path = m[1];
    const lineNumber = source.slice(0, m.index).split("\n").length + 1;
    const fragment = extractHandlerRegion(lines, lineNumber, HANDLER_CONTEXT_LINES);
    // Try to infer method from r.Method checks in the handler body
    const inferredMethod = inferGoMethod(fragment);
    candidates.push({ method: inferredMethod, path, lineNumber, fragment });
  }

  return candidates;
}

/** Try to infer the HTTP method from r.Method == "..." checks in a Go handler. */
function inferGoMethod(fragment: string): string {
  const m = /r\.Method\s*==\s*"(GET|POST|PUT|PATCH|DELETE)"/.exec(fragment);
  if (m) return m[1];
  // If handler switches on method, pick the first branch
  const sw = /case\s+"(GET|POST|PUT|PATCH|DELETE)"/.exec(fragment);
  if (sw) return sw[1];
  return "GET"; // conservative default
}

function resolveGoLocal(
  candidate: { method: string; path: string; lineNumber: number; fragment: string },
  sourceFile: string
): ContractEndpoint | null {
  if (!isHttpMethod(candidate.method)) return null;

  const ep: ContractEndpoint = {
    path: candidate.path,
    method: candidate.method as HttpMethod,
    params: [],
    sourceFile,
    lineNumber: candidate.lineNumber,
    sourceType: "implementation",
    extractionMethod: "REGEX",
  };

  const fragment = candidate.fragment;

  // Auth: Bearer token check
  if (/Authorization|Bearer/.test(fragment)) ep.auth = "Bearer";
  else if (/Cookie|session/.test(fragment)) ep.auth = "Cookie";

  // Response: json.NewEncoder / c.JSON / c.Status
  if (/json\.NewEncoder|json\.Marshal|c\.JSON|ctx\.JSON/.test(fragment)) {
    ep.responseShape = /\[\]/.test(fragment) ? "array" : "object";
  }

  return ep;
}

// ---------------------------------------------------------------------------
// Section 7.E — Java (Spring) lightweight local extractor
// ---------------------------------------------------------------------------

/**
 * Spring mapping annotations:
 *   @GetMapping("/path")
 *   @PostMapping("/path")
 *   @PutMapping("/path")
 *   @PatchMapping("/path")
 *   @DeleteMapping("/path")
 *   @RequestMapping(value = "/path", method = RequestMethod.GET)
 */
const SPRING_MAPPING_RE = /@(Get|Post|Put|Patch|Delete)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/gi;
const SPRING_REQUEST_MAPPING_RE = /@RequestMapping\s*\([^)]*value\s*=\s*["']([^"']+)["'][^)]*method\s*=\s*RequestMethod\.(GET|POST|PUT|PATCH|DELETE)/gi;

export function extractJavaCandidates(source: string): Array<{
  method: string;
  path: string;
  lineNumber: number;
  fragment: string;
}> {
  const lines = source.split("\n");
  const candidates: Array<{ method: string; path: string; lineNumber: number; fragment: string }> = [];

  let m: RegExpExecArray | null;

  // @GetMapping / @PostMapping etc.
  SPRING_MAPPING_RE.lastIndex = 0;
  while ((m = SPRING_MAPPING_RE.exec(source)) !== null) {
    const verb = m[1].toUpperCase() as HttpMethod;
    const path = m[2];
    const lineNumber = source.slice(0, m.index).split("\n").length + 1;
    const fragment = extractHandlerRegion(lines, lineNumber, HANDLER_CONTEXT_LINES);
    candidates.push({ method: verb, path, lineNumber, fragment });
  }

  // @RequestMapping with explicit method
  SPRING_REQUEST_MAPPING_RE.lastIndex = 0;
  while ((m = SPRING_REQUEST_MAPPING_RE.exec(source)) !== null) {
    const path = m[1];
    const method = m[2].toUpperCase();
    const lineNumber = source.slice(0, m.index).split("\n").length + 1;
    const fragment = extractHandlerRegion(lines, lineNumber, HANDLER_CONTEXT_LINES);
    candidates.push({ method, path, lineNumber, fragment });
  }

  return candidates;
}

function resolveJavaLocal(
  candidate: { method: string; path: string; lineNumber: number; fragment: string },
  sourceFile: string
): ContractEndpoint | null {
  if (!isHttpMethod(candidate.method)) return null;

  const ep: ContractEndpoint = {
    path: candidate.path,
    method: candidate.method as HttpMethod,
    params: [],
    sourceFile,
    lineNumber: candidate.lineNumber,
    sourceType: "implementation",
    extractionMethod: "REGEX",
  };

  const fragment = candidate.fragment;

  // Auth: @PreAuthorize, @Secured, or Authorization header checks
  if (/@PreAuthorize|@Secured|Authorization/.test(fragment)) ep.auth = "Bearer";
  else if (/HttpSession|@CookieValue/.test(fragment)) ep.auth = "Cookie";

  // Params: @RequestBody fields from DTO hint (class fields)
  const DTO_FIELD_RE = /private\s+\w[\w<>]*\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*;/g;
  let fm: RegExpExecArray | null;
  DTO_FIELD_RE.lastIndex = 0;
  while ((fm = DTO_FIELD_RE.exec(fragment)) !== null) {
    const name = fm[1];
    if (!ep.params.includes(name)) ep.params.push(name);
  }

  // Response: ResponseEntity<List<...>> vs ResponseEntity<...>
  if (/ResponseEntity\s*<\s*List/.test(fragment) || /List</.test(fragment)) {
    ep.responseShape = "array";
  } else if (/ResponseEntity|@ResponseBody/.test(fragment)) {
    ep.responseShape = "object";
  }

  return ep;
}

// ---------------------------------------------------------------------------
// Section 7.G — Targeted Groq fallback for code
// ---------------------------------------------------------------------------

const GROQ_CODE_SYSTEM_PROMPT = `You are an API contract extraction engine analyzing a small source code fragment.
Your ONLY job is to identify API endpoint contracts in the fragment.

Rules:
- Return ONLY a JSON object matching the schema — no prose, no markdown.
- Do NOT invent fields. Extract only what is explicitly present.
- params is an array of request body / query parameter name strings.
- auth: "Bearer" | "Cookie" | "ApiKey" | "None" | null.
- responseShape: "array" | "object" | null.
- method: GET | POST | PUT | PATCH | DELETE.
- You must NOT decide whether drift exists — only extract the contract.

Schema:
{
  "endpoints": [
    {
      "path": "/api/...",
      "method": "POST",
      "params": ["field1"],
      "auth": "Bearer" | null,
      "responseShape": "object" | null
    }
  ]
}`;

function validateCodeBundle(raw: unknown): ContractBundle | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.endpoints)) return null;

  const endpoints: ContractEndpoint[] = [];
  for (const item of obj.endpoints) {
    if (typeof item !== "object" || item === null) continue;
    const ep = item as Record<string, unknown>;
    if (typeof ep.path !== "string" || !ep.path) continue;
    const method = typeof ep.method === "string" ? ep.method.toUpperCase() : "";
    if (!isHttpMethod(method)) continue;

    const params: string[] = Array.isArray(ep.params)
      ? ep.params.filter((p): p is string => typeof p === "string")
      : [];

    const authRaw = ep.auth;
    const auth =
      authRaw === "Bearer" || authRaw === "Cookie" || authRaw === "ApiKey" || authRaw === "None"
        ? (authRaw as ContractEndpoint["auth"])
        : authRaw === null || authRaw === undefined
        ? undefined
        : String(authRaw);

    const responseShape =
      ep.responseShape === "array" || ep.responseShape === "object" ? ep.responseShape : undefined;

    endpoints.push({
      path: ep.path,
      method,
      params,
      ...(auth !== undefined ? { auth } : {}),
      ...(responseShape !== undefined ? { responseShape } : {}),
      sourceFile: "",
      sourceType: "implementation",
      extractionMethod: "GROQ",
    });
  }

  return { endpoints };
}

/**
 * Send a small isolated code fragment to Groq.
 * Returns the parsed bundle or null on any failure.
 * Fragment is hard-capped at GROQ_FRAGMENT_MAX_CHARS.
 */
async function extractCodeWithGroq(
  fragment: string,
  language: SupportedLanguage
): Promise<ContractBundle | null> {
  const client = getGroqClient();
  if (!client) return null;

  const bounded =
    fragment.length > GROQ_FRAGMENT_MAX_CHARS ? fragment.slice(0, GROQ_FRAGMENT_MAX_CHARS) : fragment;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);

    let responseText: string;
    try {
      const completion = await client.chat.completions.create(
        {
          model: GROQ_MODEL,
          messages: [
            { role: "system", content: GROQ_CODE_SYSTEM_PROMPT },
            {
              role: "user",
              content: `Language: ${language}\n\nSource fragment:\n\`\`\`${language}\n${bounded}\n\`\`\``,
            },
          ],
          temperature: 0,
          max_tokens: 512,
          response_format: { type: "json_object" },
        },
        { signal: controller.signal }
      );
      responseText = completion.choices[0]?.message?.content ?? "";
    } finally {
      clearTimeout(timer);
    }

    if (!responseText) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      return null;
    }

    return validateCodeBundle(parsed);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract a ContractBundle from a source code file.
 *
 * For TypeScript/JavaScript: full deterministic extraction (Section 7.B).
 * For Python/Go/Java: local candidate detection first; Groq only if local
 *   extraction cannot resolve the contract (Section 7.C–E, 7.G).
 *
 * No Python/Go/Java compiler is invoked (Section 7.F).
 */
export async function extractCodeContracts(
  source: string,
  sourceFile: string
): Promise<ContractBundle & { language: SupportedLanguage; framework: Framework }> {
  const language = detectLanguage(sourceFile);
  const framework = detectFramework(source, language);

  // -- TypeScript / JavaScript: deterministic, no Groq needed -----------------
  if (language === "typescript" || language === "javascript") {
    const endpoints = extractTypeScriptContracts(source, sourceFile);
    return { endpoints, language, framework };
  }

  // -- Python ------------------------------------------------------------------
  if (language === "python") {
    const candidates = extractPythonCandidates(source);
    const endpoints: ContractEndpoint[] = [];

    for (const candidate of candidates) {
      const local = resolvePythonLocal(candidate, sourceFile);
      if (local) {
        endpoints.push(local);
      } else {
        // Local extraction could not resolve contract — targeted Groq fallback (Section 7.G)
        const groqResult = await extractCodeWithGroq(candidate.fragment, language);
        if (groqResult) {
          for (const ep of groqResult.endpoints) {
            endpoints.push({ ...ep, sourceFile, lineNumber: candidate.lineNumber });
          }
        }
      }
    }

    return { endpoints, language, framework };
  }

  // -- Go ----------------------------------------------------------------------
  if (language === "go") {
    const candidates = extractGoCandidates(source);
    const endpoints: ContractEndpoint[] = [];

    for (const candidate of candidates) {
      const local = resolveGoLocal(candidate, sourceFile);
      if (local) {
        endpoints.push(local);
      } else {
        const groqResult = await extractCodeWithGroq(candidate.fragment, language);
        if (groqResult) {
          for (const ep of groqResult.endpoints) {
            endpoints.push({ ...ep, sourceFile, lineNumber: candidate.lineNumber });
          }
        }
      }
    }

    return { endpoints, language, framework };
  }

  // -- Java --------------------------------------------------------------------
  if (language === "java") {
    const candidates = extractJavaCandidates(source);
    const endpoints: ContractEndpoint[] = [];

    for (const candidate of candidates) {
      const local = resolveJavaLocal(candidate, sourceFile);
      if (local) {
        endpoints.push(local);
      } else {
        const groqResult = await extractCodeWithGroq(candidate.fragment, language);
        if (groqResult) {
          for (const ep of groqResult.endpoints) {
            endpoints.push({ ...ep, sourceFile, lineNumber: candidate.lineNumber });
          }
        }
      }
    }

    return { endpoints, language, framework };
  }

  // Unknown language — return empty bundle
  return { endpoints: [], language, framework };
}
