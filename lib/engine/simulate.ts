import { DEFAULT_PRICES, usdFromMeters, type PriceAssumptions } from "@/lib/costs";
import { topologicalOrder } from "./dag";
import {
  columnFillRate,
  fieldNotBlankRate,
  filterPassRate,
  resolveIcpPassRate,
} from "./profile";
import type {
  CsvProfile,
  CsvRow,
  IcpRule,
  ProviderSpec,
  SimulationResult,
  StepSimulation,
  WorkflowDefinition,
  WorkflowStep,
} from "./types";

export const DEFAULT_ICP_RULE: IcpRule = {
  column: "Companyempcount",
  min: 50,
  max: 500,
  preferPassColumn: "ICP Pass",
};

/**
 * Expected Data Credits per row with Clay-style refunds:
 * you only pay a provider's DC when that provider hits.
 * E[DC] = Σ price_i × P(reach i) × hit_i
 */
export function expectedWaterfallDataCredits(
  providers: ProviderSpec[],
  hitRates: number[]
): number {
  let missProb = 1;
  let expected = 0;
  for (let i = 0; i < providers.length; i++) {
    const hit = hitRates[i] ?? providers[i].hitRate ?? 0;
    expected += providers[i].dataCreditCost * missProb * hit;
    missProb *= 1 - hit;
  }
  return expected;
}

/**
 * Expected Actions per row: each provider attempt that is reached costs Actions
 * (misses are not refunded on the Action meter).
 */
export function expectedWaterfallActions(
  providers: ProviderSpec[],
  hitRates: number[],
  actionCostPerAttempt: number
): number {
  let missProb = 1;
  let expected = 0;
  for (let i = 0; i < providers.length; i++) {
    const hit = hitRates[i] ?? providers[i].hitRate ?? 0;
    expected += actionCostPerAttempt * missProb;
    missProb *= 1 - hit;
  }
  return expected;
}

/**
 * Hit rates from CSV when possible:
 * - provider-win column wins / rowCount when any wins exist
 * - else scale declared rates to the email/field fill rate from CSV
 * - else declared JSON rates
 */
export function resolveProviderHitRates(
  step: WorkflowStep,
  profile: CsvProfile,
  rows?: CsvRow[]
): number[] {
  const providers = step.providers ?? [];
  const win = step.providerWinColumn
    ? profile.providerWins.find((p) => p.column === step.providerWinColumn)
    : undefined;

  const hasWins =
    !!win && Object.values(win.wins).some((count) => count > 0);

  if (hasWins && win) {
    return providers.map((p) => {
      for (const [name, rate] of Object.entries(win.hitRates)) {
        if (
          name.toLowerCase() === (p.name ?? p.id).toLowerCase() ||
          name.toLowerCase() === p.id.toLowerCase()
        ) {
          return rate;
        }
      }
      return 0;
    });
  }

  const fillFromProfile = columnFillRate(profile, step.field);
  const fillFromRows =
    rows && rows.length ? fieldNotBlankRate(rows, step.field) : 0;
  const fill = Math.max(fillFromProfile, fillFromRows);

  const declared = providers.map((p) => p.hitRate ?? 0);
  const sumDeclared = declared.reduce((a, b) => a + b, 0);

  if (fill > 0 && sumDeclared > 0) {
    return declared.map((d) => Math.min(1, (d / sumDeclared) * fill));
  }
  if (fill > 0) {
    return providers.map((_, i) => (i === 0 ? fill : 0));
  }
  return declared;
}

function evaluateRunConditionFraction(
  step: WorkflowStep,
  rows: CsvRow[],
  rowsReaching: number
): number {
  if (!step.runCondition || rowsReaching <= 0) return 1;
  const { field, op, value } = step.runCondition;
  if (rows.length === 0) {
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
  return pass / rows.length;
}

export interface SimulateOptions {
  waterfallOrders?: Record<string, string[]>;
  stepOrder?: string[];
  icpRule?: IcpRule;
  prices?: PriceAssumptions;
}

function orderedSteps(
  workflow: WorkflowDefinition,
  opts?: SimulateOptions
): WorkflowStep[] {
  const byId = new Map(workflow.steps.map((s) => [s.id, s]));
  if (opts?.stepOrder?.length) {
    return opts.stepOrder.map((id) => {
      const s = byId.get(id);
      if (!s) throw new Error(`Unknown step in order: ${id}`);
      return s;
    });
  }
  try {
    topologicalOrder(workflow);
    return [...workflow.steps];
  } catch {
    return topologicalOrder(workflow);
  }
}

function isIcpFilter(step: WorkflowStep): boolean {
  return (
    step.type === "filter" &&
    (step.passColumn === "ICP Pass" ||
      /icp/i.test(step.name) ||
      /icp/i.test(step.id))
  );
}

export function simulate(
  workflow: WorkflowDefinition,
  rows: CsvRow[],
  profile: CsvProfile,
  opts?: SimulateOptions
): SimulationResult {
  const steps = orderedSteps(workflow, opts);
  const prices = opts?.prices ?? DEFAULT_PRICES;
  const icpRule = opts?.icpRule ?? DEFAULT_ICP_RULE;
  let rowsFlowing = profile.rowCount || rows.length;
  const stepResults: StepSimulation[] = [];
  let actionsUsed = 0;
  let dataCreditsUsed = 0;

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
        if (isIcpFilter(step) && rows.length) {
          passRate = resolveIcpPassRate(rows, icpRule).passRate;
        } else if (step.passColumn && rows.length) {
          passRate = filterPassRate(rows, step.passColumn, step.passValue ?? "true");
        } else {
          passRate = step.passValue ? Number(step.passValue) : 0.5;
          if (Number.isNaN(passRate)) passRate = 0.5;
        }
        rowsFlowing = rowsFlowing * (passRate ?? 1);
        if (isIcpFilter(step)) {
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
      const baseRates = resolveProviderHitRates(step, profile, rows);
      const baseById = new Map(
        (step.providers ?? []).map((p, i) => [p.id, baseRates[i]])
      );
      const orderedRates = providers.map(
        (p) => baseById.get(p.id) ?? p.hitRate ?? 0
      );

      waterfallExpectedPerRow = expectedWaterfallDataCredits(
        providers,
        orderedRates
      );
      const actionsPerRow = expectedWaterfallActions(
        providers,
        orderedRates,
        step.actionCost
      );
      providerOrder = providers.map((p) => p.id);
      rowsCharged = rowsEligible;
      actions = rowsCharged * actionsPerRow;
      dataCredits = rowsCharged * waterfallExpectedPerRow;
    } else {
      rowsCharged = rowsEligible;
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

  const passFrac =
    (profile.rowCount || rows.length) > 0
      ? icpPassingRows / (profile.rowCount || rows.length || 1)
      : 1;
  const actionsOnIcp = actionsBeforeIcp * passFrac + actionsAfterIcpStart;
  const dcOnIcp = dcBeforeIcp * passFrac + dcAfterIcpStart;

  return {
    actionsUsed,
    dataCreditsUsed,
    usd: usdFromMeters(actionsUsed, dataCreditsUsed, prices),
    steps: stepResults,
    rowsAtEnd: rowsFlowing,
    icpPassingRows,
    actionsOnIcpRows: actionsOnIcp,
    dataCreditsOnIcpRows: dcOnIcp,
  };
}

export function emailFillFraction(rows: CsvRow[], field = "Work Email"): number {
  return fieldNotBlankRate(rows, field);
}
