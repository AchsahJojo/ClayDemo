export type StepType =
  | "enrich"
  | "waterfall"
  | "filter"
  | "ai_formula"
  | "use_ai"
  | "claygent"
  | "export";

export type TaskClass = "deterministic" | "reasoning" | "research";

export type RunConditionOp = "not_blank" | "blank" | "eq" | "neq" | "truthy";

export interface RunCondition {
  field: string;
  op: RunConditionOp;
  value?: string;
}

export interface ProviderSpec {
  id: string;
  name?: string;
  dataCreditCost: number;
  /** Declared hit rate 0–1; overridden by CSV provider-win column when present. */
  hitRate?: number;
}

export interface WorkflowStep {
  id: string;
  name: string;
  type: StepType;
  field: string;
  dependsOn: string[];
  actionCost: number;
  dataCreditCost: number;
  providers?: ProviderSpec[];
  providerWinColumn?: string;
  passColumn?: string;
  passValue?: string;
  runCondition?: RunCondition;
  taskClass?: TaskClass;
  purpose?: string;
  provider?: string;
  statusColumn?: string;
  isFinalOutput?: boolean;
}

export interface WorkflowDefinition {
  name: string;
  description?: string;
  steps: WorkflowStep[];
}

export type CsvRow = Record<string, string>;

export interface ColumnProfile {
  name: string;
  filled: number;
  blank: number;
  fillRate: number;
  blankRate: number;
  blankAmbiguous: true;
}

export interface ProviderWinProfile {
  column: string;
  wins: Record<string, number>;
  hitRates: Record<string, number>;
  noneFound: number;
}

export interface CsvProfile {
  rowCount: number;
  columns: ColumnProfile[];
  providerWins: ProviderWinProfile[];
}

export interface StepSimulation {
  stepId: string;
  rowsReaching: number;
  rowsCharged: number;
  actionsUsed: number;
  dataCreditsUsed: number;
  passRate?: number;
  waterfallExpectedPerRow?: number;
  providerOrder?: string[];
}

export interface SimulationResult {
  actionsUsed: number;
  dataCreditsUsed: number;
  usd: number;
  steps: StepSimulation[];
  rowsAtEnd: number;
  icpPassingRows: number;
  actionsOnIcpRows: number;
  dataCreditsOnIcpRows: number;
}

export type RuleId = "R1" | "R2" | "R3" | "R4" | "R5";

export interface Finding {
  rule: RuleId;
  title: string;
  summary: string;
  stepIds: string[];
  wasteActions: number;
  wasteDataCredits: number;
  wasteUsd: number;
  savingsActions: number;
  savingsDataCredits: number;
  savingsUsd: number;
  details?: Record<string, unknown>;
}

export interface HealthMetrics {
  actionsUsed: number;
  dataCreditsUsed: number;
  usdPerRun: number;
  wasteActions: number;
  wasteDataCredits: number;
  wasteUsd: number;
  icpEfficiencyActions: number;
  icpEfficiencyDataCredits: number;
  dataConfidence: number;
  waterfallEfficiency?: number;
  overallScore: number;
}

export interface AnalysisResult {
  profile: CsvProfile;
  simulation: SimulationResult;
  metrics: HealthMetrics;
  findings: Finding[];
  suggestedStepOrder: string[];
  suggestedWaterfallOrders: Record<string, string[]>;
}
