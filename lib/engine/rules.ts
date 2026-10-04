import { usdFromMeters } from "@/lib/costs";
import { dependentsMap } from "./dag";
import { simulate, expectedWaterfallDataCredits, resolveProviderHitRates } from "./simulate";
import type {
  AnalysisResult,
  CsvProfile,
  CsvRow,
  Finding,
  HealthMetrics,
  WorkflowDefinition,
  WorkflowStep,
} from "./types";

function findIcpFilter(workflow: WorkflowDefinition): WorkflowStep | undefined {
  return workflow.steps.find(
    (s) =>
      s.type === "filter" &&
      (s.passColumn === "ICP Pass" || /icp/i.test(s.name) || /icp/i.test(s.id))
  );
}

function paidStepsBeforeFilter(
  workflow: WorkflowDefinition,
  filterId: string
): WorkflowStep[] {
  const filterIdx = workflow.steps.findIndex((s) => s.id === filterId);
  if (filterIdx < 0) return [];
  return workflow.steps
    .slice(0, filterIdx)
    .filter(
      (s) =>
        s.type !== "filter" &&
        s.type !== "ai_formula" &&
        (s.actionCost > 0 || s.dataCreditCost > 0 || s.type === "waterfall")
    );
}

export function applyRules(
  workflow: WorkflowDefinition,
  rows: CsvRow[],
  profile: CsvProfile,
  baseline: ReturnType<typeof simulate>
): { findings: Finding[]; suggestedStepOrder: string[]; suggestedWaterfallOrders: Record<string, string[]> } {
  const findings: Finding[] = [];
  const suggestedWaterfallOrders: Record<string, string[]> = {};
  let suggestedStepOrder = workflow.steps.map((s) => s.id);

  const icp = findIcpFilter(workflow);
  const failFrac =
    icp && profile.rowCount > 0
      ? 1 - baseline.icpPassingRows / profile.rowCount
      : 0;

  // --- R1 Filter / condition too late ---
  if (icp) {
    const earlyPaid = paidStepsBeforeFilter(workflow, icp.id);
    if (earlyPaid.length && failFrac > 0) {
      const after = simulate(workflow, rows, profile, { filtersFirst: true });
      const savingsActions = Math.max(0, baseline.actionsUsed - after.actionsUsed);
      const savingsDc = Math.max(
        0,
        baseline.dataCreditsUsed - after.dataCreditsUsed
      );
      if (savingsActions > 0.01 || savingsDc > 0.01) {
        findings.push({
          rule: "R1",
          title: "Filter / ICP condition too late",
          summary: `Paid steps run before free ICP filter. Moving ICP earlier avoids charging ~${(failFrac * 100).toFixed(0)}% of rows that fail ICP.`,
          stepIds: earlyPaid.map((s) => s.id),
          wasteActions: savingsActions,
          wasteDataCredits: savingsDc,
          wasteUsd: usdFromMeters(savingsActions, savingsDc),
          savingsActions,
          savingsDataCredits: savingsDc,
          savingsUsd: usdFromMeters(savingsActions, savingsDc),
          details: {
            failFraction: failFrac,
            beforeActions: baseline.actionsUsed,
            afterActions: after.actionsUsed,
            beforeDataCredits: baseline.dataCreditsUsed,
            afterDataCredits: after.dataCreditsUsed,
          },
        });
        const filters = workflow.steps.filter((s) => s.type === "filter").map((s) => s.id);
        const rest = workflow.steps.filter((s) => s.type !== "filter").map((s) => s.id);
        suggestedStepOrder = [...filters, ...rest];
      }
    }
  }

  // --- R2 Already-has-data / missing conditional ---
  for (const step of workflow.steps) {
    if (!["enrich", "waterfall", "use_ai", "claygent"].includes(step.type)) continue;
    if (step.runCondition) continue;
    // Heuristic: work email-like lookups should gate on blank target or prior blank
    const looksLikeEmail =
      /email/i.test(step.field) || /email/i.test(step.name);
    if (!looksLikeEmail) continue;
    const fill = profile.columns.find((c) => c.name === step.field)?.fillRate ?? 0;
    if (fill <= 0.05) continue;

    // Recommend: only run email find when contacts exist
    const betterGated: WorkflowDefinition = {
      ...workflow,
      steps: workflow.steps.map((s) => {
        if (s.id !== step.id) return s;
        if (s.id === "validate_email") return s; // already gated
        return {
          ...s,
          runCondition: {
            field: "Name People",
            op: "not_blank" as const,
          },
        };
      }),
    };
    const after = simulate(betterGated, rows, profile);
    const savingsActions = Math.max(0, baseline.actionsUsed - after.actionsUsed);
    const savingsDc = Math.max(0, baseline.dataCreditsUsed - after.dataCreditsUsed);
    if (savingsActions > 0.01 || savingsDc > 0.01) {
      findings.push({
        rule: "R2",
        title: "Missing run condition on paid lookup",
        summary: `“${step.name}” should use a run condition (e.g. only if prior contact exists / prior email blank) so conditioned-out rows stay blank at $0.`,
        stepIds: [step.id],
        wasteActions: savingsActions,
        wasteDataCredits: savingsDc,
        wasteUsd: usdFromMeters(savingsActions, savingsDc),
        savingsActions,
        savingsDataCredits: savingsDc,
        savingsUsd: usdFromMeters(savingsActions, savingsDc),
      });
    }
  }

  // --- R3 Unused enrich ---
  const deps = dependentsMap(workflow);
  const finalIds = new Set(
    workflow.steps.filter((s) => s.isFinalOutput || s.type === "export").map((s) => s.id)
  );
  for (const step of workflow.steps) {
    if (!["enrich", "waterfall", "use_ai", "claygent"].includes(step.type)) continue;
    const downstream = deps.get(step.id) ?? new Set();
    const reachesFinal =
      finalIds.has(step.id) || [...downstream].some((d) => finalIds.has(d));
    // Also consider depended on by any later non-filter step
    const used = downstream.size > 0 || reachesFinal;
    if (used) continue;
    const simStep = baseline.steps.find((s) => s.stepId === step.id);
    const wasteA = simStep?.actionsUsed ?? 0;
    const wasteD = simStep?.dataCreditsUsed ?? 0;
    if (wasteA < 0.01 && wasteD < 0.01) continue;
    findings.push({
      rule: "R3",
      title: "Unused enrichment",
      summary: `“${step.name}” is never depended on by later steps or export — full step cost is waste.`,
      stepIds: [step.id],
      wasteActions: wasteA,
      wasteDataCredits: wasteD,
      wasteUsd: usdFromMeters(wasteA, wasteD),
      savingsActions: wasteA,
      savingsDataCredits: wasteD,
      savingsUsd: usdFromMeters(wasteA, wasteD),
    });
  }

  // --- R4 Waterfall reorder ---
  for (const step of workflow.steps) {
    if (step.type !== "waterfall" || !step.providers?.length) continue;
    const rates = resolveProviderHitRates(step, profile);
    const currentE = expectedWaterfallDataCredits(step.providers, rates);
    const scored = step.providers.map((p, i) => ({
      p,
      rate: rates[i] ?? p.hitRate ?? 0,
      score: (rates[i] ?? p.hitRate ?? 0) / Math.max(p.dataCreditCost, 1e-9),
    }));
    scored.sort((a, b) => b.score - a.score);
    const newOrder = scored.map((s) => s.p);
    const newRates = scored.map((s) => s.rate);
    const newE = expectedWaterfallDataCredits(newOrder, newRates);
    const orderChanged = newOrder.map((p) => p.id).join() !== step.providers.map((p) => p.id).join();
    if (!orderChanged || newE >= currentE - 1e-6) continue;

    const simStep = baseline.steps.find((s) => s.stepId === step.id);
    const rowsCharged = simStep?.rowsCharged ?? profile.rowCount;
    const savingsDc = (currentE - newE) * rowsCharged;
    suggestedWaterfallOrders[step.id] = newOrder.map((p) => p.id);
    findings.push({
      rule: "R4",
      title: "Reorder waterfall providers",
      summary: `Personalize provider order by hit rate per Data Credit. E[cost]/row drops from ${currentE.toFixed(3)} to ${newE.toFixed(3)} DC.`,
      stepIds: [step.id],
      wasteActions: 0,
      wasteDataCredits: savingsDc,
      wasteUsd: usdFromMeters(0, savingsDc),
      savingsActions: 0,
      savingsDataCredits: savingsDc,
      savingsUsd: usdFromMeters(0, savingsDc),
      details: {
        currentOrder: step.providers.map((p) => p.id),
        recommendedOrder: newOrder.map((p) => p.id),
        currentExpectedPerRow: currentE,
        recommendedExpectedPerRow: newE,
        scores: scored.map((s) => ({
          id: s.p.id,
          hitRate: s.rate,
          dataCreditCost: s.p.dataCreditCost,
          hitPerCredit: s.score,
        })),
      },
    });
  }

  // --- R5 Wrong AI tier ---
  for (const step of workflow.steps) {
    if (step.type !== "use_ai" && step.type !== "claygent") continue;
    const deterministic =
      step.taskClass === "deterministic" ||
      /title-?case|normalize|trim|concat|extract|cleanup|band|range/i.test(
        `${step.name} ${step.purpose ?? ""}`
      );
    if (!deterministic) continue;
    const simStep = baseline.steps.find((s) => s.stepId === step.id);
    const wasteA = simStep?.actionsUsed ?? 0;
    const wasteD = simStep?.dataCreditsUsed ?? 0;
    if (wasteA < 0.01 && wasteD < 0.01) continue;
    findings.push({
      rule: "R5",
      title: "Wrong AI tier — use AI Formula",
      summary: `“${step.name}” looks like a deterministic transform. Downgrade ${step.type} → ai_formula (free) per Clay’s credit ladder.`,
      stepIds: [step.id],
      wasteActions: wasteA,
      wasteDataCredits: wasteD,
      wasteUsd: usdFromMeters(wasteA, wasteD),
      savingsActions: wasteA,
      savingsDataCredits: wasteD,
      savingsUsd: usdFromMeters(wasteA, wasteD),
    });
  }

  // Deduplicate waste R1 > R2 > R3 for overlapping step credits
  const priority: Record<string, number> = { R1: 1, R2: 2, R3: 3 };
  const claimed = new Set<string>();
  const deduped: Finding[] = [];
  const core = findings
    .filter((f) => f.rule === "R1" || f.rule === "R2" || f.rule === "R3")
    .sort((a, b) => priority[a.rule] - priority[b.rule]);
  for (const f of core) {
    const free = f.stepIds.filter((id) => !claimed.has(id));
    if (!free.length && f.rule !== "R1") continue;
    for (const id of f.stepIds) claimed.add(id);
    deduped.push(f);
  }
  for (const f of findings.filter((x) => x.rule === "R4" || x.rule === "R5")) {
    deduped.push(f);
  }

  return { findings: deduped, suggestedStepOrder, suggestedWaterfallOrders };
}

export function computeMetrics(
  simulation: ReturnType<typeof simulate>,
  findings: Finding[],
  profile: CsvProfile,
  keyFields: string[]
): HealthMetrics {
  const coreWaste = findings.filter((f) => f.rule === "R1" || f.rule === "R2" || f.rule === "R3");
  const wasteActions = coreWaste.reduce((s, f) => s + f.wasteActions, 0);
  const wasteDataCredits = coreWaste.reduce((s, f) => s + f.wasteDataCredits, 0);

  const icpEffA =
    simulation.actionsUsed > 0
      ? simulation.actionsOnIcpRows / simulation.actionsUsed
      : 1;
  const icpEffD =
    simulation.dataCreditsUsed > 0
      ? simulation.dataCreditsOnIcpRows / simulation.dataCreditsUsed
      : 1;

  let filled = 0;
  let total = 0;
  for (const name of keyFields) {
    const col = profile.columns.find((c) => c.name === name);
    if (!col) continue;
    filled += col.filled;
    total += col.filled + col.blank;
  }
  const dataConfidence = total > 0 ? filled / total : 0;

  const r4 = findings.find((f) => f.rule === "R4");
  let waterfallEfficiency: number | undefined;
  if (r4?.details) {
    const cur = r4.details.currentExpectedPerRow as number;
    const rec = r4.details.recommendedExpectedPerRow as number;
    if (cur > 0) waterfallEfficiency = rec / cur;
  }

  const wasteRatio =
    simulation.actionsUsed + simulation.dataCreditsUsed > 0
      ? (wasteActions + wasteDataCredits) /
        (simulation.actionsUsed + simulation.dataCreditsUsed)
      : 0;
  const overallScore = Math.max(
    0,
    Math.min(100, Math.round((1 - wasteRatio) * 55 + icpEffD * 25 + dataConfidence * 20))
  );

  return {
    actionsUsed: simulation.actionsUsed,
    dataCreditsUsed: simulation.dataCreditsUsed,
    usdPerRun: simulation.usd,
    wasteActions,
    wasteDataCredits,
    wasteUsd: usdFromMeters(wasteActions, wasteDataCredits),
    icpEfficiencyActions: icpEffA,
    icpEfficiencyDataCredits: icpEffD,
    dataConfidence,
    waterfallEfficiency,
    overallScore,
  };
}

export function analyze(
  workflow: WorkflowDefinition,
  rows: CsvRow[],
  profile: CsvProfile
): AnalysisResult {
  const simulation = simulate(workflow, rows, profile);
  const { findings, suggestedStepOrder, suggestedWaterfallOrders } = applyRules(
    workflow,
    rows,
    profile,
    simulation
  );
  const keyFields = [
    "Work Email",
    "Companyempcount",
    "Name People",
    "Company Domain",
  ];
  const metrics = computeMetrics(simulation, findings, profile, keyFields);
  return {
    profile,
    simulation,
    metrics,
    findings,
    suggestedStepOrder,
    suggestedWaterfallOrders,
  };
}
