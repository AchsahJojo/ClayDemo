import { usdFromMeters } from "@/lib/costs";
import { topologicalOrder } from "./dag";
import {
  fieldNotBlankRate,
  filterPassRate,
} from "./profile";
import type {
  CsvProfile,
  CsvRow,
  ProviderSpec,
  SimulationResult,
  StepSimulation,
  WorkflowDefinition,
  WorkflowStep,
} from "./types";

export function expectedWaterfallDataCredits(
  providers: ProviderSpec[],
  hitRates: number[]
): number {
  let missProb = 1;
  let expected = 0;
  for (let i = 0; i < providers.length; i++) {
    expected += providers[i].dataCreditCost * missProb;
    const hit = hitRates[i] ?? providers[i].hitRate ?? 0;
    missProb *= 1 - hit;
  }
  return expected;
}

export function resolveProviderHitRates(
  step: WorkflowStep,
  profile: CsvProfile
): number[] {
  const providers = step.providers ?? [];
  const win = step.providerWinColumn
    ? profile.providerWins.find((p) => p.column === step.providerWinColumn)
    : undefined;

  return providers.map((p) => {
    if (win) {
      // Match by provider name/id against win keys (e.g. "Findymail")
      for (const [name, rate] of Object.entries(win.hitRates)) {
        if (
          name.toLowerCase() === (p.name ?? p.id).toLowerCase() ||
          name.toLowerCase() === p.id.toLowerCase()
        ) {
          return rate;
        }
      }
    }
    return p.hitRate ?? 0;
  });
}

function evaluateRunConditionFraction(
  step: WorkflowStep,
  rows: CsvRow[],
  rowsReaching: number
): number {
  if (!step.runCondition || rowsReaching <= 0) return 1;
  const { field, op, value } = step.runCondition;
  if (rows.length === 0) {
    // Fall back to declared rates when no CSV context for condition
    if (op === "not_blank") return 0.7;
    if (op === "blank") return 0.3;
    return 1;
  }

  let pass = 0;
  for (const row of rows) {
    const v = (row[field] ?? "").trim();
    const blank = v.length === 0 || /^none found$/i.test(v);
    switch (op) {
      case "not_blank":
        if (!blank) pass++;
        break;
      case "blank":
        if (blank) pass++;
        break;
      case "eq":
        if (v.toLowerCase() === (value ?? "").toLowerCase()) pass++;
        break;
      case "neq":
        if (v.toLowerCase() !== (value ?? "").toLowerCase()) pass++;
        break;
      case "truthy":
        if (["true", "1", "yes"].includes(v.toLowerCase())) pass++;
        break;
    }
  }
  // Condition evaluated on full table; scale to rows reaching this step
  // by using the fraction among all rows as estimate for reaching cohort.
  return pass / rows.length;
}

export interface SimulateOptions {
  /** Override provider order for waterfall steps (provider ids). */
  waterfallOrders?: Record<string, string[]>;
  /** Reorder steps (ids) while preserving dependency legality is caller's job. */
  stepOrder?: string[];
  /** Force filter steps to run first (predicate pushdown simulation). */
  filtersFirst?: boolean;
}

function orderedSteps(
  workflow: WorkflowDefinition,
  opts?: SimulateOptions
): WorkflowStep[] {
  const byId = new Map(workflow.steps.map((s) => [s.id, s]));
  if (opts?.filtersFirst) {
    const filters = workflow.steps.filter((s) => s.type === "filter");
    const filterIds = new Set(filters.map((s) => s.id));
    const restSteps = workflow.steps
      .filter((s) => s.type !== "filter")
      .map((s) => ({
        ...s,
        dependsOn: s.dependsOn.filter((d) => !filterIds.has(d)),
      }));
    const rest = topologicalOrder({ ...workflow, steps: restSteps });
    // Filters first for billing reachability; dependents still conceptually after
    return [...filters, ...rest];
  }
  if (opts?.stepOrder?.length) {
    return opts.stepOrder.map((id) => {
      const s = byId.get(id);
      if (!s) throw new Error(`Unknown step in order: ${id}`);
      return s;
    });
  }
  // Prefer declared order in JSON (wasteful demo order) when DAG-valid
  try {
    topologicalOrder(workflow);
    return [...workflow.steps];
  } catch {
    return topologicalOrder(workflow);
  }
}

export function simulate(
  workflow: WorkflowDefinition,
  rows: CsvRow[],
  profile: CsvProfile,
  opts?: SimulateOptions
): SimulationResult {
  const steps = orderedSteps(workflow, opts);
  let rowsFlowing = profile.rowCount || rows.length;
  const stepResults: StepSimulation[] = [];
  let actionsUsed = 0;
  let dataCreditsUsed = 0;

  // Track ICP: if we see a filter with passColumn, record post-filter rows
  let icpPassingRows = rowsFlowing;
  let sawIcpFilter = false;
  let actionsBeforeIcp = 0;
  let dcBeforeIcp = 0;
  let actionsAfterIcpStart = 0;
  let dcAfterIcpStart = 0;
  let pastIcp = false;

  for (const step of steps) {
    const condFrac = evaluateRunConditionFraction(step, rows, rowsFlowing);
    const rowsEligible = rowsFlowing * condFrac;

    let actions = 0;
    let dataCredits = 0;
    let rowsCharged = 0;
    let passRate: number | undefined;
    let waterfallExpectedPerRow: number | undefined;
    let providerOrder: string[] | undefined;

    if (step.type === "filter" || step.type === "ai_formula") {
      rowsCharged = 0;
      if (step.type === "filter") {
        if (step.passColumn && rows.length) {
          passRate = filterPassRate(rows, step.passColumn, step.passValue ?? "true");
        } else {
          passRate = step.passValue ? Number(step.passValue) : 0.5;
          if (Number.isNaN(passRate)) passRate = 0.5;
        }
        // When filtersFirst and this is ICP, apply to full table
        rowsFlowing = rowsFlowing * (passRate ?? 1);
        if (step.passColumn === "ICP Pass" || /icp/i.test(step.name)) {
          sawIcpFilter = true;
          icpPassingRows = rowsFlowing;
          pastIcp = true;
        }
      }
    } else if (step.type === "waterfall") {
      let providers = [...(step.providers ?? [])];
      const override = opts?.waterfallOrders?.[step.id];
      if (override?.length) {
        const map = new Map(providers.map((p) => [p.id, p]));
        providers = override.map((id) => {
          const p = map.get(id);
          if (!p) throw new Error(`Unknown provider ${id}`);
          return p;
        });
      }
      const hitRates = resolveProviderHitRates(
        { ...step, providers },
        profile
      );
      // If order changed, remap hit rates by provider id from original resolve
      const baseRates = resolveProviderHitRates(step, profile);
      const baseById = new Map(
        (step.providers ?? []).map((p, i) => [p.id, baseRates[i]])
      );
      const orderedRates = providers.map(
        (p, i) => baseById.get(p.id) ?? hitRates[i] ?? p.hitRate ?? 0
      );

      waterfallExpectedPerRow = expectedWaterfallDataCredits(providers, orderedRates);
      providerOrder = providers.map((p) => p.id);
      rowsCharged = rowsEligible;
      actions = rowsCharged * step.actionCost;
      dataCredits = rowsCharged * waterfallExpectedPerRow;
    } else {
      // enrich | use_ai | claygent | export
      rowsCharged = rowsEligible;
      // For validate-like steps with runCondition not_blank on email, rowsEligible already scaled
      // If no runCondition but field mostly blank, still charge rowsEligible (= rowsFlowing)
      actions = rowsCharged * step.actionCost;
      dataCredits = rowsCharged * step.dataCreditCost;
    }

    actionsUsed += actions;
    dataCreditsUsed += dataCredits;

    if (!pastIcp) {
      actionsBeforeIcp += actions;
      dcBeforeIcp += dataCredits;
    } else if (step.type !== "filter") {
      actionsAfterIcpStart += actions;
      dcAfterIcpStart += dataCredits;
    }

    stepResults.push({
      stepId: step.id,
      rowsReaching: rowsFlowing,
      rowsCharged,
      actionsUsed: actions,
      dataCreditsUsed: dataCredits,
      passRate,
      waterfallExpectedPerRow,
      providerOrder,
    });
  }

  if (!sawIcpFilter) {
    icpPassingRows = rowsFlowing;
  }

  // ICP efficiency: credits spent on rows that pass ICP / total
  // Approximation: post-filter spend is fully on ICP rows; pre-filter spend attributed by pass rate
  const passFrac =
    (profile.rowCount || rows.length) > 0
      ? icpPassingRows / (profile.rowCount || rows.length || 1)
      : 1;
  const actionsOnIcp =
    actionsBeforeIcp * passFrac + actionsAfterIcpStart;
  const dcOnIcp = dcBeforeIcp * passFrac + dcAfterIcpStart;

  return {
    actionsUsed,
    dataCreditsUsed,
    usd: usdFromMeters(actionsUsed, dataCreditsUsed),
    steps: stepResults,
    rowsAtEnd: rowsFlowing,
    icpPassingRows,
    actionsOnIcpRows: actionsOnIcp,
    dataCreditsOnIcpRows: dcOnIcp,
  };
}

/** Estimate how many rows would be charged for validate when email fill is known. */
export function emailFillFraction(rows: CsvRow[], field = "Work Email"): number {
  return fieldNotBlankRate(rows, field);
}
