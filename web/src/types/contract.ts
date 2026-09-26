/**
 * Universal Normalized Contract Schema — Section 5
 *
 * Every extracted endpoint, regardless of source language or extraction method,
 * must conform to this schema. Provenance is mandatory.
 */

// ---------------------------------------------------------------------------
// HTTP method union
// ---------------------------------------------------------------------------

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// ---------------------------------------------------------------------------
// Auth scheme
// ---------------------------------------------------------------------------

/** Well-known auth schemes plus an escape hatch for unrecognised values. */
export type AuthScheme = "Bearer" | "Cookie" | "ApiKey" | "None" | string;

// ---------------------------------------------------------------------------
// Extraction method
// ---------------------------------------------------------------------------

/**
 * How the contract was produced:
 * - AST    — TypeScript/JavaScript static analysis
 * - REGEX  — deterministic text-pattern matching (any language)
 * - OPENAPI — parsed from an OpenAPI/Swagger specification
 * - GROQ   — LLM-assisted extraction (targeted fallback only)
 */
export type ExtractionMethod = "AST" | "REGEX" | "OPENAPI" | "GROQ";

// ---------------------------------------------------------------------------
// Core contract types
// ---------------------------------------------------------------------------

/**
 * A single API endpoint contract extracted from either documentation or source code.
 * All fields carry full provenance: which file, which line, which source type,
 * and which extraction method produced the value.
 */
export interface ContractEndpoint {
  /** Normalized route path, e.g. "/api/v1/users/:id" */
  path: string;

  /** HTTP method */
  method: HttpMethod;

  /** Body/query/path parameter names */
  params: string[];

  /**
   * Authentication scheme detected at this endpoint.
   * undefined = not specified in the source; "None" = explicitly no auth.
   */
  auth?: AuthScheme;

  /**
   * High-level shape of the primary response:
   * - "array"  — top-level JSON array
   * - "object" — wrapped JSON object
   * - other string for unusual shapes
   */
  responseShape?: "array" | "object" | string;

  // -------------------------------------------------------------------------
  // Provenance — required on every endpoint
  // -------------------------------------------------------------------------

  /** Relative path to the file that produced this endpoint contract. */
  sourceFile: string;

  /** 1-based line number where the route/endpoint was identified, when available. */
  lineNumber?: number;

  /** Whether this contract came from documentation or from source implementation. */
  sourceType?: "documentation" | "implementation";

  /** Which extraction strategy produced this contract. */
  extractionMethod?: ExtractionMethod;
}

/**
 * An aggregated collection of endpoint contracts produced from one or more
 * files during a single analysis pass.
 */
export interface ContractBundle {
  endpoints: ContractEndpoint[];
}
