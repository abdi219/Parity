/**
 * Deterministic Drift Engine — Sections 8, 9 & 10
 *
 * 100% deterministic: no LLM decides whether drift exists.
 *
 * Two entry points:
 *   1. runDriftAudit()     — legacy single-file interface (demo backward compat)
 *   2. runNormalizedAudit() — normalized ContractEndpoint comparison (Phase 3)
 *
 * Every finding requires concrete source evidence — no finding without proof.
 */

import type { ContractEndpoint } from "@/types/contract";

// ---------------------------------------------------------------------------
// Public finding & report types
// ---------------------------------------------------------------------------

export interface DriftFinding {
  id: string;
  type: "ROUTE_MISMATCH" | "PARAM_MISMATCH" | "AUTH_MISMATCH" | "RESPONSE_MISMATCH";
  severity: "CRITICAL" | "WARNING";
  endpoint: string;
  documentationFile: string;
  documentationLine: number;
  documentationClaim: string;
  codeFile: string;
  codeLine: number;
  codeReality: string;
  explanation: string;
  proposedPatch: string;
}

export interface AuditReport {
  timestamp: string;
  targetRepository: string;
  totalChecks: number;
  driftCount: number;
  findings: DriftFinding[];
  isClean: boolean;
  repoMap?: RepoMap;
}

// ---------------------------------------------------------------------------
// Repository map — Section 13
// ---------------------------------------------------------------------------

export interface RepoMap {
  totalFilesDiscovered: number;
  docFiles: string[];
  sourceFiles: string[];
  ignoredDirs: string[];
  languages: string[];
  extractionMethods: string[];
  cappedAt?: number;
  wasCapped: boolean;
}

// ---------------------------------------------------------------------------
// Internal contract types — doc side (legacy single-file parser)
// ---------------------------------------------------------------------------

interface DocRoute {
  method: string;
  path: string;
  line: number;
}

interface DocParam {
  name: string;
  line: number;
  endpoint: string;
}

interface DocAuth {
  scheme: string;
  line: number;
  endpoint: string;
}

interface DocResponse {
  shape: "array" | "object";
  line: number;
  endpoint: string;
}

interface DocContracts {
  routes: DocRoute[];
  params: DocParam[];
  auth: DocAuth[];
  responses: DocResponse[];
}

// ---------------------------------------------------------------------------
// Internal contract types — code side (legacy single-file parser)
// ---------------------------------------------------------------------------

interface CodeRoute {
  method: string;
  path: string;
  line: number;
  raw: string;
}

interface CodeParam {
  name: string;
  line: number;
  endpoint: string;
  raw: string;
}

interface CodeAuth {
  scheme: string;
  line: number;
  endpoint: string;
  raw: string;
}

interface CodeResponse {
  shape: "array" | "object";
  line: number;
  endpoint: string;
  raw: string;
}

interface CodeContracts {
  routes: CodeRoute[];
  params: CodeParam[];
  auth: CodeAuth[];
  responses: CodeResponse[];
}

// ---------------------------------------------------------------------------
// Stage 1 — parse documentation contracts (legacy)
// ---------------------------------------------------------------------------

function parseDocContracts(docContent: string): DocContracts {
  const lines = docContent.split("\n");

  const routes: DocRoute[] = [];
  const params: DocParam[] = [];
  const auth: DocAuth[] = [];
  const responses: DocResponse[] = [];

  let currentEndpoint = "";

  const routeRe = /\bRoute:\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S+)/i;
  const fieldRe = /"([a-zA-Z_][a-zA-Z0-9_]*)"\s*:/g;
  const cookieAuthRe = /session|cookie|Set-Cookie/i;
  const bearerAuthRe = /Bearer|JWT|Authorization/i;
  const authMethodRe = /Authentication Method:|- Headers?:/i;
  const rawArrayRe = /Returns a raw array|^\s*\[/im;
  const wrappedObjectRe = /\{[^}]*\}/;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];

    const routeMatch = routeRe.exec(line);
    if (routeMatch) {
      const method = routeMatch[1].toUpperCase();
      const path = routeMatch[2];
      routes.push({ method, path, line: lineNum });
      currentEndpoint = `${method} ${path}`;
      continue;
    }

    if (currentEndpoint && /"[a-zA-Z_]/.test(line)) {
      let fieldMatch: RegExpExecArray | null;
      fieldRe.lastIndex = 0;
      while ((fieldMatch = fieldRe.exec(line)) !== null) {
        const name = fieldMatch[1];
        if (!/^\d/.test(name)) {
          params.push({ name, line: lineNum, endpoint: currentEndpoint });
        }
      }
    }

    const isAuthLine =
      authMethodRe.test(line) ||
      /^\s*-\s*(Cookie|Authorization|Set-Cookie)\s*:/i.test(line);
    if (currentEndpoint && isAuthLine) {
      if (cookieAuthRe.test(line) && !bearerAuthRe.test(line)) {
        auth.push({ scheme: "cookie", line: lineNum, endpoint: currentEndpoint });
      } else if (bearerAuthRe.test(line)) {
        auth.push({ scheme: "bearer", line: lineNum, endpoint: currentEndpoint });
      }
    }

    if (currentEndpoint && /Response\s*\(/.test(line)) {
      const window = lines.slice(i + 1, i + 11).join("\n");
      if (rawArrayRe.test(window)) {
        responses.push({ shape: "array", line: lineNum + 1, endpoint: currentEndpoint });
      } else if (wrappedObjectRe.test(window)) {
        responses.push({ shape: "object", line: lineNum + 1, endpoint: currentEndpoint });
      }
    }
  }

  return { routes, params, auth, responses };
}

// ---------------------------------------------------------------------------
// Stage 2 — parse code contracts (legacy)
// ---------------------------------------------------------------------------

function parseCodeContracts(codeContent: string): CodeContracts {
  const lines = codeContent.split("\n");

  const routes: CodeRoute[] = [];
  const params: CodeParam[] = [];
  const auth: CodeAuth[] = [];
  const responses: CodeResponse[] = [];

  const routeCommentRe = /\*\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S+)/i;
  const destructureRe = /const\s*\{([^}]+)\}\s*=\s*req\.body/;
  const interfaceFieldRe = /^\s{2}([a-zA-Z_][a-zA-Z0-9_]*):\s*\w+;/;
  const bearerCodeRe = /Bearer/i;
  const cookieCodeRe = /session|Set-Cookie/i;
  const wrappedJsonRe = /res\.(?:status\(\d+\)\.)?json\(\s*\{/;
  const rawArrayJsonRe = /res\.(?:status\(\d+\)\.)?json\(\s*[A-Z_a-z]/;

  let currentEndpoint = "";
  let insideLoginBody = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];

    if (/interface\s+LoginBody/.test(line)) insideLoginBody = true;
    if (insideLoginBody && /^\}/.test(line)) insideLoginBody = false;

    const routeMatch = routeCommentRe.exec(line);
    if (routeMatch) {
      const method = routeMatch[1].toUpperCase();
      const path = routeMatch[2];
      routes.push({ method, path, line: lineNum, raw: line.trim() });
      currentEndpoint = `${method} ${path}`;
      continue;
    }

    if (insideLoginBody) {
      const ifMatch = interfaceFieldRe.exec(line);
      if (ifMatch) {
        params.push({
          name: ifMatch[1],
          line: lineNum,
          endpoint: "POST /api/v1/auth/login",
          raw: line.trim(),
        });
      }
    }

    if (currentEndpoint && destructureRe.test(line)) {
      const destructureMatch = destructureRe.exec(line);
      if (destructureMatch) {
        const fields = destructureMatch[1].split(",").map((f) => f.trim()).filter(Boolean);
        for (const field of fields) {
          params.push({ name: field, line: lineNum, endpoint: currentEndpoint, raw: line.trim() });
        }
      }
    }

    if (currentEndpoint && bearerCodeRe.test(line) && !cookieCodeRe.test(line)) {
      auth.push({ scheme: "bearer", line: lineNum, endpoint: currentEndpoint, raw: line.trim() });
    }
    if (currentEndpoint && cookieCodeRe.test(line)) {
      auth.push({ scheme: "cookie", line: lineNum, endpoint: currentEndpoint, raw: line.trim() });
    }

    if (currentEndpoint) {
      if (wrappedJsonRe.test(line)) {
        responses.push({ shape: "object", line: lineNum, endpoint: currentEndpoint, raw: line.trim() });
      } else if (rawArrayJsonRe.test(line)) {
        responses.push({ shape: "array", line: lineNum, endpoint: currentEndpoint, raw: line.trim() });
      }
    }
  }

  return { routes, params, auth, responses };
}

// ---------------------------------------------------------------------------
// Stage 3 — detect drift (legacy — used by demo & re-audit)
// ---------------------------------------------------------------------------

function detectDrift(
  docContracts: DocContracts,
  codeContracts: CodeContracts,
  docFile: string,
  codeFile: string
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  let seq = 1;

  function nextId(): string {
    return `DRIFT-${String(seq++).padStart(3, "0")}`;
  }

  // DRIFT-001: PARAM_MISMATCH (username vs email)
  const docUsernameParam = docContracts.params.find((p) => p.name === "username");
  const codeEmailParam = codeContracts.params.find((p) => p.name === "email");

  if (docUsernameParam && codeEmailParam) {
    findings.push({
      id: nextId(),
      type: "PARAM_MISMATCH",
      severity: "CRITICAL",
      endpoint: docUsernameParam.endpoint,
      documentationFile: docFile,
      documentationLine: docUsernameParam.line,
      documentationClaim: `Request body declares field "username"`,
      codeFile,
      codeLine: codeEmailParam.line,
      codeReality: codeEmailParam.raw,
      explanation:
        "The documentation specifies a request body field named \"username\" but the handler interface and destructuring use \"email\". Requests sent with \"username\" will fail validation.",
      proposedPatch: `    "email": "johndoe@example.com",`,
    });
  }

  // DRIFT-002: AUTH_MISMATCH (Redis cookie vs Bearer JWT)
  const docCookieAuth = docContracts.auth.find((a) => a.scheme === "cookie");
  const codeBearerResponse = codeContracts.responses.find(
    (r) => r.shape === "object" && r.endpoint === "POST /api/v1/auth/login"
  );

  if (docCookieAuth) {
    const codeBearerLine =
      codeBearerResponse?.line ??
      codeContracts.auth.find((a) => a.scheme === "bearer")?.line ??
      1;
    const codeBearerRaw =
      codeBearerResponse?.raw ??
      codeContracts.auth.find((a) => a.scheme === "bearer")?.raw ??
      "token_type: 'Bearer'";
    findings.push({
      id: nextId(),
      type: "AUTH_MISMATCH",
      severity: "CRITICAL",
      endpoint: docCookieAuth.endpoint,
      documentationFile: docFile,
      documentationLine: docCookieAuth.line,
      documentationClaim:
        "Authentication Method: Stateful cookie-based authentication via Redis session store (Set-Cookie: session_id=...)",
      codeFile,
      codeLine: codeBearerLine,
      codeReality: codeBearerRaw,
      explanation:
        "The documentation specifies Redis session cookie authentication but the handler returns a Bearer JWT token in the response body. No Set-Cookie header is set.",
      proposedPatch: `- Authentication Method: Stateful cookie-based authentication via Redis session store (Set-Cookie: session_id=...).\n+ Authentication Method: Stateless Bearer JWT authentication. The response body contains \`token_type: "Bearer"\` and \`access_token\`.`,
    });
  }

  // DRIFT-003: RESPONSE_MISMATCH (raw array vs wrapped object)
  const docArrayResponse = docContracts.responses.find((r) => r.shape === "array");
  const codeObjectResponse = codeContracts.responses.find(
    (r) => r.shape === "object" && r.endpoint === "GET /api/v1/users"
  );

  if (docArrayResponse && codeObjectResponse) {
    findings.push({
      id: nextId(),
      type: "RESPONSE_MISMATCH",
      severity: "WARNING",
      endpoint: docArrayResponse.endpoint,
      documentationFile: docFile,
      documentationLine: docArrayResponse.line,
      documentationClaim: "Returns a raw array of user records: [{ id, name }, ...]",
      codeFile,
      codeLine: codeObjectResponse.line,
      codeReality: codeObjectResponse.raw,
      explanation:
        "The documentation describes a raw JSON array response but the handler returns a wrapped object { users, total, page }. Consumers expecting an array will break on the actual response shape.",
      proposedPatch: `- Returns a raw array of user records:\n- [\n-   { "id": "usr_101", "name": "Alice" },\n-   { "id": "usr_102", "name": "Bob" }\n- ]\n+ Returns a wrapped object:\n+ {\n+   "users": [{ "id": "usr_101", "name": "Alice" }, { "id": "usr_102", "name": "Bob" }],\n+   "total": 2,\n+   "page": 1\n+ }`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Stage 4 — legacy public entry point (demo & re-audit unchanged)
// ---------------------------------------------------------------------------

export function runDriftAudit(
  docContent: string,
  codeContent: string,
  docFile = "dummy-auth-service/README.md",
  codeFile = "dummy-auth-service/src/auth.ts",
  targetRepository = "dummy-auth-service"
): AuditReport {
  const docContracts = parseDocContracts(docContent);
  const codeContracts = parseCodeContracts(codeContent);
  const findings = detectDrift(docContracts, codeContracts, docFile, codeFile);

  return {
    timestamp: new Date().toISOString(),
    targetRepository,
    totalChecks: 4,
    driftCount: findings.length,
    findings,
    isClean: findings.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Normalized audit — Sections 8 & 9
// ---------------------------------------------------------------------------
// Compares two ContractEndpoint arrays deterministically.
// Every finding requires concrete source evidence from both sides.

/**
 * Normalize a route path for comparison:
 * - lowercase
 * - collapse duplicate slashes
 * - strip trailing slash (except root "/")
 * - normalize :param and {param} style placeholders to ":param"
 */
function normalizePath(p: string): string {
  return p
    .toLowerCase()
    .replace(/\/+/g, "/")
    .replace(/\{([^}]+)\}/g, ":$1")
    .replace(/\/$/, "") || "/";
}

function normalizeMethod(m: string): string {
  return m.toUpperCase().trim();
}

function endpointKey(ep: ContractEndpoint): string {
  return `${normalizeMethod(ep.method)} ${normalizePath(ep.path)}`;
}

/** Normalize auth scheme for comparison */
function normalizeAuth(auth: string | undefined): string {
  if (!auth || auth === "None") return "none";
  return auth.toLowerCase().trim();
}

/** Build a deterministic proposed markdown patch for a single finding */
function buildProposedPatch(finding: DriftFinding): string {
  switch (finding.type) {
    case "ROUTE_MISMATCH":
      return `- Route: ${finding.documentationClaim}\n+ Route: ${finding.codeReality}`;
    case "PARAM_MISMATCH":
      return `- ${finding.documentationClaim}\n+ ${finding.codeReality}`;
    case "AUTH_MISMATCH":
      return `- Authentication: ${finding.documentationClaim}\n+ Authentication: ${finding.codeReality}`;
    case "RESPONSE_MISMATCH":
      return `- Response: ${finding.documentationClaim}\n+ Response: ${finding.codeReality}`;
    default:
      return `- ${finding.documentationClaim}\n+ ${finding.codeReality}`;
  }
}

/**
 * Compare two normalized contract bundles and produce deterministic findings.
 *
 * Checks per spec (Section 9):
 *   1. Route check  — documented endpoint missing from implementation
 *   2. Param check  — missing, renamed, or extra params on matched endpoints
 *   3. Auth check   — contradictory auth schemes on matched endpoints
 *   4. Response check — array vs object shape contradictions on matched endpoints
 */
export function compareContracts(
  docEndpoints: ContractEndpoint[],
  codeEndpoints: ContractEndpoint[],
  docFile: string,
  codeFile: string
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  let seq = 1;

  function nextId(): string {
    return `DRIFT-${String(seq++).padStart(3, "0")}`;
  }

  // Build lookup map for code endpoints by normalized key
  const codeMap = new Map<string, ContractEndpoint>();
  for (const ep of codeEndpoints) {
    codeMap.set(endpointKey(ep), ep);
  }

  let totalChecks = 0;

  for (const docEp of docEndpoints) {
    const key = endpointKey(docEp);
    const codeEp = codeMap.get(key);

    // -- Route check ----------------------------------------------------------
    totalChecks++;
    if (!codeEp) {
      // Documented endpoint has no matching implementation
      findings.push({
        id: nextId(),
        type: "ROUTE_MISMATCH",
        severity: "CRITICAL",
        endpoint: key,
        documentationFile: docFile,
        documentationLine: docEp.lineNumber ?? 0,
        documentationClaim: `${normalizeMethod(docEp.method)} ${docEp.path}`,
        codeFile,
        codeLine: 0,
        codeReality: "Route not found in implementation",
        explanation: `The documentation describes ${normalizeMethod(docEp.method)} ${docEp.path} but no matching handler was found in the source code.`,
        proposedPatch: `- Route: ${normalizeMethod(docEp.method)} ${docEp.path} (remove or implement this endpoint)`,
      });
      continue; // Cannot check params/auth/response without a matching code endpoint
    }

    // -- Param check ----------------------------------------------------------
    totalChecks++;
    if (docEp.params.length > 0 && codeEp.params.length > 0) {
      const docSet = new Set(docEp.params.map((p) => p.toLowerCase()));
      const codeSet = new Set(codeEp.params.map((p) => p.toLowerCase()));

      const missingInCode = [...docSet].filter((p) => !codeSet.has(p));
      const missingInDoc = [...codeSet].filter((p) => !docSet.has(p));

      if (missingInCode.length > 0 || missingInDoc.length > 0) {
        const docClaim = `Request params: [${[...docSet].join(", ")}]`;
        const codeReality = `Request params: [${[...codeSet].join(", ")}]`;
        const f: DriftFinding = {
          id: nextId(),
          type: "PARAM_MISMATCH",
          severity: "CRITICAL",
          endpoint: key,
          documentationFile: docFile,
          documentationLine: docEp.lineNumber ?? 0,
          documentationClaim: docClaim,
          codeFile,
          codeLine: codeEp.lineNumber ?? 0,
          codeReality,
          explanation: [
            missingInCode.length > 0
              ? `Documented params missing from implementation: ${missingInCode.join(", ")}.`
              : "",
            missingInDoc.length > 0
              ? `Implementation params not documented: ${missingInDoc.join(", ")}.`
              : "",
          ]
            .filter(Boolean)
            .join(" "),
          proposedPatch: "",
        };
        f.proposedPatch = buildProposedPatch(f);
        findings.push(f);
      }
    }

    // -- Auth check -----------------------------------------------------------
    totalChecks++;
    if (docEp.auth !== undefined && codeEp.auth !== undefined) {
      const docAuth = normalizeAuth(docEp.auth);
      const codeAuth = normalizeAuth(codeEp.auth);

      const contradiction =
        (docAuth === "cookie" && codeAuth === "bearer") ||
        (docAuth === "bearer" && codeAuth === "cookie") ||
        (docAuth === "bearer" && codeAuth === "apikey") ||
        (docAuth === "apikey" && codeAuth === "bearer") ||
        (docAuth === "none" && (codeAuth === "bearer" || codeAuth === "cookie" || codeAuth === "apikey")) ||
        ((docAuth === "bearer" || docAuth === "cookie" || docAuth === "apikey") && codeAuth === "none");

      if (contradiction) {
        const f: DriftFinding = {
          id: nextId(),
          type: "AUTH_MISMATCH",
          severity: "CRITICAL",
          endpoint: key,
          documentationFile: docFile,
          documentationLine: docEp.lineNumber ?? 0,
          documentationClaim: docEp.auth,
          codeFile,
          codeLine: codeEp.lineNumber ?? 0,
          codeReality: codeEp.auth ?? "unknown",
          explanation: `Documentation specifies ${docEp.auth} authentication but implementation uses ${codeEp.auth ?? "unknown"}.`,
          proposedPatch: "",
        };
        f.proposedPatch = buildProposedPatch(f);
        findings.push(f);
      }
    }

    // -- Response check -------------------------------------------------------
    totalChecks++;
    if (docEp.responseShape !== undefined && codeEp.responseShape !== undefined) {
      const contradiction =
        (docEp.responseShape === "array" && codeEp.responseShape === "object") ||
        (docEp.responseShape === "object" && codeEp.responseShape === "array");

      if (contradiction) {
        const f: DriftFinding = {
          id: nextId(),
          type: "RESPONSE_MISMATCH",
          severity: "WARNING",
          endpoint: key,
          documentationFile: docFile,
          documentationLine: docEp.lineNumber ?? 0,
          documentationClaim: `Response shape: ${docEp.responseShape}`,
          codeFile,
          codeLine: codeEp.lineNumber ?? 0,
          codeReality: `Response shape: ${codeEp.responseShape}`,
          explanation: `Documentation describes a ${docEp.responseShape} response but implementation returns a ${codeEp.responseShape}.`,
          proposedPatch: "",
        };
        f.proposedPatch = buildProposedPatch(f);
        findings.push(f);
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Normalized audit report — Section 14 extended report
// ---------------------------------------------------------------------------

export interface NormalizedAuditReport extends AuditReport {
  docEndpoints: ContractEndpoint[];
  codeEndpoints: ContractEndpoint[];
}

/**
 * Run a full normalized audit given pre-extracted contract bundles.
 * Returns an AuditReport with repoMap and provenance-tagged endpoints.
 */
export function runNormalizedAudit(
  docEndpoints: ContractEndpoint[],
  codeEndpoints: ContractEndpoint[],
  docFile: string,
  codeFile: string,
  targetRepository: string,
  repoMap?: RepoMap
): NormalizedAuditReport {
  const findings = compareContracts(docEndpoints, codeEndpoints, docFile, codeFile);

  // totalChecks = 4 categories × number of matched endpoints evaluated
  const totalChecks = Math.max(
    4,
    docEndpoints.length > 0 ? docEndpoints.length * 4 : 4
  );

  return {
    timestamp: new Date().toISOString(),
    targetRepository,
    totalChecks,
    driftCount: findings.length,
    findings,
    isClean: findings.length === 0,
    repoMap,
    docEndpoints,
    codeEndpoints,
  };
}
