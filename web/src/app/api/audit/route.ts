import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { runDriftAudit, AuditReport } from "@/lib/driftEngine";

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
// Helpers
// ---------------------------------------------------------------------------

function errorResponse(status: number, message: string): NextResponse<{ error: string }> {
  return NextResponse.json<{ error: string }>({ error: message }, { status });
}

/**
 * Parse a GitHub repo URL into owner and repo name.
 * Accepts:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo/tree/branch  (branch is ignored — we probe)
 */
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

/**
 * Fetch a raw file from GitHub, trying "main" then "master".
 * Returns { content, branch, rawUrl } or throws with a descriptive message.
 */
async function fetchGitHubFile(
  owner: string,
  repo: string,
  filePath: string
): Promise<{ content: string; branch: string; rawUrl: string }> {
  const branches = ["main", "master"];
  let lastStatus = 0;

  for (const branch of branches) {
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
    const res = await fetch(rawUrl, {
      headers: { Accept: "text/plain" },
      // Next.js 15+ server fetch — opt out of caching for live audits
      cache: "no-store",
    });

    if (res.ok) {
      const content = await res.text();
      return { content, branch, rawUrl };
    }
    lastStatus = res.status;
  }

  if (lastStatus === 404) {
    throw new Error(
      `File not found in ${owner}/${repo}: "${filePath}" (tried branches: main, master)`
    );
  }
  throw new Error(
    `Failed to fetch "${filePath}" from ${owner}/${repo} (HTTP ${lastStatus})`
  );
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
  // Demo target — load from local disk
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
  // Custom target — fetch from GitHub
  // ---------------------------------------------------------------------------

  if (!repoUrl || typeof repoUrl !== "string" || repoUrl.trim() === "") {
    return errorResponse(400, 'Field "repoUrl" is required for target "custom".');
  }

  const parsed = parseGitHubUrl(repoUrl);
  if (!parsed) {
    return errorResponse(
      400,
      `Invalid GitHub URL: "${repoUrl}". Expected format: https://github.com/owner/repo`
    );
  }

  const { owner, repo } = parsed;
  const repoLabel = `${owner}/${repo}`;

  let docContent: string;
  let codeContent: string;
  let resolvedDocPath: string;
  let resolvedCodePath: string;

  // Sanitise file paths — strip any leading slashes
  const safeDocPath = docPathParam.replace(/^\/+/, "");
  const safeCodePath = codePathParam.replace(/^\/+/, "");

  try {
    const [docResult, codeResult] = await Promise.all([
      fetchGitHubFile(owner, repo, safeDocPath),
      fetchGitHubFile(owner, repo, safeCodePath),
    ]);
    docContent = docResult.content;
    codeContent = codeResult.content;
    resolvedDocPath = `${repoLabel}/${safeDocPath}`;
    resolvedCodePath = `${repoLabel}/${safeCodePath}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Distinguish 404-style errors from general network errors
    const status = message.includes("not found") ? 404 : 502;
    return errorResponse(status, message);
  }

  const report = runDriftAudit(
    docContent,
    codeContent,
    resolvedDocPath,
    resolvedCodePath,
    repoLabel
  );

  return NextResponse.json(report, { status: 200 });
}
