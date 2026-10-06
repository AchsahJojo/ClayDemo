"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { AnalysisResult, Finding, WorkflowDefinition } from "@/lib/engine";
import { buildFixedWorkflow, PLAIN_TITLES } from "@/lib/engine";
import { ACTION_USD, DATA_CREDIT_USD } from "@/lib/costs";
import { WorkflowGraph, type GraphMode } from "@/components/WorkflowGraph";
import { fmtNum, fmtPct, fmtUsd } from "@/lib/utils";

const DEFAULT_ICP_GOAL = "Companies with 50–500 employees";
const DEFAULT_WF_DESC =
  "GTM enrichment table — audit waste after the workflow is defined.";
const DEFAULT_ICP_COLUMN = "Companyempcount";
const DEFAULT_ICP_MIN = 50;
const DEFAULT_ICP_MAX = 500;

const EXAMPLE_WORKFLOW = `{
  "name": "My table",
  "description": "Costs locked from Clay Usage history.",
  "steps": [
    {
      "id": "employee_count",
      "name": "Find company employee count",
      "type": "enrich",
      "field": "Companyempcount",
      "dependsOn": [],
      "actionCost": 1,
      "dataCreditCost": 2.0
    },
    {
      "id": "icp_filter",
      "name": "ICP Pass",
      "type": "filter",
      "field": "ICP Pass",
      "dependsOn": ["employee_count"],
      "actionCost": 0,
      "dataCreditCost": 0,
      "passColumn": "ICP Pass",
      "passValue": "true"
    }
  ]
}`;

function plainTitle(f: Finding): string {
  return PLAIN_TITLES[f.rule] ?? f.title;
}

function beforeAfterLine(f: Finding): string {
  if (f.rule === "R1") {
    return "Before: paid enrich → ICP filter · After: required enrich → ICP → other paid steps";
  }
  if (f.rule === "R4") {
    const cur = (f.details?.currentOrder as string[] | undefined)?.join(" → ");
    const rec = (f.details?.recommendedOrder as string[] | undefined)?.join(" → ");
    if (cur && rec) return `Before: ${cur} · After: ${rec}`;
  }
  if (f.rule === "R5") {
    return "Before: use_ai / claygent · After: AI Formula (free)";
  }
  if (f.rule === "R2") {
    return "Before: always runs · After: run only when contact exists";
  }
  if (f.rule === "R3") {
    return "Before: enrichment runs · After: remove unused step";
  }
  return f.summary;
}

function boldDollars(text: string) {
  const parts = text.split(/(\$\d+(?:\.\d+)?)/g);
  return parts.map((part, i) =>
    part.startsWith("$") ? (
      <strong key={i} className="font-semibold text-[var(--ink)]">
        {part}
      </strong>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

export default function HomePage() {
  const [csv, setCsv] = useState("");
  const [workflowText, setWorkflowText] = useState("");
  const [workflow, setWorkflow] = useState<WorkflowDefinition | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [explanation, setExplanation] = useState("");
  const [explainSource, setExplainSource] = useState<"llm" | "template" | "">("");
  const [error, setError] = useState("");
  const [showEngine, setShowEngine] = useState(false);
  const [showGptPanel, setShowGptPanel] = useState(false);
  const [showHow, setShowHow] = useState(false);
  const [reanalyzed, setReanalyzed] = useState(false);
  const [graphMode, setGraphMode] = useState<GraphMode>("before");
  const [highlightIds, setHighlightIds] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();

  const [icpGoal, setIcpGoal] = useState(DEFAULT_ICP_GOAL);
  const [workflowDescription, setWorkflowDescription] = useState(DEFAULT_WF_DESC);
  const [icpColumn, setIcpColumn] = useState(DEFAULT_ICP_COLUMN);
  const [icpMin, setIcpMin] = useState(DEFAULT_ICP_MIN);
  const [icpMax, setIcpMax] = useState(DEFAULT_ICP_MAX);
  const [actionUsd, setActionUsd] = useState(ACTION_USD);
  const [dataCreditUsd, setDataCreditUsd] = useState(DATA_CREDIT_USD);
  const [monthlyRuns, setMonthlyRuns] = useState(100);
  const [exportNote, setExportNote] = useState("");

  const sampleRef = useRef<{ csv: string; workflow: WorkflowDefinition } | null>(
    null
  );
  const assumptionsRef = useRef({
    icpGoal: DEFAULT_ICP_GOAL,
    workflowDescription: DEFAULT_WF_DESC,
    icpColumn: DEFAULT_ICP_COLUMN,
    icpMin: DEFAULT_ICP_MIN,
    icpMax: DEFAULT_ICP_MAX,
    actionUsd: ACTION_USD,
    dataCreditUsd: DATA_CREDIT_USD,
  });
  assumptionsRef.current = {
    icpGoal,
    workflowDescription,
    icpColumn,
    icpMin,
    icpMax,
    actionUsd,
    dataCreditUsd,
  };

  useEffect(() => {
    startTransition(async () => {
      try {
        const res = await fetch("/api/sample");
        const data = await res.json();
        sampleRef.current = { csv: data.csv, workflow: data.workflow };
        const wfText = JSON.stringify(data.workflow, null, 2);
        setCsv(data.csv);
        setWorkflowText(wfText);
        setWorkflow(data.workflow);
        const desc = String(data.workflow?.description ?? "")
          .replace(/Wasteful[^.]+\.\s*/i, "")
          .trim();
        if (desc) setWorkflowDescription(desc);
        await runAnalyze(data.csv, wfText, false, {
          icpGoal: DEFAULT_ICP_GOAL,
          workflowDescription: desc || DEFAULT_WF_DESC,
          icpColumn: DEFAULT_ICP_COLUMN,
          icpMin: DEFAULT_ICP_MIN,
          icpMax: DEFAULT_ICP_MAX,
          actionUsd: ACTION_USD,
          dataCreditUsd: DATA_CREDIT_USD,
        });
      } catch {
        setError("Failed to load sample fixtures");
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  type AnalyzeOverrides = {
    icpGoal?: string;
    workflowDescription?: string;
    icpColumn?: string;
    icpMin?: number;
    icpMax?: number;
    actionUsd?: number;
    dataCreditUsd?: number;
  };

  function analyzePayload(
    csvIn: string,
    wf: WorkflowDefinition,
    overrides?: AnalyzeOverrides
  ) {
    const a = { ...assumptionsRef.current, ...overrides };
    return {
      csv: csvIn,
      workflow: wf,
      icpRule: {
        column: a.icpColumn,
        min: a.icpMin,
        max: a.icpMax,
        preferPassColumn: "ICP Pass",
      },
      prices: { actionUsd: a.actionUsd, dataCreditUsd: a.dataCreditUsd },
      icpGoal: a.icpGoal,
      workflowDescription: a.workflowDescription,
    };
  }

  async function runAnalyze(
    csvIn: string,
    wfIn: string,
    showConfirm = true,
    overrides?: AnalyzeOverrides
  ) {
    setError("");
    setReanalyzed(false);
    setExportNote("");
    try {
      let wf: WorkflowDefinition;
      try {
        wf = JSON.parse(wfIn);
      } catch {
        setResult(null);
        setExplanation("");
        setWorkflow(null);
        setError(
          "That JSON doesn't look right. Paste a workflow with a name and steps array — here's an example below."
        );
        return;
      }

      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(analyzePayload(csvIn, wf, overrides)),
      });
      const data = await res.json();
      if (!res.ok) {
        setResult(null);
        setExplanation("");
        setWorkflow(null);
        throw new Error(
          typeof data.error === "string" &&
            /json|zod|parse|required|invalid/i.test(data.error)
            ? "That JSON doesn't look right. Paste a workflow with a name and steps array — here's an example below."
            : data.error || "Analyze failed"
        );
      }
      setWorkflow(wf);
      setResult(data.result);
      setHighlightIds([]);
      setGraphMode("before");
      const ex = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ result: data.result }),
      });
      const exData = await ex.json();
      setExplanation(exData.explanation ?? "");
      setExplainSource(exData.source ?? "template");
      if (showConfirm) {
        setReanalyzed(true);
        setTimeout(() => setReanalyzed(false), 2500);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analyze failed");
    }
  }

  /** Reload original sample fixtures + default assumptions (clean live demo). */
  async function runDemo() {
    setError("");
    try {
      let sample = sampleRef.current;
      if (!sample) {
        const res = await fetch("/api/sample");
        const data = await res.json();
        sample = { csv: data.csv, workflow: data.workflow };
        sampleRef.current = sample;
      }
      const wfText = JSON.stringify(sample.workflow, null, 2);
      const desc = String(sample.workflow?.description ?? "")
        .replace(/Wasteful[^.]+\.\s*/i, "")
        .trim();
      setCsv(sample.csv);
      setWorkflowText(wfText);
      setWorkflow(sample.workflow);
      setIcpGoal(DEFAULT_ICP_GOAL);
      setWorkflowDescription(desc || DEFAULT_WF_DESC);
      setIcpColumn(DEFAULT_ICP_COLUMN);
      setIcpMin(DEFAULT_ICP_MIN);
      setIcpMax(DEFAULT_ICP_MAX);
      setActionUsd(ACTION_USD);
      setDataCreditUsd(DATA_CREDIT_USD);
      setMonthlyRuns(100);
      setShowEngine(false);
      setShowGptPanel(false);
      await runAnalyze(sample.csv, wfText, true, {
        icpGoal: DEFAULT_ICP_GOAL,
        workflowDescription: desc || DEFAULT_WF_DESC,
        icpColumn: DEFAULT_ICP_COLUMN,
        icpMin: DEFAULT_ICP_MIN,
        icpMax: DEFAULT_ICP_MAX,
        actionUsd: ACTION_USD,
        dataCreditUsd: DATA_CREDIT_USD,
      });
    } catch {
      setError("Failed to reload demo sample");
    }
  }

  function onCsvFile(file: File | null) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result ?? ""));
    reader.readAsText(file);
  }

  function exportFixed() {
    if (!workflow || !result) {
      setExportNote("Nothing to export yet — run an analysis first.");
      return;
    }
    try {
      const fixed = buildFixedWorkflow(workflow, result);
      const text = JSON.stringify(fixed, null, 2);
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "workflow-fixed.json";
      a.rel = "noopener";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setExportNote("Download started: workflow-fixed.json");
      setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
      }, 2000);
    } catch (e) {
      setExportNote(
        e instanceof Error ? e.message : "Export failed — try another browser."
      );
    }
  }

  const m = result?.metrics;
  const a = result?.assumptions;
  const savePct =
    m && m.usdPerRun > 0 ? Math.round((m.wasteUsd / m.usdPerRun) * 100) : 0;
  const topFinding = result?.findings[0];
  const monthlyWaste = m ? m.wasteUsd * monthlyRuns : 0;

  return (
    <main className="mx-auto max-w-7xl px-4 pb-20 pt-8 sm:px-6">
      <header className="rise mb-8">
        <p className="brand text-4xl tracking-tight text-[var(--teal)] sm:text-5xl">
          Clay Workflow Health
        </p>
        <h1 className="mt-3 max-w-3xl text-2xl font-medium leading-snug text-[var(--ink)] sm:text-3xl">
          Find wasted Clay credits in your table and fix them in one click.
        </h1>
        {m ? (
          <div className="mt-5 grid gap-4 lg:grid-cols-[1.4fr_0.6fr]">
            <div>
              <p className="text-lg text-[var(--ink)] sm:text-xl">
                You&apos;re spending{" "}
                <strong className="text-[var(--ink)]">{fmtUsd(m.usdPerRun)}</strong> per
                run.{" "}
                <strong className="text-[var(--amber)]">{fmtUsd(m.wasteUsd)}</strong> of
                it is waste.
              </p>
              <p className="mt-2 text-[var(--muted)]">
                Clay estimates cost before a run. This finds waste after the workflow is
                built — paid steps before free filters, bad waterfall order, wrong AI
                tier. Data Credits are charged on hits only (Clay refunds misses); each
                waterfall attempt still costs Actions.
              </p>
              {topFinding && (
                <p className="mt-3 text-sm font-medium text-[var(--teal)]">
                  One-line fix: {plainTitle(topFinding)}.{" "}
                  <span className="font-normal text-[var(--muted)]">
                    {topFinding.rule === "R1"
                      ? "Move your ICP filter before paid enrichment it doesn't need."
                      : topFinding.summary}
                  </span>
                </p>
              )}
              {a && (
                <p className="mt-2 text-sm text-[var(--muted)]">
                  ICP pass rate{" "}
                  <strong className="text-[var(--ink)]">{fmtPct(a.icpPassRate)}</strong>{" "}
                  from {a.icpSource === "pass_column"
                    ? `column “${a.icpRule.preferPassColumn ?? "ICP Pass"}”`
                    : a.icpSource === "numeric_range"
                      ? `${a.icpRule.column} in [${a.icpRule.min}, ${a.icpRule.max}]`
                      : "fallback (no matching CSV column)"}
                  . At {monthlyRuns} runs/mo ≈{" "}
                  <strong className="text-[var(--ink)]">{fmtUsd(monthlyWaste)}/mo</strong>{" "}
                  waste.
                </p>
              )}
            </div>
            <div className="flex flex-col justify-center rounded-xl border border-[var(--teal)]/30 bg-[var(--teal-soft)]/60 px-5 py-4 text-center">
              <p className="text-xs uppercase tracking-wide text-[var(--teal)]">
                Save
              </p>
              <p className="brand text-5xl text-[var(--teal)]">{savePct}%</p>
              <p className="mt-1 text-sm text-[var(--muted)]">
                of per-run spend on this analysis
              </p>
            </div>
          </div>
        ) : (
          <p className="mt-3 max-w-2xl text-[var(--muted)]">
            Clay estimates cost before a run. This finds waste after the workflow is built
            — paid steps before free filters, bad waterfall order, wrong AI tier.
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            className="rounded-md bg-[var(--teal)] px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-60"
            disabled={pending}
            onClick={() => startTransition(() => runDemo())}
          >
            {pending ? "Analyzing…" : "Run demo"}
          </button>
          <button
            type="button"
            className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-4 py-2 text-sm font-medium"
            aria-expanded={showGptPanel}
            onClick={() => setShowGptPanel((v) => !v)}
          >
            Why not GPT?
          </button>
          <button
            type="button"
            className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-4 py-2 text-sm font-medium"
            aria-expanded={showEngine}
            disabled={!result}
            onClick={() => {
              setShowEngine((v) => !v);
              queueMicrotask(() => {
                document.getElementById("engine-json")?.scrollIntoView({
                  behavior: "smooth",
                  block: "start",
                });
              });
            }}
          >
            {showEngine ? "Hide engine JSON" : "Show engine JSON"}
          </button>
          {result && (
            <button
              type="button"
              className="rounded-md border border-[var(--teal)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold text-[var(--teal)]"
              onClick={exportFixed}
            >
              Export fixed workflow
            </button>
          )}
        </div>

        {showGptPanel && (
          <div className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
            <p className="text-sm leading-relaxed text-[var(--ink)]">
              Cost math must be exact and repeatable. A deterministic engine computes
              Actions, Data Credits, and savings. AI only writes the explanation. Use
              <strong className="text-[var(--ink)]"> Show engine JSON</strong> for the
              proof.
            </p>
          </div>
        )}

        {exportNote && (
          <p className="mt-3 text-sm font-medium text-[var(--teal)]" role="status">
            {exportNote}
          </p>
        )}

        {reanalyzed && (
          <p className="mt-3 text-sm font-medium text-[var(--teal)]" role="status">
            Re-analyzed
          </p>
        )}
      </header>

      <div className="mb-6 rounded-xl border border-[var(--amber)]/40 bg-[var(--amber-soft)]/50 p-4 text-sm text-[var(--ink)]">
        <p className="font-semibold">V1 limitations (call these out first)</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[var(--muted)]">
          <li>
            Without a provider-win column, per-provider rates are estimates scaled to email
            fill (overall find rate matches the CSV). Reordering can still change which
            provider&apos;s data you keep — hard emails stay hard.
          </li>
          <li>
            Providers overlap in practice; overlap isn&apos;t visible in a CSV export, so
            reorder savings are estimates.
          </li>
          <li>
            $/Action and $/Data Credit are editable inputs (plan-dependent). Step unit
            costs still come from workflow JSON (Usage history).
          </li>
          <li>
            Data Credits: charged on hits only (refunds on empty lookups). Actions: still
            charged per attempt that runs.
          </li>
        </ul>
      </div>

      {error && (
        <div className="mb-6 rounded-xl border border-[var(--danger)]/30 bg-rose-50 p-4 text-sm text-[var(--danger)]">
          <p>{error}</p>
          {/doesn't look right|JSON/i.test(error) && (
            <pre className="mt-3 max-h-48 overflow-auto rounded-md bg-white/80 p-3 font-mono text-xs text-[var(--ink)]">
              {EXAMPLE_WORKFLOW}
            </pre>
          )}
        </div>
      )}

      {m && result && (
        <>
          <section
            className="rise grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
            style={{ animationDelay: "80ms" }}
          >
            <Metric
              label="Cost per run"
              value={fmtUsd(m.usdPerRun)}
              hint="Actions + Data Credits in dollars"
              fill={1}
            />
            <Metric
              label="Waste"
              value={fmtUsd(m.wasteUsd)}
              hint={`${fmtNum(m.wasteActions)}A / ${fmtNum(m.wasteDataCredits)}DC on rows you'd throw away`}
              fill={m.usdPerRun > 0 ? Math.min(1, m.wasteUsd / m.usdPerRun) : 0}
              accent="amber"
            />
            <Metric
              label="Health score"
              value={`${m.overallScore}`}
              hint="V1 defaults: waste 55 · ICP efficiency 25 · data confidence 20 — tune with real customer data"
              fill={m.overallScore / 100}
              accent="teal"
            />
            <Metric
              label="ICP efficiency"
              value={fmtPct(m.icpEfficiencyDataCredits)}
              hint="% of Data Credits spent on rows that pass ICP"
              fill={m.icpEfficiencyDataCredits}
            />
            <Metric
              label="Data confidence"
              value={fmtPct(m.dataConfidence)}
              hint="Fill rate on key fields (email, emp count, name, domain)"
              fill={m.dataConfidence}
            />
          </section>

          <p className="mt-3 text-xs text-[var(--muted)]">
            Blank ≠ paid failure. Skipped vs refunded cannot be told from CSV alone —
            blanks are reported as ambiguous. Health score weights (55 / 25 / 20) are V1
            defaults I&apos;d tune with real customer data.
          </p>

          {a?.hitRateSource && (
            <p className="mt-2 text-xs text-[var(--muted)]">
              <strong className="text-[var(--ink)]">Provider hit rates:</strong>{" "}
              {a.hitRateSource === "provider_win_column"
                ? "from the CSV provider-win column (observed)."
                : a.hitRateSource === "fill_scaled_estimates"
                  ? `estimates — no provider-win column, so declared JSON shares were scaled to the ${(
                      (a.emailFillRate ?? 0) * 100
                    ).toFixed(0)}% email fill rate (modeled find ${(
                      (a.modeledFindRate ?? 0) * 100
                    ).toFixed(0)}%).`
                  : "from declared JSON rates (no CSV fill signal)."}
              {a.providerHitRates && (
                <>
                  {" "}
                  Conditional rates:{" "}
                  {Object.entries(a.providerHitRates)
                    .map(([id, r]) => `${id} ${(r * 100).toFixed(1)}%`)
                    .join(" · ")}
                  .
                </>
              )}
            </p>
          )}

          <section
            className="rise mt-8 grid gap-6 lg:grid-cols-[1.05fr_0.95fr]"
            style={{ animationDelay: "140ms" }}
          >
            <div>
              <h2 className="text-xl">Recommendations</h2>
              <ul className="mt-3 space-y-3">
                {result.findings.map((f, i) => (
                  <li
                    key={`${f.rule}-${f.title}-${i}`}
                    className={`rounded-xl border bg-[var(--panel)] p-4 transition ${
                      highlightIds.length &&
                      f.stepIds.some((id) => highlightIds.includes(id))
                        ? "border-[var(--teal)] shadow-[0_0_0_1px_var(--teal)]"
                        : "border-[var(--line)]"
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="font-semibold">
                        <span className="text-[var(--amber)]">{i + 1}.</span>{" "}
                        {plainTitle(f)}
                      </p>
                      <p className="shrink-0 text-sm font-semibold text-[var(--teal)]">
                        Save {fmtUsd(f.savingsUsd)}
                      </p>
                    </div>
                    <p className="mt-2 text-sm text-[var(--muted)]">
                      {beforeAfterLine(f)}
                    </p>
                    <p className="mt-1 text-sm text-[var(--muted)]">{f.summary}</p>
                    <button
                      type="button"
                      className="mt-3 rounded-md border border-[var(--line)] px-3 py-1.5 text-sm font-medium hover:border-[var(--teal)] hover:text-[var(--teal)]"
                      onClick={() => {
                        setHighlightIds(f.stepIds);
                        setGraphMode("after");
                      }}
                    >
                      Show me
                    </button>
                  </li>
                ))}
              </ul>

              <div className="mt-6 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
                <h3 className="font-semibold">
                  Explainer{" "}
                  <span className="text-xs font-normal text-[var(--muted)]">
                    ({explainSource || "template"})
                  </span>
                </h3>
                <div className="mt-2 space-y-2 text-sm leading-relaxed text-[var(--muted)]">
                  {explanation.split("\n").filter(Boolean).map((line, i) => (
                    <p key={i}>{boldDollars(line)}</p>
                  ))}
                </div>
              </div>
            </div>

            <div>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="text-xl">Workflow</h2>
                  <p className="mt-1 text-sm text-[var(--muted)]">
                    Click a node for details. Toggle current vs suggested order —
                    filters never jump before enrichments they need.
                  </p>
                </div>
                <div className="flex rounded-md border border-[var(--line)] bg-white p-0.5 text-sm shadow-sm">
                  <button
                    type="button"
                    className={`rounded px-3 py-1.5 transition ${
                      graphMode === "before"
                        ? "bg-[var(--teal)] font-semibold text-white"
                        : "text-[var(--muted)] hover:text-[var(--ink)]"
                    }`}
                    onClick={() => setGraphMode("before")}
                  >
                    Current
                  </button>
                  <button
                    type="button"
                    className={`rounded px-3 py-1.5 transition ${
                      graphMode === "after"
                        ? "bg-[var(--teal)] font-semibold text-white"
                        : "text-[var(--muted)] hover:text-[var(--ink)]"
                    }`}
                    onClick={() => setGraphMode("after")}
                  >
                    Suggested
                  </button>
                </div>
                {graphMode === "after" && (
                  <p className="w-full text-xs font-medium text-[var(--teal)]">
                    Showing suggested order
                    {highlightIds.length
                      ? ` · highlighting ${highlightIds.length} step${highlightIds.length === 1 ? "" : "s"}`
                      : ""}
                  </p>
                )}
              </div>
              {workflow && (
                <div className="mt-3">
                  <WorkflowGraph
                    workflow={workflow}
                    result={result}
                    mode={graphMode}
                    highlightedStepIds={highlightIds}
                    onSelectSteps={setHighlightIds}
                  />
                </div>
              )}
            </div>
          </section>
        </>
      )}

      <details className="rise mt-10 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4" open>
        <summary className="cursor-pointer text-sm font-semibold">
          Use your own data & assumptions
        </summary>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Upload a Clay CSV — ICP pass rate and email hit rates are computed from the
          file (not locked demo JSON). Step unit costs still come from workflow JSON
          (Usage history). PreferPassColumn “ICP Pass” is used when present; otherwise
          the numeric ICP rule below.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-semibold">ICP goal</span>
            <input
              className="mt-1 w-full rounded-md border border-[var(--line)] bg-white/70 px-2 py-1.5"
              value={icpGoal}
              onChange={(e) => setIcpGoal(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="font-semibold">Workflow description</span>
            <input
              className="mt-1 w-full rounded-md border border-[var(--line)] bg-white/70 px-2 py-1.5"
              value={workflowDescription}
              onChange={(e) => setWorkflowDescription(e.target.value)}
            />
          </label>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="block text-sm">
            <span className="font-semibold">ICP column</span>
            <input
              className="mt-1 w-full rounded-md border border-[var(--line)] bg-white/70 px-2 py-1.5 font-mono text-xs"
              value={icpColumn}
              onChange={(e) => setIcpColumn(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="font-semibold">Min employees</span>
            <input
              type="number"
              className="mt-1 w-full rounded-md border border-[var(--line)] bg-white/70 px-2 py-1.5"
              value={icpMin}
              onChange={(e) => setIcpMin(Number(e.target.value))}
            />
          </label>
          <label className="block text-sm">
            <span className="font-semibold">Max employees</span>
            <input
              type="number"
              className="mt-1 w-full rounded-md border border-[var(--line)] bg-white/70 px-2 py-1.5"
              value={icpMax}
              onChange={(e) => setIcpMax(Number(e.target.value))}
            />
          </label>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="block text-sm">
            <span className="font-semibold">$ / Action</span>
            <input
              type="number"
              step="0.0001"
              className="mt-1 w-full rounded-md border border-[var(--line)] bg-white/70 px-2 py-1.5"
              value={actionUsd}
              onChange={(e) => setActionUsd(Number(e.target.value))}
            />
          </label>
          <label className="block text-sm">
            <span className="font-semibold">$ / Data Credit</span>
            <input
              type="number"
              step="0.001"
              className="mt-1 w-full rounded-md border border-[var(--line)] bg-white/70 px-2 py-1.5"
              value={dataCreditUsd}
              onChange={(e) => setDataCreditUsd(Number(e.target.value))}
            />
          </label>
          <label className="block text-sm">
            <span className="font-semibold">Runs / month</span>
            <input
              type="number"
              className="mt-1 w-full rounded-md border border-[var(--line)] bg-white/70 px-2 py-1.5"
              value={monthlyRuns}
              onChange={(e) => setMonthlyRuns(Number(e.target.value))}
            />
          </label>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="block">
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
              spellCheck={false}
            />
          </label>
          <label className="block">
            <span className="text-sm font-semibold">Workflow JSON</span>
            <textarea
              className="mt-2 h-[11.5rem] w-full rounded-md border border-[var(--line)] bg-white/70 p-2 font-mono text-xs sm:mt-[2.125rem] sm:h-40"
              value={workflowText}
              onChange={(e) => setWorkflowText(e.target.value)}
              spellCheck={false}
            />
          </label>
        </div>
        <button
          type="button"
          className="mt-4 rounded-md bg-[var(--teal)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          disabled={pending}
          onClick={() =>
            startTransition(() => runAnalyze(csv, workflowText, true))
          }
        >
          {pending ? "Analyzing…" : "Analyze with my data"}
        </button>
        <p className="mt-2 text-xs text-[var(--muted)]">
          Uses the CSV and workflow JSON in the boxes above (not the sample), plus the
          ICP rule and price inputs.
        </p>
      </details>

      <section className="mt-10 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-5">
        <button
          type="button"
          className="flex w-full items-center justify-between text-left"
          onClick={() => setShowHow((v) => !v)}
          aria-expanded={showHow}
        >
          <h2 className="text-lg font-semibold">How it works</h2>
          <span className="text-sm text-[var(--muted)]">{showHow ? "Hide" : "Show"}</span>
        </button>
        {showHow && (
          <div className="mt-4 space-y-4 text-sm leading-relaxed text-[var(--muted)]">
            <p>
              <strong className="text-[var(--ink)]">Stack:</strong> Next.js + React Flow.
              Deterministic engine for meters; AI only narrates. Predicate pushdown moves
              free filters as early as their dependencies allow.
            </p>
            <dl className="space-y-3">
              <div>
                <dt className="font-semibold text-[var(--ink)]">Do you charge for misses?</dt>
                <dd>
                  No on Data Credits — Clay refunds empty lookups, so E[DC] only counts
                  provider hits. Yes on Actions — each attempt that runs still costs an
                  Action.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-[var(--ink)]">Where do rates come from?</dt>
                <dd>
                  Provider-win columns and email fill from your CSV; ICP from “ICP Pass”
                  or your numeric rule. Unit costs stay in workflow JSON.
                </dd>
              </div>
            </dl>
          </div>
        )}
      </section>

      {showEngine && result && (
        <section
          id="engine-json"
          className="rise mt-8 rounded-xl border border-[var(--line)] bg-[#1c1917] p-4 text-[#f5f5f4]"
        >
          <h2 className="text-lg text-[#ccfbf1]">Engine JSON</h2>
          <p className="mt-1 text-sm text-[#a8a29e]">
            The model only narrates these fields — it does not invent savings.
          </p>
          <pre className="mt-3 max-h-96 overflow-auto text-xs leading-relaxed">
            {JSON.stringify(
              {
                assumptions: result.assumptions,
                metrics: result.metrics,
                findings: result.findings,
                simulationSteps: result.simulation.steps,
                suggestedStepOrder: result.suggestedStepOrder,
              },
              null,
              2
            )}
          </pre>
        </section>
      )}

      <footer className="mt-14 border-t border-[var(--line)] pt-6 text-sm text-[var(--muted)]">
        <p>
          Built by{" "}
          <a
            className="font-medium text-[var(--teal)] underline-offset-2 hover:underline"
            href="https://github.com/AchsahJojo"
            target="_blank"
            rel="noreferrer"
          >
            Achsah Jojo
          </a>
          {" · "}
          <a
            className="underline-offset-2 hover:underline"
            href="https://github.com/AchsahJojo/ClayDemo"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
        </p>
      </footer>
    </main>
  );
}

function Metric({
  label,
  value,
  hint,
  fill,
  accent,
}: {
  label: string;
  value: string;
  hint: string;
  fill: number;
  accent?: "teal" | "amber";
}) {
  const width = `${Math.max(0, Math.min(100, Math.round(fill * 100)))}%`;
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
      <p className="text-[11px] uppercase tracking-wide text-[var(--muted)]">{label}</p>
      <p
        className={`mt-1 text-2xl font-semibold ${
          accent === "teal"
            ? "text-[var(--teal)]"
            : accent === "amber"
              ? "text-[var(--amber)]"
              : ""
        }`}
      >
        {value}
      </p>
      <div className="meter-bar mt-3 h-1.5 overflow-hidden rounded bg-[var(--line)]">
        <span
          className={`block h-full ${
            accent === "amber" ? "bg-[var(--amber)]" : "bg-[var(--teal)]"
          }`}
          style={{ width }}
        />
      </div>
      <p className="mt-2 text-xs text-[var(--muted)]">{hint}</p>
    </div>
  );
}
