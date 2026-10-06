import { DEFAULT_PRICES, usdFromMeters, type PriceAssumptions } from "@/lib/costs";
import { ancestorIds, buildFilterPushdownOrder, dependentsMap } from "./dag";
import { resolveIcpPassRate } from "./profile";
import {
  DEFAULT_ICP_RULE,
  expectedWaterfallDataCredits,
  resolveProviderHitRates,
  simulate,
  type SimulateOptions,
} from "./simulate";
import type {
  AnalysisResult,
  AnalyzeOptions,
  CsvProfile,
  CsvRow,
  Finding,
  HealthMetrics,
  IcpRule,
  RuleId,
  WorkflowDefinition,
  WorkflowStep,
} from "./types";

export const PLAIN_TITLES: Record<RuleId, string> = {
  R1: "Filter earlier",
  R2: "Add a run condition",
  R3: "Drop unused enrichment",
  R4: "Reorder email waterfall",
  R5: "Use AI Formula",
};

function findIcpFilter(workflow: WorkflowDefinition): WorkflowStep | undefined {
  return workflow.steps.find(
    (s) =>
      s.type === "filter" &&
      (s.passColumn === "ICP Pass" || /icp/i.test(s.name) || /icp/i.test(s.id))
  );
}

function isPaidStep(s: WorkflowStep): boolean {
  return (
    s.type !== "filter" &&
    s.type !== "ai_formula" &&
    (s.actionCost > 0 || s.dataCreditCost > 0 || s.type === "waterfall")
  );
}

/** Paid steps that currently run before the filter and are not required by it. */
function movablePaidBeforeFilter(
  workflow: WorkflowDefinition,
  filterId: string
): WorkflowStep[] {
  const filterIdx = workflow.steps.findIndex((s) => s.id === filterId);
  if (filterIdx < 0) return [];
  const required = ancestorIds(workflow, filterId);
  return workflow.steps
    .slice(0, filterIdx)
    .filter((s) => isPaidStep(s) && !required.has(s.id));
}


type RuleContext = {
  prices: PriceAssumptions;
  icpRule: IcpRule;
  simOpts: SimulateOptions;
};

export function applyRules(
  workflow: WorkflowDefinition,
  rows: CsvRow[],
  profile: CsvProfile,
  baseline: ReturnType<typeof simulate>,
  ctx: RuleContext
): { findings: Finding[]; suggestedStepOrder: string[]; suggestedWaterfallOrders: Record<string, string[]> } {
  const { prices, simOpts } = ctx;
  const usd = (a: number, d: number) => usdFromMeters(a, d, prices);
  const findings: Finding[] = [];
  const suggestedWaterfallOrders: Record<string, string[]> = {};
  let suggestedStepOrder = workflow.steps.map((s) => s.id);

  const icp = findIcpFilter(workflow);
  const failFrac =
    icp && profile.rowCount > 0
      ? 1 - baseline.icpPassingRows / profile.rowCount
      : 0;

  if (icp) {
    const movable = movablePaidBeforeFilter(workflow, icp.id);
    if (movable.length && failFrac > 0) {
      const pushdownOrder = buildFilterPushdownOrder(workflow, icp.id);
      const after = simulate(workflow, rows, profile, {
        ...simOpts,
        stepOrder: pushdownOrder,
      });
      const savingsActions = Math.max(0, baseline.actionsUsed - after.actionsUsed);
      const savingsDc = Math.max(
        0,
        baseline.dataCreditsUsed - after.dataCreditsUsed
      );
      if (savingsActions > 0.01 || savingsDc > 0.01) {
        findings.push({
          rule: "R1",
          title: PLAIN_TITLES.R1,
          summary: `Paid steps run before your free ICP filter. Move the filter earlier (after enrichments it needs) to avoid charging ~${(failFrac * 100).toFixed(0)}% of rows that fail ICP.`,
          stepIds: movable.map((s) => s.id),
          wasteActions: savingsActions,
          wasteDataCredits: savingsDc,
          wasteUsd: usd(savingsActions, savingsDc),
          savingsActions,
          savingsDataCredits: savingsDc,
          savingsUsd: usd(savingsActions, savingsDc),
          details: {
            failFraction: failFrac,
            beforeActions: baseline.actionsUsed,
            afterActions: after.actionsUsed,
            beforeDataCredits: baseline.dataCreditsUsed,
            afterDataCredits: after.dataCreditsUsed,
            suggestedOrder: pushdownOrder,
            keptBeforeFilter: [...ancestorIds(workflow, icp.id)],
          },
        });
        suggestedStepOrder = pushdownOrder;
      }
    }
  }

  for (const step of workflow.steps) {
    if (!["enrich", "waterfall", "use_ai", "claygent"].includes(step.type)) continue;
    if (step.runCondition) continue;
    const looksLikeEmail =
      /email/i.test(step.field) || /email/i.test(step.name);
    if (!looksLikeEmail) continue;
    const fill = profile.columns.find((c) => c.name === step.field)?.fillRate ?? 0;
    if (fill <= 0.05) continue;

    const suggestedCondition = {
      field: "Name People",
      op: "not_blank" as const,
    };
    const betterGated: WorkflowDefinition = {
      ...workflow,
      steps: workflow.steps.map((s) => {
        if (s.id !== step.id) return s;
        if (s.id === "validate_email") return s;
        return { ...s, runCondition: suggestedCondition };
      }),
    };
    const after = simulate(betterGated, rows, profile, simOpts);
    const savingsActions = Math.max(0, baseline.actionsUsed - after.actionsUsed);
    const savingsDc = Math.max(0, baseline.dataCreditsUsed - after.dataCreditsUsed);
    if (savingsActions > 0.01 || savingsDc > 0.01) {
      findings.push({
        rule: "R2",
        title: PLAIN_TITLES.R2,
        summary: `"${step.name}" should only run when a contact exists, so skipped rows stay blank at $0.`,
        stepIds: [step.id],
        wasteActions: savingsActions,
        wasteDataCredits: savingsDc,
        wasteUsd: usd(savingsActions, savingsDc),
        savingsActions,
        savingsDataCredits: savingsDc,
        savingsUsd: usd(savingsActions, savingsDc),
        details: { suggestedRunCondition: suggestedCondition },
      });
    }
  }

  const deps = dependentsMap(workflow);
  const finalIds = new Set(
    workflow.steps.filter((s) => s.isFinalOutput || s.type === "export").map((s) => s.id)
  );
  for (const step of workflow.steps) {
    if (!["enrich", "waterfall", "use_ai", "claygent"].includes(step.type)) continue;
    const downstream = deps.get(step.id) ?? new Set();
    const reachesFinal =
      finalIds.has(step.id) || [...downstream].some((d) => finalIds.has(d));
    const used = downstream.size > 0 || reachesFinal;
    if (used) continue;
    const simStep = baseline.steps.find((s) => s.stepId === step.id);
    const wasteA = simStep?.actionsUsed ?? 0;
    const wasteD = simStep?.dataCreditsUsed ?? 0;
    if (wasteA < 0.01 && wasteD < 0.01) continue;
    findings.push({
      rule: "R3",
      title: PLAIN_TITLES.R3,
      summary: `"${step.name}" is never used by later steps or export — its full cost is waste.`,
      stepIds: [step.id],
      wasteActions: wasteA,
      wasteDataCredits: wasteD,
      wasteUsd: usd(wasteA, wasteD),
      savingsActions: wasteA,
      savingsDataCredits: wasteD,
      savingsUsd: usd(wasteA, wasteD),
    });
  }

  for (const step of workflow.steps) {
    if (step.type !== "waterfall" || !step.providers?.length) continue;
    const rates = resolveProviderHitRates(step, profile, rows);
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
    const orderChanged =
      newOrder.map((p) => p.id).join() !== step.providers.map((p) => p.id).join();
    if (!orderChanged || newE >= currentE - 1e-6) continue;

    const simStep = baseline.steps.find((s) => s.stepId === step.id);
    const rowsCharged = simStep?.rowsCharged ?? profile.rowCount;
    const savingsDc = (currentE - newE) * rowsCharged;
    suggestedWaterfallOrders[step.id] = newOrder.map((p) => p.id);
    findings.push({
      rule: "R4",
      title: PLAIN_TITLES.R4,
      summary: `Try providers in hit-rate-per-credit order. Expected DC/row (charged on hits only) drops from ${currentE.toFixed(3)} to ${newE.toFixed(3)}.`,
      stepIds: [step.id],
      wasteActions: 0,
      wasteDataCredits: savingsDc,
      wasteUsd: usd(0, savingsDc),
      savingsActions: 0,
      savingsDataCredits: savingsDc,
      savingsUsd: usd(0, savingsDc),
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
      title: PLAIN_TITLES.R5,
      summary: `"${step.name}" is a simple transform. Switch ${step.type} → AI Formula (free).`,
      stepIds: [step.id],
      wasteActions: wasteA,
      wasteDataCredits: wasteD,
      wasteUsd: usd(wasteA, wasteD),
      savingsActions: wasteA,
      savingsDataCredits: wasteD,
      savingsUsd: usd(wasteA, wasteD),
    });
  }

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
  keyFields: string[],
  prices: PriceAssumptions = DEFAULT_PRICES
): HealthMetrics {
  const wasteActions = findings.reduce((s, f) => s + f.wasteActions, 0);
  const wasteDataCredits = findings.reduce((s, f) => s + f.wasteDataCredits, 0);

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
    wasteUsd: usdFromMeters(wasteActions, wasteDataCredits, prices),
    icpEfficiencyActions: icpEffA,
    icpEfficiencyDataCredits: icpEffD,
    dataConfidence,
    waterfallEfficiency,
    overallScore,
  };
}

/** Apply suggested order, waterfall reorder, run conditions, and AI-tier downgrades. */
export function buildFixedWorkflow(
  workflow: WorkflowDefinition,
  result: AnalysisResult
): WorkflowDefinition {
  const byId = new Map(workflow.steps.map((s) => [s.id, s]));
  const order =
    result.suggestedStepOrder.length > 0
      ? result.suggestedStepOrder
      : workflow.steps.map((s) => s.id);

  const r2Conditions = new Map<
    string,
    { field: string; op: "not_blank" | "blank" | "eq" | "neq" | "truthy"; value?: string }
  >();
  const r5Steps = new Set<string>();
  for (const f of result.findings) {
    if (f.rule === "R2" && f.details?.suggestedRunCondition) {
      for (const id of f.stepIds) {
        r2Conditions.set(
          id,
          f.details.suggestedRunCondition as {
            field: string;
            op: "not_blank" | "blank" | "eq" | "neq" | "truthy";
            value?: string;
          }
        );
      }
    }
    if (f.rule === "R5") {
      for (const id of f.stepIds) r5Steps.add(id);
    }
  }

  const steps = order.map((id) => {
    const original = byId.get(id);
    if (!original) throw new Error(`Unknown step in fixed order: ${id}`);
    let step: WorkflowStep = { ...original, dependsOn: [...original.dependsOn] };

    const waterfallOrder = result.suggestedWaterfallOrders[id];
    if (waterfallOrder?.length && step.providers) {
      const map = new Map(step.providers.map((p) => [p.id, p]));
      step = {
        ...step,
        providers: waterfallOrder.map((pid) => {
          const p = map.get(pid);
          if (!p) throw new Error(`Unknown provider ${pid}`);
          return { ...p };
        }),
      };
    }

    const cond = r2Conditions.get(id);
    if (cond && !step.runCondition) {
      step = { ...step, runCondition: cond };
    }

    if (r5Steps.has(id) && (step.type === "use_ai" || step.type === "claygent")) {
      step = {
        ...step,
        type: "ai_formula",
        actionCost: 0,
        dataCreditCost: 0,
        taskClass: "deterministic",
      };
    }

    return step;
  });

  const goal = result.assumptions.icpGoal?.trim();
  const userDesc = result.assumptions.workflowDescription?.trim();
  const icp = result.assumptions.icpRule;
  const parts = [
    userDesc,
    goal ? `ICP goal: ${goal}` : "",
    `ICP rule: ${icp.column} in [${icp.min}, ${icp.max}] (pass rate ${(result.assumptions.icpPassRate * 100).toFixed(0)}% from ${result.assumptions.icpSource}).`,
    "Optimized by Clay Workflow Health: dependency-safe filter pushdown, waterfall reorder (Data Credits charged on hits only; Actions per attempt), AI tier fixes.",
  ].filter(Boolean);

  const baseName = workflow.name
    .replace(/\s*—\s*Before\s*$/i, "")
    .replace(/\s*—\s*Fixed\s*$/i, "")
    .trim();

  return {
    ...workflow,
    name: `${baseName} — Fixed`,
    description: parts.join(" "),
    steps,
  };
}

export function analyze(
  workflow: WorkflowDefinition,
  rows: CsvRow[],
  profile: CsvProfile,
  options: AnalyzeOptions = {}
): AnalysisResult {
  const prices = options.prices ?? DEFAULT_PRICES;
  const icpRule = options.icpRule ?? DEFAULT_ICP_RULE;
  const simOpts: SimulateOptions = { prices, icpRule };
  const resolvedIcp = resolveIcpPassRate(rows, icpRule);

  const simulation = simulate(workflow, rows, profile, simOpts);
  const { findings, suggestedStepOrder, suggestedWaterfallOrders } = applyRules(
    workflow,
    rows,
    profile,
    simulation,
    { prices, icpRule, simOpts }
  );
  const keyFields = [
    "Work Email",
    "Companyempcount",
    "Name People",
    "Company Domain",
    icpRule.column,
  ].filter((v, i, a) => a.indexOf(v) === i);
  const metrics = computeMetrics(simulation, findings, profile, keyFields, prices);
  return {
    profile,
    simulation,
    metrics,
    findings,
    suggestedStepOrder,
    suggestedWaterfallOrders,
    assumptions: {
      actionUsd: prices.actionUsd,
      dataCreditUsd: prices.dataCreditUsd,
      icpRule,
      icpPassRate: resolvedIcp.passRate,
      icpSource: resolvedIcp.source,
      icpGoal: options.icpGoal,
      workflowDescription: options.workflowDescription,
    },
  };
}
