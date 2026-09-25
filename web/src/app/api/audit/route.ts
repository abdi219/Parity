import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { runDriftAudit, AuditReport } from "@/lib/driftEngine";

interface RequestBody {
  target: "demo" | "custom";
  repoUrl?: string;
}

function errorResponse(status: number, message: string): NextResponse<{ error: string }> {
  return NextResponse.json<{ error: string }>({ error: message }, { status });
}

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

  const { target } = body as RequestBody;

  if (target !== "demo" && target !== "custom") {
    return errorResponse(400, 'Field "target" must be "demo" or "custom".');
  }

  if (target === "custom") {
    return errorResponse(400, 'Custom repository auditing is not yet supported. Use target "demo".');
  }

  // target === "demo": load dummy-auth-service files from disk.
  // process.cwd() resolves to the web/ directory when Next.js is running,
  // so dummy-auth-service/ lives one directory above.
  const repoRoot = path.join(process.cwd(), "..");
  const docPath = path.join(repoRoot, "dummy-auth-service", "README.md");
  const codePath = path.join(repoRoot, "dummy-auth-service", "src", "auth.ts");

  let docContent: string;
  let codeContent: string;

  try {
    [docContent, codeContent] = await Promise.all([
      fs.readFile(docPath, "utf-8"),
      fs.readFile(codePath, "utf-8"),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(500, `Failed to read demo service files: ${message}`);
  }

  const report = runDriftAudit(
    docContent,
    codeContent,
    "dummy-auth-service/README.md",
    "dummy-auth-service/src/auth.ts",
    "dummy-auth-service"
  );

  return NextResponse.json(report, { status: 200 });
}
