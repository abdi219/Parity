/**
 * Documentation Contract Extractor — Section 6
 *
 * Extraction flow (per spec):
 *   Markdown File
 *   → Local Markdown Parsing
 *   → Identify API-Relevant Sections
 *   → Deterministic Extraction Where Possible
 *   → Groq Only for Ambiguous / Prose-Heavy Sections
 *   → ContractBundle JSON
 *   → Schema Validation
 *   → Attach File + Line Provenance
 *
 * Groq receives ONLY the relevant section text, never an entire repository.
 * If Groq is unavailable, fails, times out, or returns invalid JSON, the
 * deterministic regex extractor runs as a complete fallback.
 */

import Groq from "groq-sdk";
import type { ContractBundle, ContractEndpoint, HttpMethod } from "@/types/contract";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Groq call timeout in milliseconds. */
const GROQ_TIMEOUT_MS = 15_000;
/** Max characters sent to Groq in a single doc-extraction call. */
const GROQ_MAX_CHARS = 6_000;

/**
 * Preferred model order. The first ID found in the account's available models
 * is used. Keeping this list here makes it easy to update without touching
 * call-site logic.
 */
const MODEL_PREFERENCE = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3.8-27b",
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "llama3-70b-8192",
  "llama3-8b-8192",
  "mixtral-8x7b-32768",
];

// ---------------------------------------------------------------------------
// Groq client + dynamic model selection — resolved once per process
// ---------------------------------------------------------------------------

let _groqClient: Groq | null = null;
/** Resolved model id — null until resolveGroqModel() has run successfully. */
let _resolvedModel: string | null = null;
/** In-flight resolution promise — prevents duplicate model-list fetches. */
let _modelResolutionPromise: Promise<string | null> | null = null;

function getGroqClient(): Groq | null {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  if (!_groqClient) {
    _groqClient = new Groq({ apiKey: key });
  }
  return _groqClient;
}

/**
 * Fetch the account's available models once, pick the best one from
 * MODEL_PREFERENCE, cache the result, and return the model id.
 * Returns null if the key is missing or the API call fails.
 */
async function resolveGroqModel(): Promise<string | null> {
  // Already resolved — return cached value immediately
  if (_resolvedModel) return _resolvedModel;

  const client = getGroqClient();
  if (!client) return null;

  // Coalesce concurrent callers onto one in-flight fetch
  if (_modelResolutionPromise) return _modelResolutionPromise;

  _modelResolutionPromise = (async () => {
    try {
      const modelsList = await client.models.list();
      const availableIds: string[] = modelsList.data.map(
        (m: { id: string }) => m.id
      );
      console.log("[docExtractor] Available Groq models for this key:", availableIds);

      // Pick first preference that is actually available
      const chosen =
        MODEL_PREFERENCE.find((id) => availableIds.includes(id)) ??
        // Last-resort: any chat/completion model — exclude transcription and safety classifiers
        availableIds.find((id) => !/whisper|guard/i.test(id)) ??
        null;

      if (chosen) {
        console.log(`[docExtractor] Selected Groq model: ${chosen}`);
        _resolvedModel = chosen;
      } else {
        console.log("[docExtractor] No suitable Groq model found in available list");
      }
      return _resolvedModel;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[docExtractor] Failed to fetch Groq model list: ${msg}`);
      return null;
    } finally {
      // Clear the in-flight promise so a later call can retry on transient errors
      _modelResolutionPromise = null;
    }
  })();

  return _modelResolutionPromise;
}

// ---------------------------------------------------------------------------
// HTTP method guard
// ---------------------------------------------------------------------------

const HTTP_METHODS = new Set<string>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function isHttpMethod(value: string): value is HttpMethod {
  return HTTP_METHODS.has(value.toUpperCase());
}

// ---------------------------------------------------------------------------
// Section 6 — Local markdown parsing helpers
// ---------------------------------------------------------------------------

/**
 * Split a markdown document into logical sections (each H1/H2/H3 heading + body).
 * Returns an array of { heading, body, startLine } objects so we can preserve
 * line provenance after extraction.
 */
interface MarkdownSection {
  heading: string;
  body: string;
  /** 1-based line number of the heading */
  startLine: number;
}

function splitIntoSections(markdown: string): MarkdownSection[] {
  const lines = markdown.split("\n");
  const sections: MarkdownSection[] = [];
  let currentHeading = "(preamble)";
  let currentStart = 1;
  let currentLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = /^#{1,3}\s+(.+)$/.exec(line);
    if (headingMatch) {
      if (currentLines.length > 0) {
        sections.push({
          heading: currentHeading,
          body: currentLines.join("\n"),
          startLine: currentStart,
        });
      }
      currentHeading = headingMatch[1].trim();
      currentStart = i + 1;
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    sections.push({ heading: currentHeading, body: currentLines.join("\n"), startLine: currentStart });
  }

  return sections;
}

/**
 * Return true if a section appears to contain API contract information.
 *
 * Relaxed criteria (Fix 2):
 * - Original keyword list (endpoint, route, api, auth, etc.)
 * - HTTP verb followed by ANY whitespace then a path-like token (handles prose)
 * - Phrases like "post request", "get request", "delete request"
 * - Any path starting with /  or  /api/  anywhere in the text
 * - Code fences
 */
function isApiSection(section: MarkdownSection): boolean {
  const text = (section.heading + " " + section.body).toLowerCase();

  // Keyword list — heading or body contains API-related words
  if (/\b(endpoint|route|api|request|response|auth|authentication|param|method|handler|controller)\b/.test(text)) {
    return true;
  }
  // HTTP verb immediately before a slash (structured docs)
  if (/\b(get|post|put|patch|delete)\s+\//.test(text)) {
    return true;
  }
  // Prose patterns: "post request", "sends a get request", "delete request to /..."
  if (/\b(get|post|put|patch|delete)\s+(request|req)\b/.test(text)) {
    return true;
  }
  // "request to /path" or "sends to /path"
  if (/\b(request|sends?)\s+to\s+\//.test(text)) {
    return true;
  }
  // Any path token starting with / followed by at least one word char
  if (/(?:^|\s)\/[a-zA-Z_][a-zA-Z0-9_/:-]*/.test(section.body)) {
    return true;
  }
  // Code fences or explicit markers
  if (/route:|http method:|```/.test(text)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Deterministic regex extractor (primary for structured docs)
// ---------------------------------------------------------------------------

/**
 * Patterns for route lines in documentation.
 * Matches structured forms: "Route: POST /path", "GET /path", "**POST** `/path`",
 * table rows, and now also prose forms like "sends a POST request to /path".
 */
const ROUTE_PATTERNS = [
  // Explicit "Route:" label
  /\bRoute:\s*(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)/i,
  // Plain "METHOD /path"
  /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s`'"]+)/i,
  // Bold/italic method: **POST** `/path` or *POST* /path
  /\*{1,2}(GET|POST|PUT|PATCH|DELETE)\*{0,2}\s+`?(\/[^\s`'"]+)`?/i,
  // Backtick-wrapped: `POST /path`
  /`(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s`'"]+)`/i,
  // Markdown table row: | GET | /api/path |
  /\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*(\/\S+)\s*\|/i,
  // Prose: "sends a POST request to /api/path" / "makes a get request to /path"
  /\b(GET|POST|PUT|PATCH|DELETE)\s+request\s+to\s+(\/[^\s`'".,)]+)/i,
  // Prose: "request to /path using POST"
  /request\s+to\s+(\/[^\s`'".,)]+)\s+using\s+(GET|POST|PUT|PATCH|DELETE)/i,
  // Prose: "calls /path (POST)"
  /\b(\/[^\s`'".,)]+)\s+\((GET|POST|PUT|PATCH|DELETE)\)/i,
];

/** Params from JSON examples: `"fieldName":` */
const DOC_PARAM_RE = /"([a-zA-Z_][a-zA-Z0-9_]*)"\s*:/g;

/** Cookie / session auth indicators in documentation */
const COOKIE_AUTH_RE = /session|cookie|Set-Cookie/i;
/** Bearer / JWT auth indicators */
const BEARER_AUTH_RE = /Bearer|JWT|Authorization:\s*Bearer/i;
/** ApiKey auth indicators */
const APIKEY_AUTH_RE = /api[\s_-]?key|x-api-key/i;
/** Auth-declaration line anchors */
const AUTH_LINE_RE = /Authentication Method:|Authorization:|Auth:|Headers?:|auth(?:entication)?:/i;
/** Prose auth: "requires Bearer token", "uses JWT" */
const PROSE_BEARER_RE = /requires?\s+(a\s+)?Bearer\s+token|uses?\s+(JWT|Bearer)|Bearer\s+auth/i;
const PROSE_COOKIE_RE = /uses?\s+(?:session|cookie)|cookie[- ]based\s+auth/i;

/** Raw-array response indicator */
const RAW_ARRAY_RE = /Returns\s+a\s+raw\s+array|returns?\s+an?\s+array|^\s*\[/im;
/** Wrapped-object response indicator */
const WRAPPED_OBJECT_RE = /\{[^}]+\}/;

function extractWithRegex(
  markdown: string,
  sourceFile: string,
  sectionLineOffset = 0
): ContractEndpoint[] {
  const lines = markdown.split("\n");
  const endpoints: ContractEndpoint[] = [];
  let currentEndpoint: ContractEndpoint | null = null;

  for (let i = 0; i < lines.length; i++) {
    const absLine = sectionLineOffset + i + 1;
    const line = lines[i];

    // -- Route detection ---------------------------------------------------
    let routeMatch: RegExpExecArray | null = null;
    let matchedPattern = -1;
    for (let pi = 0; pi < ROUTE_PATTERNS.length; pi++) {
      routeMatch = ROUTE_PATTERNS[pi].exec(line);
      if (routeMatch) { matchedPattern = pi; break; }
    }

    if (routeMatch) {
      // Patterns 7 and 8 have swapped group order (path before method)
      let rawMethod: string;
      let path: string;
      if (matchedPattern === 6) {
        // "request to /path using METHOD" → groups: (path, method)
        rawMethod = routeMatch[2].toUpperCase();
        path = routeMatch[1];
      } else if (matchedPattern === 7) {
        // "/path (METHOD)" → groups: (path, method)
        rawMethod = routeMatch[2].toUpperCase();
        path = routeMatch[1];
      } else {
        rawMethod = routeMatch[1].toUpperCase();
        path = routeMatch[2];
      }

      if (isHttpMethod(rawMethod) && path) {
        if (currentEndpoint) endpoints.push(currentEndpoint);
        currentEndpoint = {
          path,
          method: rawMethod,
          params: [],
          sourceFile,
          lineNumber: absLine,
          sourceType: "documentation",
          extractionMethod: "REGEX",
        };
      }
      continue;
    }

    if (!currentEndpoint) continue;

    // -- Parameter detection -----------------------------------------------
    // JSON body examples: "fieldName": value
    if (/"[a-zA-Z_]/.test(line)) {
      DOC_PARAM_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = DOC_PARAM_RE.exec(line)) !== null) {
        const name = m[1];
        if (!/^\d/.test(name) && !currentEndpoint.params.includes(name)) {
          currentEndpoint.params.push(name);
        }
      }
    }

    // -- Auth detection ----------------------------------------------------
    const isAuthLine = AUTH_LINE_RE.test(line) || /^\s*-\s*(Cookie|Authorization|Set-Cookie)\s*:/i.test(line);
    if (isAuthLine && !currentEndpoint.auth) {
      if (APIKEY_AUTH_RE.test(line)) {
        currentEndpoint.auth = "ApiKey";
      } else if (BEARER_AUTH_RE.test(line)) {
        currentEndpoint.auth = "Bearer";
      } else if (COOKIE_AUTH_RE.test(line)) {
        currentEndpoint.auth = "Cookie";
      }
    }
    // Prose auth even without a header-style anchor
    if (!currentEndpoint.auth) {
      if (PROSE_BEARER_RE.test(line)) {
        currentEndpoint.auth = "Bearer";
      } else if (PROSE_COOKIE_RE.test(line)) {
        currentEndpoint.auth = "Cookie";
      }
    }

    // -- Response shape detection -----------------------------------------
    if (!currentEndpoint.responseShape && /Response\s*\(/.test(line)) {
      const lookahead = lines.slice(i + 1, i + 11).join("\n");
      if (RAW_ARRAY_RE.test(lookahead)) {
        currentEndpoint.responseShape = "array";
      } else if (WRAPPED_OBJECT_RE.test(lookahead)) {
        currentEndpoint.responseShape = "object";
      }
    }
    // Prose response shape on same line
    if (!currentEndpoint.responseShape) {
      if (RAW_ARRAY_RE.test(line)) {
        currentEndpoint.responseShape = "array";
      } else if (/returns?\s+(?:a\s+)?(?:JSON\s+)?object|wrapped\s+object/.test(line)) {
        currentEndpoint.responseShape = "object";
      }
    }
  }

  if (currentEndpoint) endpoints.push(currentEndpoint);
  return endpoints;
}

// ---------------------------------------------------------------------------
// Groq-based extractor
// ---------------------------------------------------------------------------

const GROQ_SYSTEM_PROMPT = `You are an API contract extraction engine.
Your ONLY job is to extract structured API endpoint contracts from documentation text.
The documentation may be written as structured lists, tables, code fences, OR as
conversational prose (e.g. "sends a POST request to /api/v1/register", "requires a
Bearer token", "returns a raw array of user records").

Rules:
- Return ONLY a JSON object matching the ContractBundle schema below — no prose, no markdown, no explanation.
- Parse ALL formats: bullet lists, tables, code blocks, AND natural-language prose descriptions.
- When you see phrases like "sends a POST request to /path", extract method=POST, path=/path.
- When you see "requires Bearer token" or "uses JWT auth", extract auth="Bearer".
- When you see "requires a cookie" or "session-based", extract auth="Cookie".
- When you see "returns a raw array" or "returns an array of", extract responseShape="array".
- When you see "returns an object" or "returns { ... }", extract responseShape="object".
- When you see "accepts/requires field X" or a JSON body example with "X": ..., extract that field name as a param.
- Do NOT invent endpoints, methods, parameters, or fields that are not present in the text.
- Do NOT add schema fields not listed below.
- If a field is not mentioned, omit it or use null.
- params must be an array of parameter/field name strings (e.g. ["email", "password"]).
- auth must be one of: "Bearer", "Cookie", "ApiKey", "None", or null.
- responseShape must be "array", "object", or null.
- method must be one of: GET, POST, PUT, PATCH, DELETE.

Schema:
{
  "endpoints": [
    {
      "path": "/api/v1/...",
      "method": "POST",
      "params": ["field1", "field2"],
      "auth": "Bearer" | "Cookie" | "ApiKey" | "None" | null,
      "responseShape": "array" | "object" | null
    }
  ]
}`;

/**
 * Validate a raw parsed value against the ContractBundle shape.
 * Returns a typed ContractBundle or null if validation fails.
 */
function validateContractBundle(raw: unknown): ContractBundle | null {
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
      ep.responseShape === "array" || ep.responseShape === "object"
        ? ep.responseShape
        : undefined;

    endpoints.push({
      path: ep.path,
      method,
      params,
      ...(auth !== undefined ? { auth } : {}),
      ...(responseShape !== undefined ? { responseShape } : {}),
      // Provenance will be attached by the caller
      sourceFile: "",
      sourceType: "documentation",
      extractionMethod: "GROQ",
    });
  }

  return { endpoints };
}

/**
 * Run Groq extraction on a bounded text slice.
 * Logs result or error to the server console.
 * Returns a ContractBundle (with placeholders for provenance) or null on any failure.
 */
async function extractWithGroq(text: string, sectionTitle: string): Promise<ContractBundle | null> {
  const client = getGroqClient();
  if (!client) return null;

  // Resolve model dynamically (cached after first successful call)
  const model = await resolveGroqModel();
  if (!model) {
    console.log(`[docExtractor] Skipping Groq for section "${sectionTitle}" — no model available`);
    return null;
  }

  // Hard cap — never send more than GROQ_MAX_CHARS to the model
  const bounded = text.length > GROQ_MAX_CHARS ? text.slice(0, GROQ_MAX_CHARS) : text;

  console.log(`[docExtractor] Calling Groq for section: "${sectionTitle}" (${bounded.length} chars, model: ${model})`);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);

    let responseText: string;
    try {
      const completion = await client.chat.completions.create(
        {
          model,
          messages: [
            { role: "system", content: GROQ_SYSTEM_PROMPT },
            {
              role: "user",
              content: `Extract all API endpoint contracts from the following documentation text:\n\n${bounded}`,
            },
          ],
          temperature: 0,
          max_tokens: 1024,
          response_format: { type: "json_object" },
        },
        { signal: controller.signal }
      );
      responseText = completion.choices[0]?.message?.content ?? "";
    } finally {
      clearTimeout(timer);
    }

    if (!responseText) {
      console.log(`[docExtractor] Groq returned empty response for section: "${sectionTitle}"`);
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText);
    } catch (parseErr) {
      console.log(`[docExtractor] Groq JSON parse error for section "${sectionTitle}":`, parseErr);
      return null;
    }

    const bundle = validateContractBundle(parsed);
    console.log(
      `[docExtractor] Groq result for section "${sectionTitle}": ${bundle ? bundle.endpoints.length + " endpoint(s)" : "invalid / 0 endpoints"}`
    );
    return bundle;
  } catch (err) {
    // AbortError = timeout; any other = network/SDK failure
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[docExtractor] Groq error for section "${sectionTitle}": ${msg}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Line number lookup helper
// ---------------------------------------------------------------------------

/**
 * Given a list of extracted endpoints (which have only relative positions from
 * Groq extraction), attempt to locate each endpoint's path in the original
 * full markdown and assign line provenance.
 */
function attachLineProvenance(
  endpoints: ContractEndpoint[],
  fullMarkdown: string,
  sourceFile: string
): ContractEndpoint[] {
  const lines = fullMarkdown.split("\n");
  return endpoints.map((ep) => {
    if (ep.lineNumber) return { ...ep, sourceFile };

    // Search for the path in the source text to derive a line number
    const pathEscaped = ep.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const searchRe = new RegExp(pathEscaped);
    let lineNumber: number | undefined;
    for (let i = 0; i < lines.length; i++) {
      if (searchRe.test(lines[i])) {
        lineNumber = i + 1;
        break;
      }
    }
    return { ...ep, sourceFile, ...(lineNumber !== undefined ? { lineNumber } : {}) };
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract a ContractBundle from a markdown documentation file.
 *
 * Strategy:
 * 1. Log key/section diagnostics to the server console.
 * 2. Split into logical sections; identify API-relevant ones.
 * 3. Run deterministic regex over the full document.
 * 4. For sections not covered by regex, attempt targeted Groq extraction.
 * 5. Global fallback: if regex produced 0 endpoints across the ENTIRE document,
 *    send the whole document (bounded) to Groq — prose-only docs never return 0.
 * 6. Merge results, de-duplicate by path+method, attach provenance.
 * 7. On any Groq failure: use only regex results.
 */
export async function extractDocContracts(
  markdown: string,
  sourceFile: string
): Promise<ContractBundle & { usedGroq: boolean; groqFailed: boolean }> {
  // --- Diagnostic log #1: key presence ---
  const hasKey = !!process.env.GROQ_API_KEY;
  console.log(`[docExtractor] GROQ_API_KEY present: ${hasKey}`);

  // Stage 1: deterministic extraction over the full document
  const regexEndpoints = extractWithRegex(markdown, sourceFile, 0);
  console.log(`[docExtractor] Regex extraction found: ${regexEndpoints.length} endpoint(s)`);

  const sections = splitIntoSections(markdown);
  const apiSections = sections.filter(isApiSection);

  // --- Diagnostic log #2: sections ---
  console.log(`[docExtractor] Sections found: ${sections.length} total, ${apiSections.length} passed isApiSection`);
  if (apiSections.length > 0) {
    console.log(`[docExtractor] API sections: ${apiSections.map((s) => `"${s.heading}"`).join(", ")}`);
  }

  let usedGroq = false;
  let groqFailed = false;
  const groqEndpoints: ContractEndpoint[] = [];

  const client = getGroqClient();

  if (client) {
    // "Thin" regex endpoints: route matched by regex but no params, auth, or
    // responseShape were extracted (typical for prose-pattern matches).
    // Track these by key so Groq can upgrade them with richer contract details.
    const thinRegexKeys = new Set(
      regexEndpoints
        .filter((e) => e.params.length === 0 && !e.auth && !e.responseShape)
        .map((e) => `${e.method} ${e.path}`)
    );

    // All regex-matched keys (used to avoid adding duplicate new routes from Groq)
    const regexPaths = new Set(regexEndpoints.map((e) => `${e.method} ${e.path}`));

    // --- Stage 2: targeted Groq for uncovered API sections ---
    for (const section of apiSections) {
      const sectionEnd = section.startLine + section.body.split("\n").length;
      // A section is "covered" only if regex found a *rich* endpoint there.
      // Thin regex matches don't count — Groq should still run to enrich them.
      const coveredRichly = regexEndpoints.some(
        (e) =>
          !thinRegexKeys.has(`${e.method} ${e.path}`) &&
          e.lineNumber !== undefined &&
          e.lineNumber >= section.startLine &&
          e.lineNumber < sectionEnd
      );
      if (coveredRichly) continue;

      usedGroq = true;
      const result = await extractWithGroq(section.body, section.heading);
      if (!result) {
        groqFailed = true;
        continue;
      }

      for (const ep of result.endpoints) {
        const key = `${ep.method} ${ep.path}`;
        // Accept this Groq endpoint if:
        //   (a) the route wasn't found by regex at all, OR
        //   (b) the regex match was thin and Groq has richer data
        const groqIsRicher =
          ep.params.length > 0 || ep.auth !== undefined || ep.responseShape !== undefined;
        if (!regexPaths.has(key) || (thinRegexKeys.has(key) && groqIsRicher)) {
          groqEndpoints.push({
            ...ep,
            sourceFile,
            sourceType: "documentation",
            extractionMethod: "GROQ",
          });
          // Mark as covered so we don't add the same route twice from multiple sections
          regexPaths.add(key);
          thinRegexKeys.delete(key); // no longer thin — Groq upgraded it
        }
      }
    }

    // --- Stage 3: global fallback — prose-only doc with 0 regex endpoints ---
    // If regex found nothing AND Groq hasn't produced anything yet, send the
    // full document (bounded) so that prose-only READMEs are never silently
    // returned as 0 contracts.
    const groqFoundSomething = groqEndpoints.length > 0;
    if (regexEndpoints.length === 0 && !groqFoundSomething) {
      console.log(`[docExtractor] Zero regex endpoints and no Groq results yet — running full-document Groq fallback`);
      usedGroq = true;
      const fullResult = await extractWithGroq(markdown, "(full document)");
      if (!fullResult) {
        groqFailed = true;
      } else {
        for (const ep of fullResult.endpoints) {
          const key = `${ep.method} ${ep.path}`;
          if (!regexPaths.has(key)) {
            groqEndpoints.push({
              ...ep,
              sourceFile,
              sourceType: "documentation",
              extractionMethod: "GROQ",
            });
            regexPaths.add(key);
          }
        }
      }
    }
  } else {
    console.log(`[docExtractor] Groq client not available — skipping LLM extraction`);
  }

  // Merge: start with regex endpoints, but replace thin ones that Groq upgraded.
  // Build a map of Groq results keyed by method+path for O(1) lookup.
  const groqByKey = new Map(
    groqEndpoints.map((e) => [`${e.method} ${e.path}`, e])
  );

  // For each regex endpoint: if Groq produced a richer version, use that instead.
  const mergedRegex = regexEndpoints.map((e) => {
    const key = `${e.method} ${e.path}`;
    const groqVersion = groqByKey.get(key);
    if (groqVersion) {
      const groqIsRicher =
        groqVersion.params.length > 0 ||
        groqVersion.auth !== undefined ||
        groqVersion.responseShape !== undefined;
      if (groqIsRicher) {
        // Keep regex line-number provenance; take richer contract fields from Groq
        return {
          ...groqVersion,
          sourceFile,
          lineNumber: e.lineNumber ?? groqVersion.lineNumber,
        };
      }
    }
    return e;
  });

  // Groq-only additions (routes not found by regex at all)
  const groqOnlyEndpoints = attachLineProvenance(
    groqEndpoints.filter((e) => {
      const key = `${e.method} ${e.path}`;
      return !regexEndpoints.some((r) => `${r.method} ${r.path}` === key);
    }),
    markdown,
    sourceFile
  );

  const merged = [...mergedRegex, ...groqOnlyEndpoints];

  // De-duplicate by method+path, keeping first occurrence
  const seen = new Set<string>();
  const deduped = merged.filter((ep) => {
    const key = `${ep.method} ${ep.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[docExtractor] Final endpoint count: ${deduped.length} (regex: ${regexEndpoints.length}, groq additions: ${groqEndpoints.length})`);

  return { endpoints: deduped, usedGroq, groqFailed };
}
