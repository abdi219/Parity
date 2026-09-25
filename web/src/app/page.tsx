"use client";

import { useState, useEffect, useRef } from "react";
import type { AuditReport, DriftFinding } from "@/lib/driftEngine";
import { applyPatches, type UnifiedDiffLine } from "@/lib/patchEngine";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AuditState = "idle" | "scanning" | "done" | "error";
type PatchState = "idle" | "applying" | "reauditing" | "verified" | "error";

const SCAN_STEPS = [
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
// Severity badge
// ---------------------------------------------------------------------------

function SeverityBadge({ severity }: { severity: DriftFinding["severity"] }) {
  const isCritical = severity === "CRITICAL";
  return (
    <span
      className={[
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold tracking-wider border",
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
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono border border-zinc-700 bg-zinc-900 text-zinc-400 tracking-wider">
      {type}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Single drift card
// ---------------------------------------------------------------------------

function DriftCard({ finding }: { finding: DriftFinding }) {
  return (
    <article className="border border-zinc-800 rounded-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-3 py-2 bg-zinc-900 border-b border-zinc-800">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-xs text-zinc-500 shrink-0">{finding.id}</span>
          <span className="text-zinc-700 text-xs shrink-0">/</span>
          <span className="font-mono text-xs text-zinc-300 truncate">{finding.endpoint}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <TypeBadge type={finding.type} />
          <SeverityBadge severity={finding.severity} />
        </div>
      </div>

      {/* Side-by-side comparison */}
      <div className="grid grid-cols-2 divide-x divide-zinc-800">
        {/* Doc side */}
        <div className="p-3 space-y-1.5">
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-500 uppercase tracking-widest">
            <span className="text-red-500">-</span>
            Documentation
          </div>
          <p className="font-mono text-[10px] text-zinc-500">
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
          <p className="font-mono text-[10px] text-zinc-500">
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
// Terminal stepper (shared between initial scan and re-audit)
// ---------------------------------------------------------------------------

function TerminalBox({
  steps,
  step,
  done,
  error,
  label,
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
        {done && !error && (
          <span className="ml-auto text-[10px] font-mono text-emerald-400">exit 0</span>
        )}
        {error && (
          <span className="ml-auto text-[10px] font-mono text-red-400">exit 1</span>
        )}
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
              <span className={isPast ? "text-zinc-300" : isCurrent ? "text-zinc-400" : "text-zinc-700"}>
                {line}
              </span>
            </div>
          );
        })}
        {error && (
          <div className="flex items-start gap-2 mt-1">
            <span className="text-red-500">!</span>
            <span className="text-red-400">{error}</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unified diff viewer
// ---------------------------------------------------------------------------

function DiffViewer({ diff }: { diff: UnifiedDiffLine[] }) {
  if (diff.length === 0) return null;

  return (
    <div className="border border-zinc-800 rounded-sm overflow-hidden">
      <div className="px-3 py-2 bg-zinc-900 border-b border-zinc-800 flex items-center justify-between">
        <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">
          Unified Diff — dummy-auth-service/README.md
        </span>
        <span className="text-[10px] font-mono text-zinc-600">
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
              className={[
                "flex items-start font-mono text-[11px] leading-5 px-0",
                isRemoved ? "bg-red-950/25" : isAdded ? "bg-emerald-950/25" : "",
              ].join(" ")}
            >
              <span className={[
                "select-none w-10 shrink-0 text-right pr-3 border-r border-zinc-800 py-0.5",
                isRemoved ? "text-red-700" : isAdded ? "text-emerald-700" : "text-zinc-700",
              ].join(" ")}>
                {lineNumStr}
              </span>
              <span className={[
                "w-4 shrink-0 text-center py-0.5",
                isRemoved ? "text-red-500" : isAdded ? "text-emerald-500" : "text-zinc-700",
              ].join(" ")}>
                {isRemoved ? "-" : isAdded ? "+" : " "}
              </span>
              <span className={[
                "flex-1 py-0.5 pr-3 whitespace-pre-wrap break-all",
                isRemoved ? "text-red-300" : isAdded ? "text-emerald-300" : "text-zinc-500",
              ].join(" ")}>
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
// Audit summary bar
// ---------------------------------------------------------------------------

function AuditSummary({ report }: { report: AuditReport }) {
  return (
    <div className="border border-zinc-800 rounded-sm bg-zinc-900 px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2">
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
  return <span className="text-zinc-700 select-none">|</span>;
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-zinc-500 uppercase tracking-widest">{label}</span>
      <span className={`text-xs text-zinc-300 ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Verified clean banner
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
    q: "How does Parity detect drift without running the service?",
    a: "Parity performs static analysis only. It reads Markdown documentation and TypeScript source files as plain text, extracts contracts via regex-based parsing (routes, parameter names, auth schemes, response shapes), and compares them deterministically. No server is started, no network requests are made.",
  },
  {
    q: "What are the four supported drift classifications?",
    a: "ROUTE_MISMATCH: the documented HTTP method or path differs from the code. PARAM_MISMATCH: a documented request body field name is absent or renamed in the handler. AUTH_MISMATCH: the documented authentication scheme (e.g. session cookie) contradicts the code (e.g. Bearer JWT). RESPONSE_MISMATCH: the documented response shape (raw array vs. wrapped object) differs from what the handler actually returns.",
  },
  {
    q: "Where do the line numbers come from?",
    a: "Every finding carries exact 1-based line numbers for both the documentation file and the code file. The parser tracks line offsets while scanning and records the specific line at which each claim or reality was found — there are no approximations or averages.",
  },
  {
    q: "Is any data sent to an external service?",
    a: "No. The entire audit pipeline runs inside the Next.js server route handler using only Node.js built-ins (fs.promises). No external APIs, no telemetry, no network calls after the browser posts to /api/audit.",
  },
  {
    q: "How does the patch-and-re-audit loop work?",
    a: "When you click Apply Recommended Patches, the patch engine runs entirely in the browser. It applies verbatim string replacements to the in-memory documentation, generates a unified diff, and sends the patched content to /api/audit as patchedDocContent. The server re-runs the drift engine against the patched doc and the original code. No files on disk are modified.",
  },
] as const;

function FaqAccordion() {
  const [open, setOpen] = useState<number | null>(null);

  return (
    <section>
      <h2 className="text-xs font-mono text-zinc-500 uppercase tracking-widest mb-3">
        How It Works
      </h2>
      <div className="border border-zinc-800 rounded-sm divide-y divide-zinc-800">
        {FAQ_ITEMS.map((item, i) => (
          <div key={i}>
            <button
              className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-zinc-900/60 transition-colors"
              onClick={() => setOpen(open === i ? null : i)}
              aria-expanded={open === i}
            >
              <span className="text-sm text-zinc-200">{item.q}</span>
              <span className="text-zinc-500 shrink-0">
                <IconChevron open={open === i} />
              </span>
            </button>
            {open === i && (
              <div className="px-4 pb-4 text-sm text-zinc-400 leading-6 bg-zinc-900/30">
                {item.a}
              </div>
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
  const [auditState, setAuditState] = useState<AuditState>("idle");
  const [scanStep, setScanStep] = useState(0);
  const [report, setReport] = useState<AuditReport | null>(null);
  const [originalDoc, setOriginalDoc] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [patchState, setPatchState] = useState<PatchState>("idle");
  const [patchStep, setPatchStep] = useState(0);
  const [diff, setDiff] = useState<UnifiedDiffLine[]>([]);
  const [verifiedReport, setVerifiedReport] = useState<AuditReport | null>(null);
  const [patchErrorMsg, setPatchErrorMsg] = useState<string | null>(null);

  async function runDemoAudit() {
    if (auditState === "scanning") return;

    setAuditState("scanning");
    setReport(null);
    setOriginalDoc(null);
    setErrorMsg(null);
    setScanStep(0);
    // Reset patch state on fresh audit
    setPatchState("idle");
    setDiff([]);
    setVerifiedReport(null);
    setPatchErrorMsg(null);

    let stepIndex = 0;
    const totalSteps = SCAN_STEPS.length - 1;

    const interval = setInterval(() => {
      stepIndex = Math.min(stepIndex + 1, totalSteps - 1);
      setScanStep(stepIndex);
    }, 260);

    try {
      const res = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "demo" }),
      });

      clearInterval(interval);

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }

      const data = (await res.json()) as AuditReport & { _docContent?: string };
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
      // Step 1: fetch original doc content from the API to patch against.
      // We do this by requesting a fresh demo audit which returns the report;
      // the original doc content is fetched separately via a second call so we
      // always have the unmodified source.
      const docRes = await fetch("/api/doc-source");
      let sourceDoc: string;

      if (docRes.ok) {
        const srcData = (await docRes.json()) as { docContent?: string };
        sourceDoc = srcData.docContent ?? "";
      } else {
        // Fall back: use the cached originalDoc if available.
        sourceDoc = originalDoc ?? "";
      }

      if (!sourceDoc) {
        throw new Error("Could not retrieve original documentation source for patching.");
      }

      // Step 2: apply patches in memory (pure client-side).
      const { patchedDoc, diff: patchDiff } = applyPatches(sourceDoc, report.findings);
      setDiff(patchDiff);
      setPatchState("reauditing");

      // Step 3: send patched doc content to the API for re-audit.
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
        // Unexpected: patches did not resolve all findings.
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

  // The API does not expose a /doc-source endpoint yet; we load originalDoc
  // from the audit response via a parallel fetch of the raw file content.
  // To avoid adding another endpoint, we fetch it via the audit route using
  // a probe call and capture what the patchEngine needs from page state.
  // When the initial audit completes, also fetch the raw doc for patching.
  useEffect(() => {
    if (auditState !== "done" || originalDoc !== null) return;

    // Fetch the source doc content for use by the patcher.
    // We call /api/audit-source which we define below; if unavailable we
    // fall back to the embedded known content for the demo.
    fetch("/api/audit-source", { method: "GET" })
      .then(async (r) => {
        if (!r.ok) throw new Error("source unavailable");
        const d = (await r.json()) as { docContent: string };
        setOriginalDoc(d.docContent);
      })
      .catch(() => {
        // Hard-coded fallback — the demo doc is known and static.
        setOriginalDoc(DEMO_DOC_FALLBACK);
      });
  }, [auditState, originalDoc]);

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      {/* Nav */}
      <nav className="border-b border-zinc-800 bg-zinc-950 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 h-11 flex items-center justify-between">
          <span className="font-mono text-sm font-semibold tracking-tight text-white">
            Parity
          </span>
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span className="font-mono text-[11px] text-zinc-500">System Ready</span>
          </div>
        </div>
      </nav>

      <main className="max-w-5xl mx-auto px-4 py-8 space-y-8">

        {/* Header */}
        <header className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight text-white">
            Documentation Drift Audit
          </h1>
          <p className="text-sm text-zinc-500">
            Static contract verification — documentation vs. TypeScript route handlers.
          </p>
        </header>

        {/* Control bar */}
        <section className="flex items-center gap-3">
          <div className="flex-1 border border-zinc-800 rounded-sm bg-zinc-900 px-3 h-9 flex items-center">
            <span className="font-mono text-xs text-zinc-500 select-none mr-2">target</span>
            <span className="font-mono text-xs text-zinc-300">dummy-auth-service</span>
            <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono border border-zinc-700 text-zinc-500 bg-zinc-950">
              demo
            </span>
          </div>
          <button
            onClick={runDemoAudit}
            disabled={auditState === "scanning"}
            className={[
              "h-9 px-4 rounded-sm font-mono text-xs font-semibold border transition-colors shrink-0",
              auditState === "scanning"
                ? "border-zinc-700 text-zinc-600 bg-zinc-900 cursor-not-allowed"
                : "border-zinc-600 text-white bg-zinc-900 hover:bg-zinc-800 hover:border-zinc-500 cursor-pointer",
            ].join(" ")}
          >
            {auditState === "scanning" ? "Scanning..." : "Inspect Auth Service (Demo)"}
          </button>
        </section>

        {/* Initial scan terminal */}
        {auditState !== "idle" && (
          <TerminalBox
            steps={SCAN_STEPS}
            step={scanStep}
            done={auditState === "done" || auditState === "error"}
            error={auditState === "error" ? errorMsg : null}
            label="Execution Log"
          />
        )}

        {/* Audit summary */}
        {report && auditState === "done" && (
          <AuditSummary report={report} />
        )}

        {/* Drift matrix */}
        {report && auditState === "done" && report.findings.length > 0 && (
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-xs font-mono text-zinc-500 uppercase tracking-widest">
                Drift Matrix — {report.driftCount} finding{report.driftCount !== 1 ? "s" : ""}
              </h2>
              {patchState === "idle" && (
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

        {/* Clean state (initial audit returned 0 findings) */}
        {report && auditState === "done" && report.isClean && patchState === "idle" && (
          <div className="border border-zinc-800 rounded-sm bg-zinc-900 px-4 py-6 flex items-center gap-3">
            <span className="text-emerald-400"><IconCheck /></span>
            <span className="text-sm text-zinc-300">
              All contract checks passed. Documentation matches the implementation.
            </span>
          </div>
        )}

        {/* Error state (initial audit) */}
        {auditState === "error" && errorMsg && (
          <div className="border border-red-900 rounded-sm bg-red-950/20 px-4 py-3 flex items-start gap-2">
            <span className="text-red-400 mt-0.5 shrink-0"><IconAlert /></span>
            <span className="font-mono text-xs text-red-300">{errorMsg}</span>
          </div>
        )}

        {/* Patch section */}
        {(patchState !== "idle") && (
          <section className="space-y-4">
            <h2 className="text-xs font-mono text-zinc-500 uppercase tracking-widest">
              Patch Verification Loop
            </h2>

            {/* Re-audit terminal */}
            <TerminalBox
              steps={REAUDIT_STEPS}
              step={patchStep}
              done={patchState === "verified" || patchState === "error"}
              error={patchState === "error" ? patchErrorMsg : null}
              label="Re-audit Log"
            />

            {/* Unified diff */}
            {diff.length > 0 && (
              <DiffViewer diff={diff} />
            )}

            {/* Verified clean banner */}
            {patchState === "verified" && verifiedReport && (
              <VerifiedBanner report={verifiedReport} />
            )}

            {/* Patch error */}
            {patchState === "error" && patchErrorMsg && (
              <div className="border border-red-900 rounded-sm bg-red-950/20 px-4 py-3 flex items-start gap-2">
                <span className="text-red-400 mt-0.5 shrink-0"><IconAlert /></span>
                <span className="font-mono text-xs text-red-300">{patchErrorMsg}</span>
              </div>
            )}
          </section>
        )}

        {/* FAQ */}
        <FaqAccordion />

      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-800 mt-16">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <span className="font-mono text-[11px] text-zinc-600">
            Parity — stateless documentation drift verification
          </span>
          <span className="font-mono text-[11px] text-zinc-700">
            offline-first · deterministic · zero external deps
          </span>
        </div>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Demo doc fallback (used when /api/audit-source is unavailable)
// Mirrors dummy-auth-service/README.md exactly so patchEngine can operate.
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
