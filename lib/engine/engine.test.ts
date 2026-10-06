import { describe, expect, it } from "vitest";
import {
  absoluteWinsToConditional,
  analyze,
  buildFixedWorkflow,
  expectedWaterfallActions,
  expectedWaterfallDataCredits,
  modeledFindRateFromConditional,
  parseCsv,
  parseWorkflow,
  profileCsv,
  resolveIcpPassRate,
  resolveProviderHitRates,
  resolveProviderHitRatesDetailed,
  simulate,
  topologicalOrder,
} from "@/lib/engine";
import type { WorkflowDefinition } from "@/lib/engine";
import fs from "fs";
import path from "path";

const handWorkflow: WorkflowDefinition = {
  name: "Hand example",
  steps: [
    {
      id: "find_contacts",
      name: "Find contacts",
      type: "enrich",
      field: "contacts",
      dependsOn: [],
      actionCost: 1,
      dataCreditCost: 0.5,
    },
    {
      id: "work_email",
      name: "Work email",
      type: "waterfall",
      field: "email",
      dependsOn: ["find_contacts"],
      actionCost: 1,
      dataCreditCost: 0,
      providers: [
        { id: "findymail", dataCreditCost: 0.5, hitRate: 0.5 },
        { id: "prospeo", dataCreditCost: 0.3, hitRate: 0.4 },
        { id: "hunter", dataCreditCost: 0.2, hitRate: 0.25 },
      ],
    },
    {
      id: "validate_email",
      name: "Validate",
      type: "enrich",
      field: "email",
      dependsOn: ["work_email"],
      actionCost: 1,
      dataCreditCost: 0.1,
      runCondition: { field: "email", op: "not_blank" },
    },
    {
      id: "employee_count",
      name: "Employee count",
      type: "enrich",
      field: "emp",
      dependsOn: [],
      actionCost: 1,
      dataCreditCost: 2.0,
    },
    {
      id: "emp_range",
      name: "Range",
      type: "ai_formula",
      field: "range",
      dependsOn: ["employee_count"],
      actionCost: 0,
      dataCreditCost: 0,
      taskClass: "deterministic",
    },
    {
      id: "title_cleanup",
      name: "Normalize title casing",
      type: "use_ai",
      field: "title",
      dependsOn: ["find_contacts"],
      actionCost: 1,
      dataCreditCost: 0,
      taskClass: "deterministic",
      purpose: "Title-case and trim job titles",
    },
    {
      id: "icp_filter",
      name: "ICP Pass",
      type: "filter",
      field: "ICP Pass",
      dependsOn: ["employee_count"],
      actionCost: 0,
      dataCreditCost: 0,
      passColumn: "ICP Pass",
      passValue: "true",
    },
    {
      id: "export",
      name: "Export",
      type: "export",
      field: "domain",
      dependsOn: ["icp_filter", "validate_email", "title_cleanup"],
      actionCost: 1,
      dataCreditCost: 0,
      isFinalOutput: true,
    },
  ],
};

function makeRows(): Record<string, string>[] {
  return Array.from({ length: 10 }, (_, i) => ({
    domain: `co${i}.com`,
    contacts: i < 7 ? "yes" : "",
    email: i < 7 ? `a${i}@co.com` : "",
    emp: String(100 + i),
    range: "51 to 200",
    title: i < 7 ? "ceo" : "",
    "ICP Pass": i < 4 ? "true" : "false",
  }));
}

describe("waterfall E[cost] with DC refunds", () => {
  it("charges Data Credits only on hits", () => {
    // 0.5*0.5 + 0.3*0.5*0.4 + 0.2*0.5*0.6*0.25 = 0.325
    const e = expectedWaterfallDataCredits(
      [
        { id: "findymail", dataCreditCost: 0.5, hitRate: 0.5 },
        { id: "prospeo", dataCreditCost: 0.3, hitRate: 0.4 },
        { id: "hunter", dataCreditCost: 0.2, hitRate: 0.25 },
      ],
      [0.5, 0.4, 0.25]
    );
    expect(e).toBeCloseTo(0.325, 5);
  });

  it("still charges Actions per attempt", () => {
    // 1 + 0.5 + 0.3 = 1.8
    const a = expectedWaterfallActions(
      [
        { id: "findymail", dataCreditCost: 0.5, hitRate: 0.5 },
        { id: "prospeo", dataCreditCost: 0.3, hitRate: 0.4 },
        { id: "hunter", dataCreditCost: 0.2, hitRate: 0.25 },
      ],
      [0.5, 0.4, 0.25],
      1
    );
    expect(a).toBeCloseTo(1.8, 5);
  });

  it("recommends lower E[DC] after hit-per-credit reorder", () => {
    // 0.3*0.4 + 0.2*0.6*0.25 + 0.5*0.6*0.75*0.5 = 0.2625
    const eNew = expectedWaterfallDataCredits(
      [
        { id: "prospeo", dataCreditCost: 0.3, hitRate: 0.4 },
        { id: "hunter", dataCreditCost: 0.2, hitRate: 0.25 },
        { id: "findymail", dataCreditCost: 0.5, hitRate: 0.5 },
      ],
      [0.4, 0.25, 0.5]
    );
    expect(eNew).toBeCloseTo(0.2625, 5);
  });
});

describe("ICP from CSV", () => {
  it("falls back to numeric range when ICP Pass column is missing", () => {
    const rows = makeRows().map((row) => {
      const next = { ...row };
      delete next["ICP Pass"];
      return next;
    });
    const resolved = resolveIcpPassRate(rows, {
      column: "emp",
      min: 50,
      max: 500,
      preferPassColumn: "ICP Pass",
    });
    expect(resolved.source).toBe("numeric_range");
    expect(resolved.passRate).toBe(1); // all emp 100–109
  });

  it("uses ICP Pass when the column exists", () => {
    const rows = makeRows();
    const resolved = resolveIcpPassRate(rows, {
      column: "emp",
      min: 50,
      max: 500,
      preferPassColumn: "ICP Pass",
    });
    expect(resolved.source).toBe("pass_column");
    expect(resolved.passRate).toBeCloseTo(0.4, 5);
  });
});

describe("hit rate scaling matches email fill", () => {
  it("converts absolute shares into conditional rates with overall find ≈ fill", () => {
    const absolute = [0.185, 0.317, 0.198]; // sum 0.7
    const conditional = absoluteWinsToConditional(absolute);
    expect(modeledFindRateFromConditional(conditional)).toBeCloseTo(0.7, 5);
  });

  it("scales declared rates to CSV fill so modeled find matches fill", () => {
    const rows = makeRows();
    const profile = profileCsv(rows, handWorkflow);
    const step = handWorkflow.steps.find((s) => s.id === "work_email")!;
    const resolved = resolveProviderHitRatesDetailed(step, profile, rows);
    expect(resolved.source).toBe("fill_scaled_estimates");
    expect(resolved.emailFillRate).toBeCloseTo(0.7, 5);
    expect(resolved.modeledFindRate).toBeCloseTo(0.7, 5);
  });
});

describe("hand example simulation", () => {
  it("computes dual-meter totals with refund-aware waterfall", () => {
    const rows = makeRows();
    const profile = profileCsv(rows, handWorkflow);
    const sim = simulate(handWorkflow, rows, profile);
    const step = handWorkflow.steps.find((s) => s.id === "work_email")!;
    const rates = resolveProviderHitRates(step, profile, rows);
    const eDc = expectedWaterfallDataCredits(step.providers!, rates);
    const eAct = expectedWaterfallActions(step.providers!, rates, step.actionCost);
    expect(sim.actionsUsed).toBeCloseTo(10 + eAct * 10 + 7 + 10 + 10 + 4, 4);
    expect(sim.dataCreditsUsed).toBeCloseTo(5 + eDc * 10 + 0.7 + 20, 4);
  });

  it("R1 and R5 fire; R4 DC savings are 0 when wins are exclusive fill shares", () => {
    const rows = makeRows();
    const profile = profileCsv(rows, handWorkflow);
    const result = analyze(handWorkflow, rows, profile);
    const rules = new Set(result.findings.map((f) => f.rule));
    expect(rules.has("R1")).toBe(true);
    expect(rules.has("R5")).toBe(true);
    // With fill-scaled exclusive shares + DC-on-hits, E[DC] is order-invariant
    expect(rules.has("R4")).toBe(false);
    const r1 = result.findings.find((f) => f.rule === "R1")!;
    expect(r1.savingsActions).toBeGreaterThan(0);
    expect(r1.savingsDataCredits).toBeGreaterThan(0);
    expect(result.suggestedStepOrder.indexOf("employee_count")).toBeLessThan(
      result.suggestedStepOrder.indexOf("icp_filter")
    );
    expect(result.suggestedStepOrder.indexOf("icp_filter")).toBeLessThan(
      result.suggestedStepOrder.indexOf("find_contacts")
    );
    expect(r1.stepIds).not.toContain("employee_count");
    expect(r1.stepIds).toContain("find_contacts");
  });

  it("R4 still fires on independent declared rates when CSV has no email fill", () => {
    const rows = makeRows().map((r) => ({ ...r, email: "" }));
    const profile = profileCsv(rows, handWorkflow);
    const result = analyze(handWorkflow, rows, profile);
    const r4 = result.findings.find((f) => f.rule === "R4");
    expect(r4).toBeTruthy();
    expect(r4!.details?.recommendedOrder).toEqual([
      "prospeo",
      "hunter",
      "findymail",
    ]);
  });

  it("buildFixedWorkflow drops wasteful description and applies fixes", () => {
    const rows = makeRows();
    const profile = profileCsv(rows, handWorkflow);
    const result = analyze(handWorkflow, rows, profile, {
      icpGoal: "Series A, 50–500 employees",
      workflowDescription: "Outbound enrichment table",
    });
    const fixed = buildFixedWorkflow(
      {
        ...handWorkflow,
        description: "Wasteful order: paid enrichments before ICP filter.",
      },
      result
    );
    expect(fixed.steps.map((s) => s.id)).toEqual(result.suggestedStepOrder);
    expect(fixed.steps.find((s) => s.id === "title_cleanup")?.type).toBe("ai_formula");
    expect(fixed.description).not.toMatch(/Wasteful/i);
    expect(fixed.description).toMatch(/Outbound enrichment table/);
    expect(fixed.description).toMatch(/ICP goal/);
  });
});

describe("sample clay export", () => {
  it("profiles CSV and finds R1 waste on late ICP", () => {
    const csv = fs.readFileSync(
      path.join(process.cwd(), "sample/companies.csv"),
      "utf8"
    );
    const wfJson = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "sample/workflow.json"), "utf8")
    );
    const workflow = parseWorkflow(wfJson);
    topologicalOrder(workflow);
    const rows = parseCsv(csv);
    expect(rows.length).toBe(30);
    const profile = profileCsv(rows, workflow);
    expect(profile.providerWins[0]?.wins.Findymail).toBe(7);
    const result = analyze(workflow, rows, profile);
    expect(result.metrics.actionsUsed).toBeGreaterThan(0);
    expect(result.metrics.dataCreditsUsed).toBeGreaterThan(0);
    expect(result.findings.some((f) => f.rule === "R1")).toBe(true);
    expect(result.findings.some((f) => f.rule === "R5")).toBe(true);
    expect(result.assumptions.icpSource).toBe("pass_column");
    // Waterfall DC should be hit-charged (~0.12/row * 30), not attempt-charged (~0.82*30)
    const wfStep = result.simulation.steps.find((s) => s.stepId === "work_email");
    expect(wfStep?.waterfallExpectedPerRow).toBeLessThan(0.4);
  });
});
