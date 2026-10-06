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

export type HitRateSource =
  | "provider_win_column"
  | "fill_scaled_estimates"
  | "declared";

export interface ResolvedHitRates {
  /** Sequential conditional hit rates for the waterfall cascade. */
  conditional: number[];
  /** Mutually exclusive share of all rows each provider wins. */
  absolute: number[];
  source: HitRateSource;
  emailFillRate: number;
  /** 1 − Π(1 − conditional_i) — should match emailFillRate when scaled. */
  modeledFindRate: number;
}

/**
 * Convert mutually exclusive absolute win fractions into sequential
 * conditional hit rates so overall P(find) ≈ Σ absolute.
 */
export function absoluteWinsToConditional(absolute: number[]): number[] {
  let remaining = 1;
  return absolute.map((abs) => {
    const clamped = Math.max(0, Math.min(1, abs));
    if (remaining <= 1e-12) return 0;
    const hit = Math.min(1, clamped / remaining);
    remaining = Math.max(0, remaining - clamped);
    return hit;
  });
}

export function modeledFindRateFromConditional(conditional: number[]): number {
  return 1 - conditional.reduce((miss, h) => miss * (1 - h), 1);
}

/**
 * Hit rates from CSV when possible:
 * - provider-win column → absolute wins/N, then conditional cascade
 * - else declared shares × email fill (labeled estimates), then conditional
 * - else declared JSON rates as conditional (demo fallback)
 */
export function resolveProviderHitRatesDetailed(
  step: WorkflowStep,
  profile: CsvProfile,
  rows?: CsvRow[]
): ResolvedHitRates {
  const providers = step.providers ?? [];
  const fillFromProfile = columnFillRate(profile, step.field);
  const fillFromRows =
    rows && rows.length ? fieldNotBlankRate(rows, step.field) : 0;
  const emailFillRate = Math.max(fillFromProfile, fillFromRows);

  const win = step.providerWinColumn
    ? profile.providerWins.find((p) => p.column === step.providerWinColumn)
    : undefined;
  const hasWins =
    !!win && Object.values(win.wins).some((count) => count > 0);

  if (hasWins && win) {
    const absolute = providers.map((p) => {
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
    const conditional = absoluteWinsToConditional(absolute);
    return {
      conditional,
      absolute,
      source: "provider_win_column",
      emailFillRate,
      modeledFindRate: modeledFindRateFromConditional(conditional),
    };
  }

  const declared = providers.map((p) => p.hitRate ?? 0);
  const sumDeclared = declared.reduce((a, b) => a + b, 0);

  if (emailFillRate > 0 && sumDeclared > 0) {
    const absolute = declared.map((d) => (d / sumDeclared) * emailFillRate);
    const conditional = absoluteWinsToConditional(absolute);
    return {
      conditional,
      absolute,
      source: "fill_scaled_estimates",
      emailFillRate,
      modeledFindRate: modeledFindRateFromConditional(conditional),
    };
  }

  if (emailFillRate > 0) {
    const absolute = providers.map((_, i) => (i === 0 ? emailFillRate : 0));
    const conditional = absoluteWinsToConditional(absolute);
    return {
      conditional,
      absolute,
      source: "fill_scaled_estimates",
      emailFillRate,
      modeledFindRate: modeledFindRateFromConditional(conditional),
    };
  }

  const conditional = declared.map((d) => Math.min(1, Math.max(0, d)));
  return {
    conditional,
    absolute: [],
    source: "declared",
    emailFillRate,
    modeledFindRate: modeledFindRateFromConditional(conditional),
  };
}

/** Conditional hit rates only (back-compat for simulate / rules). */
export function resolveProviderHitRates(
  step: WorkflowStep,
  profile: CsvProfile,
  rows?: CsvRow[]
): number[] {
  return resolveProviderHitRatesDetailed(step, profile, rows).conditional;
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
