import type { DriftFinding } from "@/lib/driftEngine";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UnifiedDiffLine {
  kind: "context" | "removed" | "added";
  lineNumber: number | null; // null for added lines (no original line number)
  content: string;
}

export interface PatchResult {
  patchedDoc: string;
  diff: UnifiedDiffLine[];
}

// ---------------------------------------------------------------------------
// Per-finding replacement rules
// ---------------------------------------------------------------------------
// Each rule describes an exact substring to find in the doc and what to
// replace it with. The replacements are crafted to satisfy the drift engine's
// parser conditions so that re-auditing the patched doc yields zero findings.
//
// DRIFT-001 (PARAM_MISMATCH): remove "username" field, add "email" field.
//   Parser keys on /"username"\s*:/ to produce docUsernameParam.
//   Replacing the line removes the match and stops the finding.
//
// DRIFT-002 (AUTH_MISMATCH): two cookie references must both be neutralised.
//   Line 17: authentication method claim — replace with Bearer description.
//   Line 26: Cookie header in GET /users — replace with Authorization header.
//   Parser keys on /session|cookie|Set-Cookie/i for scheme:"cookie" entries.
//   After both replacements no cookie-scheme auth remains, so drift check
//   finds no docCookieAuth and produces no DRIFT-002 finding.
//
// DRIFT-003 (RESPONSE_MISMATCH): replace "Returns a raw array" section.
//   Parser keys on /Returns a raw array|^\s*\[/im in lookahead window.
//   Replacement uses a wrapped object block matching /\{[^}]*\}/ instead.
// ---------------------------------------------------------------------------

interface ReplacementRule {
  findingType: DriftFinding["type"];
  search: string;
  replace: string;
}

const REPLACEMENT_RULES: ReplacementRule[] = [
  // DRIFT-001: username → email in request body example
  {
    findingType: "PARAM_MISMATCH",
    search: `    "username": "johndoe",`,
    replace: `    "email": "johndoe@example.com",`,
  },
  // DRIFT-002 (part 1): auth method line — cookie/session → Bearer JWT
  {
    findingType: "AUTH_MISMATCH",
    search: `- Authentication Method: Stateful cookie-based authentication via Redis session store (Set-Cookie: session_id=...).`,
    replace: `- Authentication Method: Stateless Bearer JWT. The response body contains token_type: "Bearer" and access_token.`,
  },
  // DRIFT-002 (part 2): GET /users Cookie header → Authorization: Bearer
  {
    findingType: "AUTH_MISMATCH",
    search: `  - Cookie: session_id=<session_token>`,
    replace: `  - Authorization: Bearer <access_token>`,
  },
  // DRIFT-003: raw array response → wrapped object description
  {
    findingType: "RESPONSE_MISMATCH",
    search: `  Returns a raw array of user records:\n  [\n    { "id": "usr_101", "name": "Alice" },\n    { "id": "usr_102", "name": "Bob" }\n  ]`,
    replace: `  Returns a wrapped object:\n  {\n    "users": [{ "id": "usr_101", "name": "Alice" }, { "id": "usr_102", "name": "Bob" }],\n    "total": 2,\n    "page": 1\n  }`,
  },
];

// ---------------------------------------------------------------------------
// Diff generation
// ---------------------------------------------------------------------------
// Produces a minimal line-level unified diff between two strings. Only lines
// that changed are shown, with one line of context on each side.

function buildDiff(original: string, patched: string): UnifiedDiffLine[] {
  const originalLines = original.split("\n");
  const patchedLines = patched.split("\n");
  const diff: UnifiedDiffLine[] = [];

  // Compute changed line indices by walking both arrays together.
  // This is a simple linear scan — sufficient for the deterministic demo doc
  // where changes are non-overlapping and ordered by line number.
  const maxLen = Math.max(originalLines.length, patchedLines.length);
  let origIdx = 0;
  let patchIdx = 0;

  while (origIdx < originalLines.length || patchIdx < patchedLines.length) {
    const origLine = originalLines[origIdx] ?? "";
    const patchLine = patchedLines[patchIdx] ?? "";

    if (origLine === patchLine) {
      // Lines match — emit as context only if adjacent to a change.
      // We accumulate all lines and trim context in a second pass.
      diff.push({ kind: "context", lineNumber: origIdx + 1, content: origLine });
      origIdx++;
      patchIdx++;
    } else {
      // Lines differ — emit removed then added.
      diff.push({ kind: "removed", lineNumber: origIdx + 1, content: origLine });
      diff.push({ kind: "added", lineNumber: null, content: patchLine });
      origIdx++;
      patchIdx++;
    }

    if (origIdx >= maxLen && patchIdx >= maxLen) break;
  }

  // Trim to only context lines within 1 position of a non-context line.
  return trimContext(diff);
}

function trimContext(lines: UnifiedDiffLine[]): UnifiedDiffLine[] {
  const hasChange = lines.map((l) => l.kind !== "context");
  const keep: boolean[] = new Array(lines.length).fill(false);

  for (let i = 0; i < lines.length; i++) {
    if (hasChange[i]) {
      // Keep this line and one context line on each side.
      for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 1); j++) {
        keep[j] = true;
      }
    }
  }

  return lines.filter((_, i) => keep[i]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply all patches derived from the given findings to the original markdown
 * document. Returns the patched document string and a unified diff.
 *
 * Only findings whose type has a registered replacement rule are patched.
 * Each replacement is a verbatim string substitution — no regex, no line
 * number arithmetic — guaranteeing deterministic, idempotent output.
 */
export function applyPatches(originalDoc: string, findings: DriftFinding[]): PatchResult {
  // Normalise line endings to LF for consistent string matching.
  // The original ending style is restored in the patched output.
  const hasCRLF = originalDoc.includes("\r\n");
  const normalisedDoc = hasCRLF ? originalDoc.replace(/\r\n/g, "\n") : originalDoc;

  const activeTypes = new Set(findings.map((f) => f.type));

  let doc = normalisedDoc;

  for (const rule of REPLACEMENT_RULES) {
    if (!activeTypes.has(rule.findingType)) continue;
    // Only apply if the search string is actually present (idempotency guard).
    if (doc.includes(rule.search)) {
      doc = doc.split(rule.search).join(rule.replace);
    }
  }

  // Restore original line endings if the source used CRLF.
  const patchedDoc = hasCRLF ? doc.replace(/\n/g, "\r\n") : doc;

  // Diff is computed on the normalised forms for clean line-level comparison.
  const diff = buildDiff(normalisedDoc, doc);

  return { patchedDoc, diff };
}
