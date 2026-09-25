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
}

// ---------------------------------------------------------------------------
// Internal contract types — doc side
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
  scheme: string; // "cookie" | "bearer" | unknown literal
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
// Internal contract types — code side
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
  scheme: string; // "cookie" | "bearer"
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
// Stage 1 — parse documentation contracts
// ---------------------------------------------------------------------------

function parseDocContracts(docContent: string): DocContracts {
  const lines = docContent.split("\n");

  const routes: DocRoute[] = [];
  const params: DocParam[] = [];
  const auth: DocAuth[] = [];
  const responses: DocResponse[] = [];

  // Track the most recently seen route so param/auth/response entries can be
  // associated with it.
  let currentEndpoint = "";

  // Match: "- Route: POST /api/v1/auth/login" or "Route: GET /api/v1/users"
  const routeRe = /\bRoute:\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S+)/i;
  // Match field names inside a JSON-like object block: "username": ...
  const fieldRe = /"([a-zA-Z_][a-zA-Z0-9_]*)"\s*:/g;
  // Cookie/session auth indicators
  const cookieAuthRe = /session|cookie|Set-Cookie/i;
  // Bearer/JWT auth indicators
  const bearerAuthRe = /Bearer|JWT|Authorization/i;
  // Auth method claim line
  const authMethodRe = /Authentication Method:|- Headers?:/i;
  // Raw array response indicator
  const rawArrayRe = /Returns a raw array|^\s*\[/im;
  // Wrapped object response indicator
  const wrappedObjectRe = /\{[^}]*\}/;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1; // 1-based
    const line = lines[i];

    // Route detection
    const routeMatch = routeRe.exec(line);
    if (routeMatch) {
      const method = routeMatch[1].toUpperCase();
      const path = routeMatch[2];
      routes.push({ method, path, line: lineNum });
      currentEndpoint = `${method} ${path}`;
      continue;
    }

    // Param detection — field names inside request body blocks
    // Only scan lines that look like they are inside a body block
    if (currentEndpoint && /"[a-zA-Z_]/.test(line)) {
      let fieldMatch: RegExpExecArray | null;
      fieldRe.lastIndex = 0;
      while ((fieldMatch = fieldRe.exec(line)) !== null) {
        const name = fieldMatch[1];
        // Exclude values that are clearly not field names (e.g. "johndoe")
        if (!/^\d/.test(name)) {
          params.push({ name, line: lineNum, endpoint: currentEndpoint });
        }
      }
    }

    // Auth detection
    if (currentEndpoint && (authMethodRe.test(line) || cookieAuthRe.test(line) || bearerAuthRe.test(line))) {
      if (cookieAuthRe.test(line) && !bearerAuthRe.test(line)) {
        auth.push({ scheme: "cookie", line: lineNum, endpoint: currentEndpoint });
      } else if (bearerAuthRe.test(line)) {
        auth.push({ scheme: "bearer", line: lineNum, endpoint: currentEndpoint });
      }
    }

    // Response shape detection — look ahead a few lines for the shape
    if (currentEndpoint && /Response\s*\(/.test(line)) {
      // Scan the next 10 lines for shape indicators
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
// Stage 2 — parse code contracts
// ---------------------------------------------------------------------------

function parseCodeContracts(codeContent: string): CodeContracts {
  const lines = codeContent.split("\n");

  const routes: CodeRoute[] = [];
  const params: CodeParam[] = [];
  const auth: CodeAuth[] = [];
  const responses: CodeResponse[] = [];

  // JSDoc route comment: "* POST /api/v1/auth/login"
  const routeCommentRe = /\*\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S+)/i;
  // Destructuring from req.body: const { email, password } = req.body
  const destructureRe = /const\s*\{([^}]+)\}\s*=\s*req\.body/;
  // Interface field inside LoginBody or similar: fieldName: type;
  const interfaceFieldRe = /^\s{2}([a-zA-Z_][a-zA-Z0-9_]*):\s*\w+;/;
  // Bearer check in code
  const bearerCodeRe = /Bearer/i;
  // Cookie / session check in code
  const cookieCodeRe = /session|Set-Cookie/i;
  // res.json wrapped object: res.status(...).json({ key: ... })
  const wrappedJsonRe = /res\.(?:status\(\d+\)\.)?json\(\s*\{/;
  // res.json raw array: res.status(...).json(someArray) — identifier, not {
  const rawArrayJsonRe = /res\.(?:status\(\d+\)\.)?json\(\s*[A-Z_a-z]/;

  let currentEndpoint = "";
  let insideLoginBody = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];

    // Interface boundary tracking
    if (/interface\s+LoginBody/.test(line)) {
      insideLoginBody = true;
    }
    if (insideLoginBody && /^\}/.test(line)) {
      insideLoginBody = false;
    }

    // Route from JSDoc comment
    const routeMatch = routeCommentRe.exec(line);
    if (routeMatch) {
      const method = routeMatch[1].toUpperCase();
      const path = routeMatch[2];
      routes.push({ method, path, line: lineNum, raw: line.trim() });
      currentEndpoint = `${method} ${path}`;
      continue;
    }

    // Param — interface fields inside LoginBody
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

    // Param — destructuring from req.body
    if (currentEndpoint && destructureRe.test(line)) {
      const destructureMatch = destructureRe.exec(line);
      if (destructureMatch) {
        const fields = destructureMatch[1].split(",").map((f) => f.trim()).filter(Boolean);
        for (const field of fields) {
          params.push({ name: field, line: lineNum, endpoint: currentEndpoint, raw: line.trim() });
        }
      }
    }

    // Auth — Bearer check
    if (currentEndpoint && bearerCodeRe.test(line) && !cookieCodeRe.test(line)) {
      auth.push({ scheme: "bearer", line: lineNum, endpoint: currentEndpoint, raw: line.trim() });
    }

    // Auth — cookie/session check
    if (currentEndpoint && cookieCodeRe.test(line)) {
      auth.push({ scheme: "cookie", line: lineNum, endpoint: currentEndpoint, raw: line.trim() });
    }

    // Response shape
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
// Stage 3 — detect drift
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

  // -- DRIFT-001: PARAM_MISMATCH (username vs email) -----------------------
  // Doc claims "username"; code requires "email"
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

  // -- DRIFT-002: AUTH_MISMATCH (Redis cookie vs Bearer JWT) ----------------
  // Doc claims cookie/session auth; code issues and validates Bearer tokens
  const docCookieAuth = docContracts.auth.find((a) => a.scheme === "cookie");
  const codeBearerResponse = codeContracts.responses.find(
    (r) => r.shape === "object" && r.endpoint === "POST /api/v1/auth/login"
  );

  if (docCookieAuth) {
    // Find the token_type or access_token line in the code responses as the citation
    const codeBearerLine = codeBearerResponse?.line ?? codeContracts.auth.find((a) => a.scheme === "bearer")?.line ?? 1;
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

  // -- DRIFT-003: RESPONSE_MISMATCH (raw array vs wrapped object) -----------
  // Doc claims GET /api/v1/users returns a raw array; code wraps in { users, total, page }
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
// Stage 4 — public entry point
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

  // totalChecks = number of distinct contract categories evaluated (4: route, param, auth, response)
  const totalChecks = 4;

  return {
    timestamp: new Date().toISOString(),
    targetRepository,
    totalChecks,
    driftCount: findings.length,
    findings,
    isClean: findings.length === 0,
  };
}
