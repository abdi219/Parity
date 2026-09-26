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

const GROQ_MODEL = "llama-3.3-70b-versatile";
/** Groq call timeout in milliseconds. */
const GROQ_TIMEOUT_MS = 15_000;
/** Max characters sent to Groq in a single doc-extraction call. */
const GROQ_MAX_CHARS = 6_000;

// ---------------------------------------------------------------------------
// Groq client — instantiated lazily, only if the key is present
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
 * Split a markdown document into logical sections (each H2/H3 heading + body).
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
 * We look for route keywords, HTTP method mentions, or typical API doc patterns.
 */
function isApiSection(section: MarkdownSection): boolean {
  const text = (section.heading + " " + section.body).toLowerCase();
  return (
    /\b(endpoint|route|api|request|response|auth|authentication|param|method)\b/.test(text) ||
    /\b(get|post|put|patch|delete)\s+\//.test(text) ||
    /route:|http method:|```/.test(text)
  );
}

// ---------------------------------------------------------------------------
// Deterministic regex extractor (fallback + primary for structured docs)
// ---------------------------------------------------------------------------

/**
 * Patterns for route lines in documentation.
 * Matches: "- Route: POST /api/v1/login", "GET /api/v1/users", "**POST** `/path`"
 */
const ROUTE_PATTERNS = [
  /\bRoute:\s*(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)/i,
  /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s`'"]+)/i,
  /\*{1,2}(GET|POST|PUT|PATCH|DELETE)\*{0,2}\s+`?(\/[^\s`'"]+)`?/i,
  /`(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s`'"]+)`/i,
  // Markdown table row: | GET | /api/path |
  /\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*(\/\S+)\s*\|/i,
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
const AUTH_LINE_RE = /Authentication Method:|Authorization:|Auth:|Headers?:/i;

/** Raw-array response indicator */
const RAW_ARRAY_RE = /Returns\s+a\s+raw\s+array|^\s*\[/im;
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
    for (const pattern of ROUTE_PATTERNS) {
      routeMatch = pattern.exec(line);
      if (routeMatch) break;
    }

    if (routeMatch) {
      const rawMethod = routeMatch[1].toUpperCase();
      const path = routeMatch[2];
      if (isHttpMethod(rawMethod)) {
        // Save current endpoint before starting a new one
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
    // Only scan lines that look like JSON object body examples
    if (/"[a-zA-Z_]/.test(line)) {
      DOC_PARAM_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = DOC_PARAM_RE.exec(line)) !== null) {
        const name = m[1];
        // Skip obviously non-field tokens
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

    // -- Response shape detection -----------------------------------------
    if (!currentEndpoint.responseShape && /Response\s*\(/.test(line)) {
      const lookahead = lines.slice(i + 1, i + 11).join("\n");
      if (RAW_ARRAY_RE.test(lookahead)) {
        currentEndpoint.responseShape = "array";
      } else if (WRAPPED_OBJECT_RE.test(lookahead)) {
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

Rules:
- Return ONLY a JSON object matching the ContractBundle schema below — no prose, no markdown, no explanation.
- Do NOT invent endpoints, methods, parameters, or fields that are not explicitly described in the text.
- Do NOT add fields not in the schema.
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
 * Returns a ContractBundle (with placeholders for provenance) or null on any failure.
 */
async function extractWithGroq(text: string): Promise<ContractBundle | null> {
  const client = getGroqClient();
  if (!client) return null;

  // Hard cap — never send more than GROQ_MAX_CHARS to the model
  const bounded = text.length > GROQ_MAX_CHARS ? text.slice(0, GROQ_MAX_CHARS) : text;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);

    let responseText: string;
    try {
      const completion = await client.chat.completions.create(
        {
          model: GROQ_MODEL,
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

    if (!responseText) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      return null;
    }

    return validateContractBundle(parsed);
  } catch {
    // Timeout, network error, or any other failure — fall through to regex
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
 * 1. Split into logical sections; identify API-relevant ones.
 * 2. Run deterministic regex over the full document.
 * 3. For sections that the regex could not resolve (no endpoints found and the
 *    section is prose-heavy), attempt a targeted Groq extraction.
 * 4. Merge results, de-duplicate by path+method, attach provenance.
 * 5. On any Groq failure: use only regex results.
 */
export async function extractDocContracts(
  markdown: string,
  sourceFile: string
): Promise<ContractBundle & { usedGroq: boolean; groqFailed: boolean }> {
  // Stage 1: deterministic extraction over the full document
  const regexEndpoints = extractWithRegex(markdown, sourceFile, 0);

  const sections = splitIntoSections(markdown);
  const apiSections = sections.filter(isApiSection);

  let usedGroq = false;
  let groqFailed = false;
  const groqEndpoints: ContractEndpoint[] = [];

  // Stage 2: for each API section not already covered by regex, try Groq
  const client = getGroqClient();
  if (client && apiSections.length > 0) {
    // Determine which sections have no regex-matched endpoints
    const regexPaths = new Set(regexEndpoints.map((e) => `${e.method} ${e.path}`));

    for (const section of apiSections) {
      // Check if regex already found endpoints from this section's line range
      const sectionEnd = section.startLine + section.body.split("\n").length;
      const coveredByRegex = regexEndpoints.some(
        (e) => e.lineNumber !== undefined && e.lineNumber >= section.startLine && e.lineNumber < sectionEnd
      );

      if (coveredByRegex) continue;

      // This section has API signals but regex found nothing — send to Groq
      usedGroq = true;
      const result = await extractWithGroq(section.body);
      if (!result) {
        groqFailed = true;
        continue;
      }

      for (const ep of result.endpoints) {
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

  // Merge: regex results first (they carry exact line numbers), then Groq additions
  const merged = [
    ...regexEndpoints,
    ...attachLineProvenance(groqEndpoints, markdown, sourceFile),
  ];

  // De-duplicate by method+path, keeping first occurrence (regex wins over Groq)
  const seen = new Set<string>();
  const deduped = merged.filter((ep) => {
    const key = `${ep.method} ${ep.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { endpoints: deduped, usedGroq, groqFailed };
}
