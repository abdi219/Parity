"use client";

import { useState, useEffect, useRef } from "react";
import type { AuditReport, DriftFinding, RepoMap } from "@/lib/driftEngine";
import type { ContractEndpoint } from "@/types/contract";
import { applyPatches, type UnifiedDiffLine } from "@/lib/patchEngine";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AuditState = "idle" | "scanning" | "done" | "error";
type PatchState = "idle" | "applying" | "reauditing" | "verified" | "error";
type Mode = "demo" | "custom";

// Extended report shape returned by Phase 3 normalized audit
interface ExtendedAuditReport extends AuditReport {
  docEndpoints?: ContractEndpoint[];
  codeEndpoints?: ContractEndpoint[];
}

const DEMO_STEPS = [
  "Resolving target: dummy-auth-service",
  "Reading dummy-auth-service/README.md",
  "Reading dummy-auth-service/src/auth.ts",
  "Parsing documentation contracts (routes, params, auth, responses)",
  "Parsing code contracts (interfaces, handlers, response shapes)",
  "Running drift comparison across 4 contract categories",
  "Generating findings with line-level provenance",
  "Audit complete",
] as const;

const REAUDIT_STEPS = [
  "Applying in-memory patches to documentation",
  "Re-running drift audit on patched documentation",
  "Parsing patched contracts (routes, params, auth, responses)",
  "Comparing patched documentation against code contracts",
  "Verification complete",
] as const;

function buildCustomSteps(repoUrl: string, docPath: string, codePath: string): readonly string[] {
  const label = repoUrl.replace("https://github.com/", "").replace(/\/$/, "") || "repo";
  return [
    `Resolving target: ${label}`,
    `Discovering repository tree via GitHub Trees API`,
    `Fetching ${docPath}`,
    `Fetching ${codePath}`,
    "Extracting documentation contracts (hybrid: REGEX + Groq fallback)",
    "Extracting code contracts (deterministic: AST/REGEX)",
    "Running normalized drift comparison",
    "Generating findings with line-level provenance",
    "Audit complete",
  ] as const;
}

// ---------------------------------------------------------------------------
// Icons — functional SVG only, no decoration
// ---------------------------------------------------------------------------

function IconCheck() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2 6.5L4.5 9L10 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconAlert() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M6 1L11 10H1L6 1Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M6 4.5V6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="6" cy="8.5" r="0.6" fill="currentColor" />
    </svg>
  );
}

function IconChevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 150ms ease" }}
    >
      <path d="M2 4.5L6 7.5L10 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Extraction method badge — Section 12
// ---------------------------------------------------------------------------

function ExtractionBadge({ method }: { method?: string }) {
  if (!method) return null;
  const colors: Record<string, string> = {
    REGEX:   "border-blue-800 text-blue-400 bg-blue-950/40",
    AST:     "border-violet-800 text-violet-400 bg-violet-950/40",
    GROQ:    "border-amber-800 text-amber-400 bg-amber-950/40",
    OPENAPI: "border-teal-800 text-teal-400 bg-teal-950/40",
  };
  const cls = colors[method] ?? "border-zinc-700 text-zinc-400 bg-zinc-900";
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-mono border tracking-wider shrink-0 ${cls}`}>
      {method}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Severity badge
// ---------------------------------------------------------------------------

function SeverityBadge({ severity }: { severity: DriftFinding["severity"] }) {
  const isCritical = severity === "CRITICAL";
  return (
    <span
      className={[
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold tracking-wider border shrink-0",
        isCritical
          ? "bg-red-950 border-red-800 text-red-300"
          : "bg-amber-950 border-amber-800 text-amber-300",
      ].join(" ")}
    >
      {isCritical ? <IconAlert /> : null}
      {severity}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Drift type badge
// ---------------------------------------------------------------------------

function TypeBadge({ type }: { type: DriftFinding["type"] }) {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono border border-zinc-700 bg-zinc-900 text-zinc-400 tracking-wider shrink-0">
      {type}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Single drift finding card — Section 14
// ---------------------------------------------------------------------------

function DriftCard({ finding }: { finding: DriftFinding }) {
  return (
    <article className="border border-zinc-800 rounded-sm overflow-hidden">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-zinc-900 border-b border-zinc-800">
        <span className="font-mono text-xs text-zinc-500 shrink-0">{finding.id}</span>
        <span className="text-zinc-700 text-xs shrink-0 hidden sm:inline">/</span>
        <span className="font-mono text-xs text-zinc-300 truncate min-w-0 flex-1">{finding.endpoint}</span>
        <div className="flex items-center gap-2 shrink-0 ml-auto flex-wrap">
          <TypeBadge type={finding.type} />
          <SeverityBadge severity={finding.severity} />
        </div>
      </div>

      {/* Side-by-side evidence — Section 14 / Section 12 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 sm:divide-x divide-zinc-800">
        {/* Doc side */}
        <div className="p-3 space-y-1.5 border-b border-zinc-800 sm:border-b-0">
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-500 uppercase tracking-widest">
            <span className="text-red-500">-</span>
            Documentation
          </div>
          <p className="font-mono text-[10px] text-zinc-500 break-all">
            {finding.documentationFile}:{finding.documentationLine}
          </p>
          <p className="font-mono text-xs text-red-300 bg-red-950/30 border border-red-900/40 rounded px-2 py-1.5 leading-5 whitespace-pre-wrap break-words">
            {finding.documentationClaim}
          </p>
        </div>

        {/* Code side */}
        <div className="p-3 space-y-1.5">
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-500 uppercase tracking-widest">
            <span className="text-emerald-500">+</span>
            Code Reality
          </div>
          <p className="font-mono text-[10px] text-zinc-500 break-all">
            {finding.codeFile}:{finding.codeLine}
          </p>
          <p className="font-mono text-xs text-emerald-300 bg-emerald-950/30 border border-emerald-900/40 rounded px-2 py-1.5 leading-5 whitespace-pre-wrap break-words">
            {finding.codeReality}
          </p>
        </div>
      </div>

      {/* Explanation */}
      <div className="px-3 py-2.5 border-t border-zinc-800 bg-zinc-900/50">
        <p className="text-xs text-zinc-400 leading-5">{finding.explanation}</p>
      </div>

      {/* Proposed patch */}
      <div className="border-t border-zinc-800">
        <div className="px-3 py-1.5 bg-zinc-900/60 border-b border-zinc-800">
          <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">Proposed Patch</span>
        </div>
        <pre className="px-3 py-2.5 text-[11px] font-mono text-zinc-300 leading-5 overflow-x-auto whitespace-pre-wrap break-words">
          {finding.proposedPatch}
        </pre>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Terminal stepper
// ---------------------------------------------------------------------------

function TerminalBox({
  steps, step, done, error, label,
}: {
  steps: readonly string[];
  step: number;
  done: boolean;
  error: string | null;
  label: string;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [step]);

  const visibleSteps = done ? steps : steps.slice(0, step + 1);

  return (
    <div className="border border-zinc-800 rounded-sm overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900 border-b border-zinc-800">
        <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">{label}</span>
        {done && !error && <span className="ml-auto text-[10px] font-mono text-emerald-400">exit 0</span>}
        {error && <span className="ml-auto text-[10px] font-mono text-red-400">exit 1</span>}
      </div>
      <div className="bg-zinc-950 px-3 py-3 font-mono text-xs space-y-1 min-h-32 max-h-56 overflow-y-auto">
        {visibleSteps.map((line, i) => {
          const isCurrent = !done && i === step;
          const isPast = done || i < step;
          return (
            <div key={i} className="flex items-start gap-2">
              <span className={isPast ? "text-emerald-500" : isCurrent ? "text-zinc-400 animate-pulse" : "text-zinc-700"}>
                {isPast ? ">" : isCurrent ? ">" : " "}
              </span>
              <span className={["break-all", isPast ? "text-zinc-300" : isCurrent ? "text-zinc-400" : "text-zinc-700"].join(" ")}>
                {line}
              </span>
            </div>
          );
        })}
        {error && (
          <div className="flex items-start gap-2 mt-1">
            <span className="text-red-500 shrink-0">!</span>
            <span className="text-red-400 break-all">{error}</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unified diff viewer — Section 14
// ---------------------------------------------------------------------------

function DiffViewer({ diff, docFile }: { diff: UnifiedDiffLine[]; docFile: string }) {
  if (diff.length === 0) return null;

  return (
    <div className="border border-zinc-800 rounded-sm overflow-hidden">
      <div className="px-3 py-2 bg-zinc-900 border-b border-zinc-800 flex flex-wrap items-center gap-2 justify-between">
        <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest truncate min-w-0">
          Unified Diff — {docFile}
        </span>
        <span className="text-[10px] font-mono text-zinc-600 shrink-0">
          {diff.filter((l) => l.kind === "removed").length} removed&nbsp;&nbsp;
          {diff.filter((l) => l.kind === "added").length} added
        </span>
      </div>
      <div className="bg-zinc-950 overflow-x-auto">
        {diff.map((line, i) => {
          const isRemoved = line.kind === "removed";
          const isAdded = line.kind === "added";
          const lineNumStr = line.lineNumber !== null ? String(line.lineNumber).padStart(4, " ") : "    ";
          return (
            <div
              key={i}
              className={["flex items-start font-mono text-[11px] leading-5", isRemoved ? "bg-red-950/25" : isAdded ? "bg-emerald-950/25" : ""].join(" ")}
            >
              <span className={["select-none w-10 shrink-0 text-right pr-3 border-r border-zinc-800 py-0.5", isRemoved ? "text-red-700" : isAdded ? "text-emerald-700" : "text-zinc-700"].join(" ")}>
                {lineNumStr}
              </span>
              <span className={["w-4 shrink-0 text-center py-0.5", isRemoved ? "text-red-500" : isAdded ? "text-emerald-500" : "text-zinc-700"].join(" ")}>
                {isRemoved ? "-" : isAdded ? "+" : " "}
              </span>
              <span className={["flex-1 py-0.5 pr-3 whitespace-pre-wrap break-all", isRemoved ? "text-red-300" : isAdded ? "text-emerald-300" : "text-zinc-500"].join(" ")}>
                {line.content}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Repository map panel — Section 13
// ---------------------------------------------------------------------------

function RepoMapPanel({ map }: { map: RepoMap }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <section className="border border-zinc-800 rounded-sm overflow-hidden">
      <button
        className="w-full flex items-center justify-between gap-3 px-3 py-2 bg-zinc-900 border-b border-zinc-800 hover:bg-zinc-800/60 transition-colors"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">Repository Map</span>
        <div className="flex items-center gap-3">
          {map.wasCapped && (
            <span className="text-[9px] font-mono text-amber-500 border border-amber-800 bg-amber-950/30 px-1.5 py-0.5 rounded">
              CAPPED AT {map.cappedAt}
            </span>
          )}
          <span className="text-zinc-500"><IconChevron open={expanded} /></span>
        </div>
      </button>

      {/* Always-visible summary row */}
      <div className="px-3 py-2 bg-zinc-950 flex flex-wrap gap-x-5 gap-y-1.5 border-b border-zinc-800">
        <MapStat label="Files discovered" value={String(map.totalFilesDiscovered)} />
        <MapStat label="Doc files" value={String(map.docFiles.length)} />
        <MapStat label="Source files" value={String(map.sourceFiles.length)} />
        <MapStat label="Languages" value={map.languages.join(", ") || "—"} />
        <MapStat label="Extraction" value={map.extractionMethods.join(", ") || "—"} />
      </div>

      {expanded && (
        <div className="px-3 py-3 bg-zinc-950 space-y-3">
          {map.docFiles.length > 0 && (
            <MapFileList label="Documentation files" files={map.docFiles} />
          )}
          {map.sourceFiles.length > 0 && (
            <MapFileList label="API source files" files={map.sourceFiles} />
          )}
          {map.ignoredDirs.length > 0 && (
            <div>
              <p className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest mb-1">Ignored directories</p>
              <p className="font-mono text-[10px] text-zinc-500">{map.ignoredDirs.join(", ")}</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function MapStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest">{label}</span>
      <span className="text-[10px] font-mono text-zinc-300">{value}</span>
    </div>
  );
}

function MapFileList({ label, files }: { label: string; files: string[] }) {
  return (
    <div>
      <p className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest mb-1">{label}</p>
      <ul className="space-y-0.5">
        {files.map((f) => (
          <li key={f} className="font-mono text-[10px] text-zinc-400">{f}</li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Contract surface panel — Section 12 & 14
// ---------------------------------------------------------------------------

function ContractSurface({
  docEndpoints,
  codeEndpoints,
}: {
  docEndpoints: ContractEndpoint[];
  codeEndpoints: ContractEndpoint[];
}) {
  const [expanded, setExpanded] = useState(false);
  if (docEndpoints.length === 0 && codeEndpoints.length === 0) return null;

  return (
    <section className="border border-zinc-800 rounded-sm overflow-hidden">
      <button
        className="w-full flex items-center justify-between gap-3 px-3 py-2 bg-zinc-900 border-b border-zinc-800 hover:bg-zinc-800/60 transition-colors"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">
          Contract Surface — {docEndpoints.length} doc · {codeEndpoints.length} code
        </span>
        <span className="text-zinc-500"><IconChevron open={expanded} /></span>
      </button>

      {expanded && (
        <div className="divide-y divide-zinc-800/60">
          {docEndpoints.length > 0 && (
            <EndpointTable label="Documentation contracts" endpoints={docEndpoints} />
          )}
          {codeEndpoints.length > 0 && (
            <EndpointTable label="Implementation contracts" endpoints={codeEndpoints} />
          )}
        </div>
      )}
    </section>
  );
}

function EndpointTable({ label, endpoints }: { label: string; endpoints: ContractEndpoint[] }) {
  return (
    <div className="px-3 py-3 bg-zinc-950">
      <p className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest mb-2">{label}</p>
      <div className="space-y-1.5">
        {endpoints.map((ep, i) => (
          <div key={i} className="flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
            <span className="text-zinc-500 font-semibold w-14 shrink-0">{ep.method}</span>
            <span className="text-zinc-300 flex-1 min-w-0 truncate">{ep.path}</span>
            {ep.auth && <span className="text-zinc-500 shrink-0">{ep.auth}</span>}
            {ep.lineNumber && (
              <span className="text-zinc-600 shrink-0">:{ep.lineNumber}</span>
            )}
            <ExtractionBadge method={ep.extractionMethod} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audit summary bar
// ---------------------------------------------------------------------------

function AuditSummary({ report }: { report: ExtendedAuditReport }) {
  return (
    <div className="border border-zinc-800 rounded-sm bg-zinc-900 px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex items-center gap-2">
        {report.isClean ? (
          <span className="text-emerald-400"><IconCheck /></span>
        ) : (
          <span className="text-red-400"><IconAlert /></span>
        )}
        <span className="font-mono text-sm font-semibold text-white">
          {report.isClean ? "No drift detected" : `${report.driftCount} drift${report.driftCount !== 1 ? "s" : ""} detected`}
        </span>
      </div>
      <Divider />
      <Stat label="Repository" value={report.targetRepository} mono />
      <Divider />
      <Stat label="Checks run" value={String(report.totalChecks)} mono />
      <Divider />
      <Stat label="Timestamp" value={new Date(report.timestamp).toISOString()} mono />
    </div>
  );
}

function Divider() {
  return <span className="text-zinc-700 select-none hidden sm:inline">|</span>;
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="text-[10px] text-zinc-500 uppercase tracking-widest shrink-0">{label}</span>
      <span className={`text-xs text-zinc-300 truncate ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Verified clean banner — Section 11
// ---------------------------------------------------------------------------

function VerifiedBanner({ report }: { report: AuditReport }) {
  return (
    <div className="border border-emerald-900 rounded-sm bg-emerald-950/20 px-4 py-4 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-emerald-400"><IconCheck /></span>
        <span className="font-mono text-sm font-semibold text-emerald-300">
          Verification passed — 0 drifts remaining
        </span>
      </div>
      <p className="text-xs text-zinc-400 leading-5">
        All {report.totalChecks} contract checks passed on the patched documentation. The closed-loop audit is complete.
      </p>
      <div className="pt-1 border-t border-zinc-800 flex flex-wrap gap-x-4 gap-y-1">
        <Stat label="Drift count" value="0" mono />
        <Divider />
        <Stat label="Checks run" value={String(report.totalChecks)} mono />
        <Divider />
        <Stat label="Verified at" value={new Date(report.timestamp).toISOString()} mono />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FAQ accordion
// ---------------------------------------------------------------------------

const FAQ_ITEMS = [
  {
    q: "What does Parity actually do?",
    a: "Parity reads your API documentation and your source code side by side, then flags every place they contradict each other — a renamed parameter, a missing endpoint, a changed auth method, or a different response shape. Every finding points to the exact line in both files so you know precisely what to fix.",
  },
  {
    q: "Does Parity run or execute my code?",
    a: "No. Parity never starts a server, imports your modules, or makes requests to your API. It reads source files as plain text and extracts contract information through static analysis. Your code is never executed.",
  },
  {
    q: "What if my documentation is written as plain prose, not structured lists?",
    a: "Parity first tries to extract endpoints from your docs using pattern matching — which handles tables, code blocks, and bullet lists well. If that finds nothing, it automatically falls back to an AI model that understands conversational descriptions like \"sends a POST request to /api/users\". Either way, the AI never decides whether drift exists; it only helps read the docs.",
  },
  {
    q: "What kinds of problems does Parity catch?",
    a: "Parity flags four types of drift: a documented route that has no matching handler in the code, request parameters that are named differently in the docs versus the implementation, an authentication method that contradicts (for example, docs say cookie session but code uses a Bearer token), and a response shape mismatch (docs say a plain array, code returns a wrapped object).",
  },
  {
    q: "What API keys do I need?",
    a: "A free Groq API key is recommended — it powers the AI fallback for prose-heavy documentation and is available at no cost at console.groq.com. For auditing GitHub repositories, a GitHub personal access token is optional but raises your request limit from 60 to 5,000 per hour. Both values go in a .env.local file and are never sent to the browser.",
  },
  {
    q: "How does the \"Apply Patches\" button work?",
    a: "Clicking Apply Patches updates your documentation in memory — no files on disk are changed. Parity shows you a line-by-line diff of what would change, then immediately re-runs the full audit against the updated text to confirm that all the flagged issues are resolved.",
  },
] as const;

function FaqAccordion() {
  const [open, setOpen] = useState<number | null>(null);

  return (
    <section>
      <h2 className="text-xs font-mono text-zinc-500 uppercase tracking-widest mb-3">How It Works</h2>
      <div className="border border-zinc-800 rounded-sm divide-y divide-zinc-800">
        {FAQ_ITEMS.map((item, i) => (
          <div key={i}>
            <button
              className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-zinc-900/60 transition-colors"
              onClick={() => setOpen(open === i ? null : i)}
              aria-expanded={open === i}
            >
              <span className="text-sm text-zinc-200">{item.q}</span>
              <span className="text-zinc-500 shrink-0"><IconChevron open={open === i} /></span>
            </button>
            {open === i && (
              <div className="px-4 pb-4 text-sm text-zinc-400 leading-6 bg-zinc-900/30">{item.a}</div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function Home() {
  const [mode, setMode] = useState<Mode>("demo");
  const [repoUrl, setRepoUrl] = useState("");
  const [customDocPath, setCustomDocPath] = useState("README.md");
  const [customCodePath, setCustomCodePath] = useState("src/auth.ts");

  const [auditState, setAuditState] = useState<AuditState>("idle");
  const [scanSteps, setScanSteps] = useState<readonly string[]>(DEMO_STEPS);
  const [scanStep, setScanStep] = useState(0);
  const [report, setReport] = useState<ExtendedAuditReport | null>(null);
  const [originalDoc, setOriginalDoc] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [patchState, setPatchState] = useState<PatchState>("idle");
  const [patchStep, setPatchStep] = useState(0);
  const [diff, setDiff] = useState<UnifiedDiffLine[]>([]);
  const [diffDocFile, setDiffDocFile] = useState("dummy-auth-service/README.md");
  const [verifiedReport, setVerifiedReport] = useState<AuditReport | null>(null);
  const [patchErrorMsg, setPatchErrorMsg] = useState<string | null>(null);

  /** Full reset — clears all audit, patch, and map state per Section 2.A. */
  function resetState() {
    setReport(null);
    setOriginalDoc(null);
    setErrorMsg(null);
    setScanStep(0);
    setPatchState("idle");
    setPatchStep(0);
    setDiff([]);
    setVerifiedReport(null);
    setPatchErrorMsg(null);
  }

  /** Clear All — resets inputs and all derived state (Section 2.A). */
  function clearAll() {
    setRepoUrl("");
    setCustomDocPath("README.md");
    setCustomCodePath("src/auth.ts");
    setAuditState("idle");
    setScanSteps(DEMO_STEPS);
    resetState();
  }

  /**
   * Sanitize a GitHub repo URL to its canonical root form.
   * Strips /blob/, /tree/, .git suffix, and trailing slashes (Section 2.B).
   */
  function sanitizeRepoUrl(url: string): string {
    try {
      const u = new URL(url.trim());
      if (u.hostname !== "github.com") return url.trim();
      const parts = u.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
      if (parts.length < 2 || !parts[0] || !parts[1]) return url.trim();
      return `https://github.com/${parts[0]}/${parts[1]}`;
    } catch {
      return url.trim();
    }
  }

  async function runAudit() {
    if (auditState === "scanning") return;

    if (mode === "custom") {
      const trimmed = repoUrl.trim();
      if (!trimmed) {
        setErrorMsg("Enter a GitHub repository URL to audit.");
        setAuditState("error");
        return;
      }
      if (!trimmed.startsWith("https://github.com/")) {
        setErrorMsg(`Invalid URL. Expected: https://github.com/owner/repo`);
        setAuditState("error");
        return;
      }
    }

    resetState();
    setAuditState("scanning");

    const steps =
      mode === "custom"
        ? buildCustomSteps(repoUrl, customDocPath || "README.md", customCodePath || "src/auth.ts")
        : DEMO_STEPS;
    setScanSteps(steps);

    let stepIndex = 0;
    const totalSteps = steps.length - 1;

    const interval = setInterval(() => {
      stepIndex = Math.min(stepIndex + 1, totalSteps - 1);
      setScanStep(stepIndex);
    }, 260);

    try {
      const body =
        mode === "demo"
          ? { target: "demo" }
          : {
              target: "custom",
              repoUrl: repoUrl.trim(),
              docPath: customDocPath.trim() || "README.md",
              codePath: customCodePath.trim() || "src/auth.ts",
            };

      const res = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      clearInterval(interval);

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }

      const data = (await res.json()) as ExtendedAuditReport;
      setScanStep(totalSteps);
      setReport(data);
      setAuditState("done");
    } catch (err) {
      clearInterval(interval);
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
      setAuditState("error");
    }
  }

  async function runApplyAndReaudit() {
    if (!report || report.findings.length === 0) return;
    if (patchState === "applying" || patchState === "reauditing") return;

    setPatchState("applying");
    setPatchStep(0);
    setDiff([]);
    setVerifiedReport(null);
    setPatchErrorMsg(null);

    let stepIndex = 0;
    const totalReauditSteps = REAUDIT_STEPS.length - 1;

    const stepInterval = setInterval(() => {
      stepIndex = Math.min(stepIndex + 1, totalReauditSteps - 1);
      setPatchStep(stepIndex);
    }, 300);

    try {
      const docRes = await fetch("/api/audit-source");
      let sourceDoc: string;

      if (docRes.ok) {
        const srcData = (await docRes.json()) as { docContent?: string };
        sourceDoc = srcData.docContent ?? "";
      } else {
        sourceDoc = originalDoc ?? "";
      }

      if (!sourceDoc) {
        throw new Error("Could not retrieve original documentation source for patching.");
      }

      const { patchedDoc, diff: patchDiff } = applyPatches(sourceDoc, report.findings);
      setDiff(patchDiff);
      setDiffDocFile(report.findings[0]?.documentationFile ?? "README.md");
      setPatchState("reauditing");

      const reauditRes = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "demo", patchedDocContent: patchedDoc }),
      });

      clearInterval(stepInterval);

      if (!reauditRes.ok) {
        const errData = (await reauditRes.json()) as { error?: string };
        throw new Error(errData.error ?? `HTTP ${reauditRes.status}`);
      }

      const reauditData = (await reauditRes.json()) as AuditReport;
      setPatchStep(totalReauditSteps);

      if (reauditData.isClean) {
        setVerifiedReport(reauditData);
        setPatchState("verified");
      } else {
        setPatchErrorMsg(
          `Re-audit returned ${reauditData.driftCount} unresolved finding${reauditData.driftCount !== 1 ? "s" : ""}.`
        );
        setPatchState("error");
      }
    } catch (err) {
      clearInterval(stepInterval);
      const msg = err instanceof Error ? err.message : String(err);
      setPatchErrorMsg(msg);
      setPatchState("error");
    }
  }

  useEffect(() => {
    if (auditState !== "done" || originalDoc !== null) return;
    fetch("/api/audit-source", { method: "GET" })
      .then(async (r) => {
        if (!r.ok) throw new Error("source unavailable");
        const d = (await r.json()) as { docContent: string };
        setOriginalDoc(d.docContent);
      })
      .catch(() => {
        setOriginalDoc(DEMO_DOC_FALLBACK);
      });
  }, [auditState, originalDoc]);

  const isBusy = auditState === "scanning";
  const canPatch =
    report !== null &&
    auditState === "done" &&
    report.findings.length > 0 &&
    mode === "demo" &&
    patchState === "idle";

  return (
    <div className="min-h-screen flex flex-col bg-zinc-950 text-white">

      {/* Nav */}
      <nav className="border-b border-zinc-800 bg-zinc-950 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-11 flex items-center justify-between">
          <span className="font-mono text-sm font-semibold tracking-tight text-white">Parity</span>
          <div className="flex items-center gap-3">
            <button
              onClick={clearAll}
              disabled={isBusy}
              className="font-mono text-[11px] text-zinc-500 hover:text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Clear All
            </button>
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
              <span className="font-mono text-[11px] text-zinc-500">System Ready</span>
            </div>
          </div>
        </div>
      </nav>

      {/* Main */}
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 py-8 space-y-8">

        {/* Header */}
        <header className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight text-white">Documentation Drift Audit</h1>
          <p className="text-sm text-zinc-500">
            Evidence-backed contract verification — documentation vs. source code.
          </p>
        </header>

        {/* Mode tabs */}
        <div className="flex items-center border border-zinc-800 rounded-sm overflow-hidden w-fit">
          {(["demo", "custom"] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => { setMode(m); resetState(); setAuditState("idle"); }}
              className={[
                "px-4 h-8 font-mono text-xs font-semibold transition-colors",
                mode === m ? "bg-zinc-800 text-white" : "bg-zinc-950 text-zinc-500 hover:text-zinc-300",
                m === "custom" ? "border-l border-zinc-800" : "",
              ].join(" ")}
            >
              {m === "demo" ? "Demo" : "Public Repo"}
            </button>
          ))}
        </div>

        {/* Control bar */}
        {mode === "demo" ? (
          <section className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
            <div className="flex-1 border border-zinc-800 rounded-sm bg-zinc-900 px-3 h-9 flex items-center min-w-0">
              <span className="font-mono text-xs text-zinc-500 select-none mr-2 shrink-0">target</span>
              <span className="font-mono text-xs text-zinc-300 truncate">dummy-auth-service</span>
              <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono border border-zinc-700 text-zinc-500 bg-zinc-950 shrink-0">
                local
              </span>
            </div>
            <button
              onClick={runAudit}
              disabled={isBusy}
              className={[
                "h-9 px-4 rounded-sm font-mono text-xs font-semibold border transition-colors shrink-0",
                isBusy
                  ? "border-zinc-700 text-zinc-600 bg-zinc-900 cursor-not-allowed"
                  : "border-zinc-600 text-white bg-zinc-900 hover:bg-zinc-800 hover:border-zinc-500 cursor-pointer",
              ].join(" ")}
            >
              {isBusy ? "Scanning..." : "Inspect Auth Service (Demo)"}
            </button>
          </section>
        ) : (
          <section className="space-y-3">
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                type="url"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                onBlur={(e) => setRepoUrl(sanitizeRepoUrl(e.target.value))}
                placeholder="https://github.com/owner/repo"
                disabled={isBusy}
                className="flex-1 h-9 px-3 rounded-sm border border-zinc-800 bg-zinc-900 font-mono text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 disabled:opacity-50 min-w-0"
              />
              <button
                onClick={runAudit}
                disabled={isBusy}
                className={[
                  "h-9 px-4 rounded-sm font-mono text-xs font-semibold border transition-colors shrink-0",
                  isBusy
                    ? "border-zinc-700 text-zinc-600 bg-zinc-900 cursor-not-allowed"
                    : "border-zinc-600 text-white bg-zinc-900 hover:bg-zinc-800 hover:border-zinc-500 cursor-pointer",
                ].join(" ")}
              >
                {isBusy ? "Fetching..." : "Audit Public Repo"}
              </button>
            </div>
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1 flex items-center gap-2 min-w-0">
                <span className="font-mono text-[10px] text-zinc-600 uppercase tracking-widest shrink-0">doc</span>
                <input
                  type="text"
                  value={customDocPath}
                  onChange={(e) => setCustomDocPath(e.target.value)}
                  placeholder="README.md"
                  disabled={isBusy}
                  className="flex-1 h-8 px-2 rounded-sm border border-zinc-800 bg-zinc-900 font-mono text-xs text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 disabled:opacity-50 min-w-0"
                />
              </div>
              <div className="flex-1 flex items-center gap-2 min-w-0">
                <span className="font-mono text-[10px] text-zinc-600 uppercase tracking-widest shrink-0">code</span>
                <input
                  type="text"
                  value={customCodePath}
                  onChange={(e) => setCustomCodePath(e.target.value)}
                  placeholder="src/auth.ts"
                  disabled={isBusy}
                  className="flex-1 h-8 px-2 rounded-sm border border-zinc-800 bg-zinc-900 font-mono text-xs text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 disabled:opacity-50 min-w-0"
                />
              </div>
            </div>
          </section>
        )}

        {/* Execution log */}
        {auditState !== "idle" && (
          <TerminalBox
            steps={scanSteps}
            step={scanStep}
            done={auditState === "done" || auditState === "error"}
            error={auditState === "error" ? errorMsg : null}
            label="Execution Log"
          />
        )}

        {/* Repository map — Section 13 */}
        {report?.repoMap && auditState === "done" && (
          <RepoMapPanel map={report.repoMap} />
        )}

        {/* Audit summary */}
        {report && auditState === "done" && (
          <AuditSummary report={report} />
        )}

        {/* Contract surface — Section 12 & 14 */}
        {report && auditState === "done" && (report.docEndpoints || report.codeEndpoints) && (
          <ContractSurface
            docEndpoints={report.docEndpoints ?? []}
            codeEndpoints={report.codeEndpoints ?? []}
          />
        )}

        {/* Drift findings matrix — Section 14 */}
        {report && auditState === "done" && report.findings.length > 0 && (
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xs font-mono text-zinc-500 uppercase tracking-widest">
                Findings — {report.driftCount} drift{report.driftCount !== 1 ? "s" : ""}
              </h2>
              {canPatch && (
                <button
                  onClick={runApplyAndReaudit}
                  className="h-8 px-4 rounded-sm font-mono text-xs font-semibold border border-zinc-600 text-white bg-zinc-900 hover:bg-zinc-800 hover:border-zinc-500 cursor-pointer transition-colors shrink-0"
                >
                  Apply Recommended Patches
                </button>
              )}
              {(patchState === "applying" || patchState === "reauditing") && (
                <span className="font-mono text-[11px] text-zinc-500 animate-pulse">Applying patches...</span>
              )}
            </div>
            <div className="space-y-3">
              {report.findings.map((f) => (
                <DriftCard key={f.id} finding={f} />
              ))}
            </div>
          </section>
        )}

        {/* Clean state */}
        {report && auditState === "done" && report.isClean && patchState === "idle" && (
          <div className="border border-zinc-800 rounded-sm bg-zinc-900 px-4 py-6 flex items-center gap-3">
            <span className="text-emerald-400"><IconCheck /></span>
            <span className="text-sm text-zinc-300">
              All contract checks passed. Documentation matches the implementation.
            </span>
          </div>
        )}

        {/* Error state */}
        {auditState === "error" && errorMsg && (
          <div className="border border-red-900 rounded-sm bg-red-950/20 px-4 py-3 flex items-start gap-2">
            <span className="text-red-400 mt-0.5 shrink-0"><IconAlert /></span>
            <span className="font-mono text-xs text-red-300 break-all">{errorMsg}</span>
          </div>
        )}

        {/* Patch & verification section — Section 11 */}
        {patchState !== "idle" && (
          <section className="space-y-4">
            <h2 className="text-xs font-mono text-zinc-500 uppercase tracking-widest">
              Patch Verification Loop
            </h2>

            <TerminalBox
              steps={REAUDIT_STEPS}
              step={patchStep}
              done={patchState === "verified" || patchState === "error"}
              error={patchState === "error" ? patchErrorMsg : null}
              label="Re-audit Log"
            />

            {diff.length > 0 && <DiffViewer diff={diff} docFile={diffDocFile} />}

            {patchState === "verified" && verifiedReport && (
              <VerifiedBanner report={verifiedReport} />
            )}

            {patchState === "error" && patchErrorMsg && (
              <div className="border border-red-900 rounded-sm bg-red-950/20 px-4 py-3 flex items-start gap-2">
                <span className="text-red-400 mt-0.5 shrink-0"><IconAlert /></span>
                <span className="font-mono text-xs text-red-300 break-all">{patchErrorMsg}</span>
              </div>
            )}
          </section>
        )}

        {/* FAQ */}
        <FaqAccordion />

      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-800">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-1">
          <span className="font-mono text-[11px] text-zinc-600">
            Parity — evidence-backed documentation drift verification
          </span>
          <span className="font-mono text-[11px] text-zinc-700">
            deterministic · offline-first · zero fabricated metrics
          </span>
        </div>
      </footer>

    </div>
  );
}

// ---------------------------------------------------------------------------
// Demo doc fallback (used when audit-source is unavailable)
// ---------------------------------------------------------------------------

const DEMO_DOC_FALLBACK = `# Auth & User Service API (v1.2.0)

Internal authentication and user management service.

## Endpoints

### 1. User Login
Authenticate an existing user session.

- Route: POST /api/v1/auth/login
- Headers: Content-Type: application/json
- Request Body:
  {
    "username": "johndoe",
    "password": "secretpassword"
  }
- Authentication Method: Stateful cookie-based authentication via Redis session store (Set-Cookie: session_id=...).

---

### 2. List Users
Fetch the active user directory for administration.

- Route: GET /api/v1/users
- Headers:
  - Cookie: session_id=<session_token>
- Response (200 OK):
  Returns a raw array of user records:
  [
    { "id": "usr_101", "name": "Alice" },
    { "id": "usr_102", "name": "Bob" }
  ]`;
