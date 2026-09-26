import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { runDriftAudit, runNormalizedAudit, type AuditReport, type RepoMap } from "@/lib/driftEngine";
import { extractDocContracts } from "@/lib/docExtractor";
import { extractCodeContracts } from "@/lib/codeExtractor";

// ---------------------------------------------------------------------------
// Environment — read safely, never throw if missing
// ---------------------------------------------------------------------------

/** GitHub personal access token — optional, raises rate limit. Never exposed to client. */
function getGitHubToken(): string | undefined {
  return process.env.GITHUB_TOKEN || undefined;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum API-relevant source files analyzed per repository scan (Section 4 safety cap). */
const MAX_SOURCE_FILES = 10;
/** Maximum documentation files analyzed per repository scan. */
const MAX_DOC_FILES = 5;

// ---------------------------------------------------------------------------
// Request body shape
// ---------------------------------------------------------------------------

interface RequestBody {
  target: "demo" | "custom";
  repoUrl?: string;
  docPath?: string;
  codePath?: string;
  patchedDocContent?: string;
}

// ---------------------------------------------------------------------------
// GitHub Trees API types
// ---------------------------------------------------------------------------

interface GitHubTreeItem {
  path: string;
  type: "blob" | "tree";
  size?: number;
  sha: string;
  url: string;
}

interface GitHubTreeResponse {
  sha: string;
  url: string;
  tree: GitHubTreeItem[];
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorResponse(status: number, message: string): NextResponse<{ error: string }> {
  return NextResponse.json<{ error: string }>({ error: message }, { status });
}

function githubHeaders(accept = "application/vnd.github+json"): HeadersInit {
  const token = getGitHubToken();
  const headers: Record<string, string> = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  try {
    const u = new URL(url.trim());
    if (u.hostname !== "github.com") return null;
    const parts = u.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    return { owner: parts[0], repo: parts[1] };
  } catch {
    return null;
  }
}

function sanitizeGitHubUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    if (u.hostname !== "github.com") return url.trim();
    const parts = u.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
    if (parts.length < 2) return url.trim();
    return `https://github.com/${parts[0]}/${parts[1]}`;
  } catch {
    return url.trim();
  }
}

async function resolveDefaultBranch(owner: string, repo: string): Promise<string> {
  for (const branch of ["main", "master"]) {
    const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}`;
    const res = await fetch(url, { headers: githubHeaders(), cache: "no-store" });
    if (res.ok) return branch;
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      const reset = res.headers.get("x-ratelimit-reset");
      throw new Error(
        `GitHub API rate limit exceeded (remaining: ${remaining ?? "?"}, resets: ${reset ? new Date(Number(reset) * 1000).toISOString() : "?"}).`
      );
    }
  }
  throw new Error(`Could not resolve default branch for ${owner}/${repo} (tried: main, master).`);
}

async function fetchRepoTree(owner: string, repo: string, branch: string): Promise<GitHubTreeItem[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
  const res = await fetch(url, { headers: githubHeaders(), cache: "no-store" });

  if (!res.ok) {
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      throw new Error(
        `GitHub API rate limit exceeded fetching tree for ${owner}/${repo} (remaining: ${remaining ?? "?"}).`
      );
    }
    throw new Error(`Failed to fetch repository tree for ${owner}/${repo} (HTTP ${res.status}).`);
  }

  const data = (await res.json()) as GitHubTreeResponse;
  return data.tree;
}

const IGNORED_SEGMENTS = new Set([
  "node_modules", "dist", "build", ".git", "coverage",
  "tests", "__tests__", ".next", "out",
]);

function isIgnoredPath(filePath: string): boolean {
  const segments = filePath.split("/");
  return segments.some((s) => IGNORED_SEGMENTS.has(s));
}

const SOURCE_PRIORITY_PREFIXES = [
  "src/routes", "src/controllers", "src/api", "src/handlers",
  "src/middleware", "src/types", "src/models",
  "routes", "controllers", "api", "handlers",
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

function getExt(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot >= 0 ? filePath.slice(dot) : "";
}

function isSourceFile(filePath: string): boolean {
  return SOURCE_EXTENSIONS.has(getExt(filePath));
}

const ALL_SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".go", ".java",
]);

function isAnySourceFile(filePath: string): boolean {
  return ALL_SOURCE_EXTENSIONS.has(getExt(filePath));
}

function isDocFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.endsWith(".md") ||
    lower.endsWith(".mdx") ||
    lower.endsWith("openapi.yaml") ||
    lower.endsWith("openapi.yml") ||
    lower.endsWith("openapi.json")
  );
}

function sourcePriorityScore(filePath: string): number {
  for (let i = 0; i < SOURCE_PRIORITY_PREFIXES.length; i++) {
    if (filePath.startsWith(SOURCE_PRIORITY_PREFIXES[i] + "/") || filePath === SOURCE_PRIORITY_PREFIXES[i]) {
      return i;
    }
  }
  return SOURCE_PRIORITY_PREFIXES.length;
}

function selectSourceFiles(tree: GitHubTreeItem[]): { files: string[]; capped: boolean } {
  const candidates = tree
    .filter((item) => item.type === "blob" && isSourceFile(item.path) && !isIgnoredPath(item.path))
    .sort((a, b) => sourcePriorityScore(a.path) - sourcePriorityScore(b.path));

  const capped = candidates.length > MAX_SOURCE_FILES;
  return { files: candidates.slice(0, MAX_SOURCE_FILES).map((i) => i.path), capped };
}

function selectDocFiles(tree: GitHubTreeItem[]): string[] {
  const candidates = tree
    .filter((item) => item.type === "blob" && isDocFile(item.path) && !isIgnoredPath(item.path))
    .sort((a, b) => {
      // README.md at root = highest priority
      const aIsRoot = a.path.toLowerCase() === "readme.md" ? 0 : 1;
      const bIsRoot = b.path.toLowerCase() === "readme.md" ? 0 : 1;
      return aIsRoot - bIsRoot || a.path.localeCompare(b.path);
    });
  return candidates.slice(0, MAX_DOC_FILES).map((i) => i.path);
}

/** Derive ignored top-level directory names from the tree (for the repo map). */
function derivedIgnoredDirs(tree: GitHubTreeItem[]): string[] {
  const found = new Set<string>();
  for (const item of tree) {
    const first = item.path.split("/")[0];
    if (first && IGNORED_SEGMENTS.has(first)) found.add(first);
  }
  return [...found].sort();
}

/** Derive language list from the actual files in the tree. */
function derivedLanguages(files: string[]): string[] {
  const langs = new Set<string>();
  for (const f of files) {
    const ext = getExt(f).toLowerCase();
    if (ext === ".ts" || ext === ".tsx") langs.add("TypeScript");
    else if (ext === ".js" || ext === ".mjs" || ext === ".cjs") langs.add("JavaScript");
    else if (ext === ".py") langs.add("Python");
    else if (ext === ".go") langs.add("Go");
    else if (ext === ".java") langs.add("Java");
  }
  return [...langs].sort();
}

async function fetchRawFile(
  owner: string,
  repo: string,
  branch: string,
  filePath: string
): Promise<{ content: string; rawUrl: string }> {
  const ts = Date.now();
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}?t=${ts}`;
  const res = await fetch(rawUrl, {
    headers: { Accept: "text/plain", "Cache-Control": "no-cache", Pragma: "no-cache" },
    cache: "no-store",
  });

  if (!res.ok) {
    if (res.status === 404) throw new Error(`File not found: "${filePath}" in ${owner}/${repo} (branch: ${branch}).`);
    throw new Error(`Failed to fetch "${filePath}" from ${owner}/${repo} (HTTP ${res.status}).`);
  }

  return { content: await res.text(), rawUrl };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse<AuditReport | { error: string }>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "Request body must be valid JSON.");
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !("target" in body) ||
    typeof (body as Record<string, unknown>).target !== "string"
  ) {
    return errorResponse(400, "Missing required field: target.");
  }

  const {
    target,
    repoUrl,
    docPath: docPathParam = "README.md",
    codePath: codePathParam = "src/auth.ts",
    patchedDocContent,
  } = body as RequestBody;

  if (target !== "demo" && target !== "custom") {
    return errorResponse(400, 'Field "target" must be "demo" or "custom".');
  }

  // ---------------------------------------------------------------------------
  // Demo target — load from local disk, run legacy deterministic audit
  // ---------------------------------------------------------------------------
  if (target === "demo") {
    const repoRoot = path.join(process.cwd(), "..");
    const localDocPath = path.join(repoRoot, "dummy-auth-service", "README.md");
    const localCodePath = path.join(repoRoot, "dummy-auth-service", "src", "auth.ts");

    let docContent: string;
    let codeContent: string;

    try {
      [docContent, codeContent] = await Promise.all([
        fs.readFile(localDocPath, "utf-8"),
        fs.readFile(localCodePath, "utf-8"),
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(500, `Failed to read demo service files: ${message}`);
    }

    const effectiveDoc = typeof patchedDocContent === "string" ? patchedDocContent : docContent;

    const report = runDriftAudit(
      effectiveDoc,
      codeContent,
      "dummy-auth-service/README.md",
      "dummy-auth-service/src/auth.ts",
      "dummy-auth-service"
    );

    return NextResponse.json(report, { status: 200 });
  }

  // ---------------------------------------------------------------------------
  // Custom target — fetch from GitHub, run normalized extraction + audit
  // ---------------------------------------------------------------------------

  if (!repoUrl || typeof repoUrl !== "string" || repoUrl.trim() === "") {
    return errorResponse(400, 'Field "repoUrl" is required for target "custom".');
  }

  const cleanUrl = sanitizeGitHubUrl(repoUrl);
  const parsed = parseGitHubUrl(cleanUrl);
  if (!parsed) {
    return errorResponse(400, `Invalid GitHub URL: "${repoUrl}". Expected format: https://github.com/owner/repo`);
  }

  const { owner, repo } = parsed;
  const repoLabel = `${owner}/${repo}`;

  const safeDocPath = docPathParam.replace(/^\/+/, "");
  const safeCodePath = codePathParam.replace(/^\/+/, "");

  // -- Resolve branch ---------------------------------------------------------
  let branch: string;
  try {
    branch = await resolveDefaultBranch(owner, repo);
  } catch (err) {
    return errorResponse(502, err instanceof Error ? err.message : String(err));
  }

  // -- Discover repo tree (one request) ---------------------------------------
  let tree: GitHubTreeItem[];
  try {
    tree = await fetchRepoTree(owner, repo, branch);
  } catch (err) {
    return errorResponse(502, err instanceof Error ? err.message : String(err));
  }

  // Build repo map counts from the actual tree
  const { files: treeSourceFiles, capped } = selectSourceFiles(tree);
  const treeDocFiles = selectDocFiles(tree);
  const ignoredDirs = derivedIgnoredDirs(tree);
  const allAnySource = tree.filter((i) => i.type === "blob" && isAnySourceFile(i.path) && !isIgnoredPath(i.path));
  const languages = derivedLanguages(allAnySource.map((i) => i.path));

  // -- Fetch user-specified doc and code files (concurrent, cached per audit) -
  let docContent: string;
  let codeContent: string;
  let resolvedDocPath: string;
  let resolvedCodePath: string;

  // Per-audit fetch cache (prevents double-fetching the same file)
  const fetchCache = new Map<string, string>();

  async function cachedFetch(filePath: string): Promise<string> {
    if (fetchCache.has(filePath)) return fetchCache.get(filePath)!;
    const { content } = await fetchRawFile(owner, repo, branch, filePath);
    fetchCache.set(filePath, content);
    return content;
  }

  try {
    [docContent, codeContent] = await Promise.all([
      cachedFetch(safeDocPath),
      cachedFetch(safeCodePath),
    ]);
    resolvedDocPath = `${repoLabel}/${safeDocPath}`;
    resolvedCodePath = `${repoLabel}/${safeCodePath}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Fall back to top tree-discovered source file if explicit code path is 404
    if (message.includes("not found") && treeSourceFiles.length > 0 && !message.includes(safeDocPath)) {
      const fallback = treeSourceFiles[0];
      try {
        [docContent, codeContent] = await Promise.all([
          cachedFetch(safeDocPath),
          cachedFetch(fallback),
        ]);
        resolvedDocPath = `${repoLabel}/${safeDocPath}`;
        resolvedCodePath = `${repoLabel}/${fallback}`;
      } catch (fallbackErr) {
        const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        return errorResponse(fbMsg.includes("not found") ? 404 : 502, fbMsg);
      }
    } else {
      return errorResponse(message.includes("not found") ? 404 : 502, message);
    }
  }

  // -- Extract contracts (doc + code in parallel) -----------------------------
  const [docBundle, codeBundle] = await Promise.all([
    extractDocContracts(docContent, resolvedDocPath),
    extractCodeContracts(codeContent, resolvedCodePath),
  ]);

  // -- Build extraction method set for repo map -------------------------------
  const extractionMethods = new Set<string>();
  for (const ep of docBundle.endpoints) {
    if (ep.extractionMethod) extractionMethods.add(ep.extractionMethod);
  }
  for (const ep of codeBundle.endpoints) {
    if (ep.extractionMethod) extractionMethods.add(ep.extractionMethod);
  }

  const repoMap: RepoMap = {
    totalFilesDiscovered: tree.filter((i) => i.type === "blob").length,
    docFiles: treeDocFiles,
    sourceFiles: treeSourceFiles,
    ignoredDirs,
    languages,
    extractionMethods: [...extractionMethods].sort(),
    wasCapped: capped,
    ...(capped ? { cappedAt: MAX_SOURCE_FILES } : {}),
  };

  // -- Run normalized deterministic drift comparison --------------------------
  const report = runNormalizedAudit(
    docBundle.endpoints,
    codeBundle.endpoints,
    resolvedDocPath,
    resolvedCodePath,
    repoLabel,
    repoMap
  );

  return NextResponse.json(report, { status: 200 });
}
