/**
 * Dual-meter pricing locked from Clay Usage history
 * (Workflow Health Demo — Before, week of Sep 28–Oct 3)
 * plus Clay University $/meter conversion constants.
 */

export const ACTION_USD = 0.002; // ~tenths of a cent per Action
export const DATA_CREDIT_USD = 0.02; // ~cents per Data Credit

/** Unit costs observed in Clay Usage history (per cell that runs). */
export const UNIT_COSTS = {
  findContacts: { actionCost: 1, dataCreditCost: 0.5 },
  findymailEmail: { actionCost: 1, dataCreditCost: 0.5 },
  validateFindymail: { actionCost: 1, dataCreditCost: 0.1 },
  smartEmployeeCount: { actionCost: 1, dataCreditCost: 2.0 },
  free: { actionCost: 0, dataCreditCost: 0 },
} as const;

/** Observed week totals from Clay History (partial table runs). */
export const OBSERVED_USAGE = {
  dataCredits: 25.7,
  actions: 30,
  cells: 30,
  breakdown: {
    employeeCountSmarte: { cells: 9, dataCredits: 18.0, actions: 9 },
    workEmailFindymail: { cells: 7, dataCredits: 3.5, actions: 7 },
    findContacts: { cells: 7, dataCredits: 3.5, actions: 7 },
    validateFindymail: { cells: 7, dataCredits: 0.7, actions: 7 },
  },
} as const;

export interface PriceAssumptions {
  actionUsd: number;
  dataCreditUsd: number;
}

export const DEFAULT_PRICES: PriceAssumptions = {
  actionUsd: ACTION_USD,
  dataCreditUsd: DATA_CREDIT_USD,
};

export function usdFromMeters(
  actions: number,
  dataCredits: number,
  prices: PriceAssumptions = DEFAULT_PRICES
): number {
  return actions * prices.actionUsd + dataCredits * prices.dataCreditUsd;
}
