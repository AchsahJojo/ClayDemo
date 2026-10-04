"use client";

import { useEffect, useState, useTransition } from "react";
import type { AnalysisResult, WorkflowDefinition } from "@/lib/engine";
import { WorkflowGraph } from "@/components/WorkflowGraph";
import { fmtNum, fmtPct, fmtUsd } from "@/lib/utils";

export default function HomePage() {
  const [csv, setCsv] = useState("");
  const [workflowText, setWorkflowText] = useState("");
  const [workflow, setWorkflow] = useState<WorkflowDefinition | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [explanation, setExplanation] = useState("");
  const [explainSource, setExplainSource] = useState<"llm" | "template" | "">("");
  const [error, setError] = useState("");
  const [showEngine, setShowEngine] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    startTransition(async () => {
      try {
        const res = await fetch("/api/sample");
        const data = await res.json();
        setCsv(data.csv);
        setWorkflowText(JSON.stringify(data.workflow, null, 2));
        setWorkflow(data.workflow);
        await runAnalyze(data.csv, JSON.stringify(data.workflow));
      } catch {
        setError("Failed to load sample fixtures");
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runAnalyze(csvIn = csv, wfIn = workflowText) {
    setError("");
    try {
      const wf = JSON.parse(wfIn);
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: csvIn, workflow: wf }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analyze failed");
      setWorkflow(wf);
      setResult(data.result);
      const ex = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ result: data.result }),
      });
      const exData = await ex.json();
      setExplanation(exData.explanation ?? "");
      setExplainSource(exData.source ?? "template");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analyze failed");
    }
  }

  function onCsvFile(file: File | null) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result ?? ""));
    reader.readAsText(file);
  }

  const m = result?.metrics;

  return (
    <main className="mx-auto max-w-6xl px-4 pb-16 pt-8 sm:px-6">
      <header className="rise mb-8">
        <p className="brand text-4xl tracking-tight text-[var(--teal)] sm:text-5xl">
          Clay Workflow Health
        </p>
        <h1 className="mt-3 max-w-2xl text-2xl font-medium leading-snug text-[var(--ink)] sm:text-3xl">
          Estimate waste after you define the workflow — Actions and Data Credits, separately.
        </h1>
        <p className="mt-3 max-w-xl text-[var(--muted)]">
          Clay already estimates cost before a run. This demo applies query-optimizer thinking
          (predicate pushdown) to your GTM table using CSV + workflow JSON.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <button
            className="rounded-md bg-[var(--teal)] px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-60"
            disabled={pending}
            onClick={() => startTransition(() => runAnalyze())}
          >
            {pending ? "Analyzing…" : "Analyze workflow"}
          </button>
          <button
            className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-4 py-2 text-sm font-medium"
            onClick={() => setShowEngine((v) => !v)}
          >
            Why not GPT?
          </button>
        </div>
      </header>

      <section className="rise grid gap-4 md:grid-cols-2" style={{ animationDelay: "80ms" }}>
        <label className="block rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
          <span className="text-sm font-semibold">Clay CSV export</span>
          <input
            type="file"
            accept=".csv,text/csv"
            className="mt-2 block w-full text-sm"
            onChange={(e) => onCsvFile(e.target.files?.[0] ?? null)}
          />
          <textarea
            className="mt-3 h-40 w-full rounded-md border border-[var(--line)] bg-white/70 p-2 font-mono text-xs"
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
          />
        </label>
        <label className="block rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
          <span className="text-sm font-semibold">Workflow JSON</span>
          <textarea
            className="mt-3 h-[220px] w-full rounded-md border border-[var(--line)] bg-white/70 p-2 font-mono text-xs"
            value={workflowText}
            onChange={(e) => setWorkflowText(e.target.value)}
          />
        </label>
      </section>

      {error && (
        <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}

      {m && (
        <>
          <section
            className="rise mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7"
            style={{ animationDelay: "140ms" }}
          >
            <Metric label="Overall" value={`${m.overallScore}`} hint="health score" />
            <Metric label="Actions" value={fmtNum(m.actionsUsed)} hint="meter" accent="teal" />
            <Metric
              label="Data Credits"
              value={fmtNum(m.dataCreditsUsed)}
              hint="meter"
              accent="amber"
            />
            <Metric label="$ / run" value={fmtUsd(m.usdPerRun)} hint="both meters" />
            <Metric
              label="Waste"
              value={`${fmtNum(m.wasteActions)}A / ${fmtNum(m.wasteDataCredits)}DC`}
              hint="R1–R3"
            />
            <Metric
              label="ICP efficiency"
              value={fmtPct(m.icpEfficiencyDataCredits)}
              hint="DC on ICP rows"
            />
            <Metric label="Data confidence" value={fmtPct(m.dataConfidence)} hint="fill only" />
          </section>

          <p className="mt-3 text-xs text-[var(--muted)]">
            Blank ≠ paid failure. Skipped vs refunded cannot be told from CSV alone — blanks are
            reported as ambiguous.
          </p>

          <section className="rise mt-8 grid gap-6 lg:grid-cols-[1.1fr_0.9fr]" style={{ animationDelay: "200ms" }}>
            <div>
              <h2 className="text-xl">Recommendations</h2>
              <ul className="mt-3 space-y-3">
                {result!.findings.map((f) => (
                  <li
                    key={`${f.rule}-${f.title}`}
                    className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="font-semibold">
                        <span className="text-[var(--amber)]">{f.rule}</span> · {f.title}
                      </p>
                      <p className="shrink-0 text-sm text-[var(--teal)]">
                        −{fmtNum(f.savingsActions)}A / −{fmtNum(f.savingsDataCredits)}DC
                      </p>
                    </div>
                    <p className="mt-2 text-sm text-[var(--muted)]">{f.summary}</p>
                  </li>
                ))}
              </ul>

              <div className="mt-6 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
                <h3 className="font-semibold">AI explainer ({explainSource || "template"})</h3>
                <pre className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[var(--muted)]">
                  {explanation}
                </pre>
              </div>
            </div>

            <div>
              <h2 className="text-xl">Workflow DAG</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">
                Solid edges = dependsOn. Animated teal = suggested order after filter pushdown.
                Waterfall nodes show recommended provider sequence.
              </p>
              {workflow && result && (
                <div className="mt-3">
                  <WorkflowGraph workflow={workflow} result={result} />
                </div>
              )}
              {m.waterfallEfficiency != null && (
                <p className="mt-3 text-sm">
                  Waterfall efficiency (recommended ÷ current E[cost]):{" "}
                  <strong>{fmtPct(m.waterfallEfficiency)}</strong>
                </p>
              )}
            </div>
          </section>
        </>
      )}

      {showEngine && result && (
        <section className="rise mt-8 rounded-xl border border-[var(--line)] bg-[#1c1917] p-4 text-[#f5f5f4]">
          <h2 className="text-lg text-[#ccfbf1]">Engine JSON (why not GPT?)</h2>
          <p className="mt-1 text-sm text-[#a8a29e]">
            The model only narrates these fields — it does not invent savings.
          </p>
          <pre className="mt-3 max-h-96 overflow-auto text-xs leading-relaxed">
            {JSON.stringify(
              {
                metrics: result.metrics,
                findings: result.findings,
                simulationSteps: result.simulation.steps,
              },
              null,
              2
            )}
          </pre>
        </section>
      )}
    </main>
  );
}

function Metric({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint: string;
  accent?: "teal" | "amber";
}) {
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-3">
      <p className="text-[11px] uppercase tracking-wide text-[var(--muted)]">{label}</p>
      <p
        className={`mt-1 text-lg font-semibold ${
          accent === "teal"
            ? "text-[var(--teal)]"
            : accent === "amber"
              ? "text-[var(--amber)]"
              : ""
        }`}
      >
        {value}
      </p>
      <div className="meter-bar mt-2 h-1 overflow-hidden rounded bg-[var(--line)]">
        <span
          className={`block h-full w-full ${
            accent === "amber" ? "bg-[var(--amber)]" : "bg-[var(--teal)]"
          }`}
        />
      </div>
      <p className="mt-1 text-[11px] text-[var(--muted)]">{hint}</p>
    </div>
  );
}
