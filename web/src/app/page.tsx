"use client";

import { useState, useEffect, useRef } from "react";
import type { AuditReport, DriftFinding } from "@/lib/driftEngine";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AuditState = "idle" | "scanning" | "done" | "error";

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
// Terminal stepper
// ---------------------------------------------------------------------------

function TerminalBox({ step, done, error }: { step: number; done: boolean; error: string | null }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [step]);

  const visibleSteps = done ? SCAN_STEPS : SCAN_STEPS.slice(0, step + 1);

  return (
    <div className="border border-zinc-800 rounded-sm overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900 border-b border-zinc-800">
        <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">Execution Log</span>
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
    q: "What does the proposed patch contain?",
    a: "Each finding includes a minimal unified-diff-style patch that corrects only the contradicted line or block in the documentation. Surrounding unrelated content is left untouched, per the patch cleanliness invariant.",
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
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function runDemoAudit() {
    if (auditState === "scanning") return;

    setAuditState("scanning");
    setReport(null);
    setErrorMsg(null);
    setScanStep(0);

    // Advance the terminal stepper while the request is in flight
    let stepIndex = 0;
    const totalSteps = SCAN_STEPS.length - 1; // last step shown on completion

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

      const data = (await res.json()) as AuditReport;
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

        {/* Terminal */}
        {auditState !== "idle" && (
          <TerminalBox
            step={scanStep}
            done={auditState === "done"}
            error={errorMsg}
          />
        )}

        {/* Audit summary */}
        {report && auditState === "done" && (
          <AuditSummary report={report} />
        )}

        {/* Drift matrix */}
        {report && auditState === "done" && report.findings.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-xs font-mono text-zinc-500 uppercase tracking-widest">
              Drift Matrix — {report.driftCount} finding{report.driftCount !== 1 ? "s" : ""}
            </h2>
            <div className="space-y-3">
              {report.findings.map((f) => (
                <DriftCard key={f.id} finding={f} />
              ))}
            </div>
          </section>
        )}

        {/* Clean state */}
        {report && auditState === "done" && report.isClean && (
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
            <span className="font-mono text-xs text-red-300">{errorMsg}</span>
          </div>
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
