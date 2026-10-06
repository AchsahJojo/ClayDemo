import Papa from "papaparse";
import type {
  ColumnProfile,
  CsvProfile,
  CsvRow,
  ProviderWinProfile,
  WorkflowDefinition,
} from "./types";

export function parseCsv(text: string): CsvRow[] {
  const result = Papa.parse<CsvRow>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  if (result.errors.length) {
    const msg = result.errors.slice(0, 3).map((e) => e.message).join("; ");
    throw new Error(`CSV parse error: ${msg}`);
  }
  return result.data.map((row) => {
    const out: CsvRow = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = v == null ? "" : String(v).trim();
    }
    return out;
  });
}

function isBlank(v: string | undefined): boolean {
  return !v || v.length === 0;
}

function isNoneFound(v: string): boolean {
  const lower = v.toLowerCase();
  return (
    lower === "none found" ||
    lower.includes("no profile found") ||
    lower.includes("no employee count found") ||
    lower.startsWith("❌")
  );
}

export function profileCsv(
  rows: CsvRow[],
  workflow?: WorkflowDefinition
): CsvProfile {
  const columns: ColumnProfile[] = [];
  if (rows.length === 0) {
    return { rowCount: 0, columns: [], providerWins: [] };
  }
  const keys = Object.keys(rows[0]);
  for (const name of keys) {
    let filled = 0;
    let blank = 0;
    for (const row of rows) {
      if (isBlank(row[name])) blank++;
      else filled++;
    }
    columns.push({
      name,
      filled,
      blank,
      fillRate: filled / rows.length,
      blankRate: blank / rows.length,
      blankAmbiguous: true,
    });
  }

  const providerWins: ProviderWinProfile[] = [];
  const winColumns = new Set<string>();
  if (workflow) {
    for (const step of workflow.steps) {
      if (step.providerWinColumn) winColumns.add(step.providerWinColumn);
    }
  }
  // Also detect common Clay export header
  for (const col of keys) {
    if (/data provider/i.test(col)) winColumns.add(col);
  }

  for (const column of winColumns) {
    if (!keys.includes(column)) continue;
    const wins: Record<string, number> = {};
    let noneFound = 0;
    for (const row of rows) {
      const v = row[column] ?? "";
      if (isBlank(v) || isNoneFound(v)) {
        noneFound++;
        continue;
      }
      wins[v] = (wins[v] ?? 0) + 1;
    }
    const hitRates: Record<string, number> = {};
    for (const [prov, count] of Object.entries(wins)) {
      hitRates[prov] = count / rows.length;
    }
    providerWins.push({ column, wins, hitRates, noneFound });
  }

  return { rowCount: rows.length, columns, providerWins };
}

export function columnFillRate(profile: CsvProfile, name: string): number {
  return profile.columns.find((c) => c.name === name)?.fillRate ?? 0;
}

export function filterPassRate(
  rows: CsvRow[],
  passColumn: string,
  passValue = "true"
): number {
  if (rows.length === 0) return 0;
  let pass = 0;
  for (const row of rows) {
    const v = (row[passColumn] ?? "").toLowerCase();
    if (v === passValue.toLowerCase() || v === "1" || v === "yes") pass++;
  }
  return pass / rows.length;
}

export function fieldNotBlankRate(rows: CsvRow[], field: string): number {
  if (rows.length === 0) return 0;
  let n = 0;
  for (const row of rows) {
    if (!isBlank(row[field]) && !isNoneFound(row[field] ?? "")) n++;
  }
  return n / rows.length;
}

/** Numeric range pass rate (inclusive). Non-numeric / blank rows fail. */
export function numericRangePassRate(
  rows: CsvRow[],
  column: string,
  min: number,
  max: number
): number {
  if (rows.length === 0) return 0;
  let pass = 0;
  for (const row of rows) {
    const raw = (row[column] ?? "").replace(/,/g, "").trim();
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    if (n >= min && n <= max) pass++;
  }
  return pass / rows.length;
}

export function csvHasColumn(rows: CsvRow[], column: string): boolean {
  if (!rows.length || !column) return false;
  return Object.prototype.hasOwnProperty.call(rows[0], column);
}

export type IcpSource = "pass_column" | "numeric_range" | "fallback";

export interface ResolvedIcpRate {
  passRate: number;
  source: IcpSource;
  columnUsed: string;
}

/**
 * Resolve ICP pass rate from CSV:
 * 1) preferPassColumn when that header exists
 * 2) else numeric range on rule.column (e.g. employee count 50–500)
 * 3) else 0 with source fallback (caller should surface this)
 */
export function resolveIcpPassRate(
  rows: CsvRow[],
  rule: {
    column: string;
    min: number;
    max: number;
    preferPassColumn?: string;
  }
): ResolvedIcpRate {
  const prefer = rule.preferPassColumn;
  if (prefer && csvHasColumn(rows, prefer)) {
    return {
      passRate: filterPassRate(rows, prefer, "true"),
      source: "pass_column",
      columnUsed: prefer,
    };
  }

  const candidates = [
    rule.column,
    "Companyempcount",
    "emp",
    "Employee Count",
    "employee_count",
  ].filter(Boolean);
  for (const col of candidates) {
    if (csvHasColumn(rows, col)) {
      return {
        passRate: numericRangePassRate(rows, col, rule.min, rule.max),
        source: "numeric_range",
        columnUsed: col,
      };
    }
  }

  return { passRate: 0, source: "fallback", columnUsed: rule.column };
}
