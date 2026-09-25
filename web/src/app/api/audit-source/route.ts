import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

export async function GET(): Promise<NextResponse<{ docContent: string } | { error: string }>> {
  const repoRoot = path.join(process.cwd(), "..");
  const docPath = path.join(repoRoot, "dummy-auth-service", "README.md");

  try {
    const docContent = await fs.readFile(docPath, "utf-8");
    return NextResponse.json({ docContent }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to read source file: ${message}` }, { status: 500 });
  }
}
