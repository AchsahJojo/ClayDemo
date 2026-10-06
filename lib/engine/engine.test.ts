import { describe, expect, it } from "vitest";
import {
  analyze,
  buildFixedWorkflow,
  expectedWaterfallDataCredits,
  parseCsv,
  parseWorkflow,
  profileCsv,
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

describe("waterfall E[cost]", () => {
  it("matches hand-worked expected cost per row", () => {
    const e = expectedWaterfallDataCredits(
      [
        { id: "findymail", dataCreditCost: 0.5, hitRate: 0.5 },
        { id: "prospeo", dataCreditCost: 0.3, hitRate: 0.4 },
        { id: "hunter", dataCreditCost: 0.2, hitRate: 0.25 },
      ],
      [0.5, 0.4, 0.25]
    );
    expect(e).toBeCloseTo(0.71, 5);
  });

  it("recommends lower E[cost] after hit-per-credit reorder", () => {
    const eNew = expectedWaterfallDataCredits(
      [
        { id: "prospeo", dataCreditCost: 0.3, hitRate: 0.4 },
        { id: "hunter", dataCreditCost: 0.2, hitRate: 0.25 },
        { id: "findymail", dataCreditCost: 0.5, hitRate: 0.5 },
      ],
      [0.4, 0.25, 0.5]
    );
    expect(eNew).toBeCloseTo(0.645, 5);
  });
});

describe("hand example simulation", () => {
  it("computes dual-meter totals close to whiteboard", () => {
    const rows = makeRows();
    const profile = profileCsv(rows, handWorkflow);
    const sim = simulate(handWorkflow, rows, profile);
    // Actions: contacts10 + waterfall10 + validate7 + emp10 + use_ai10 + export4 = 51
    expect(sim.actionsUsed).toBeCloseTo(51, 5);
    // DC: 5 + 7.1 + 0.7 + 20 = 32.8
    expect(sim.dataCreditsUsed).toBeCloseTo(32.8, 5);
  });

  it("R1 filter-too-late and R4/R5 fire with savings", () => {
    const rows = makeRows();
    const profile = profileCsv(rows, handWorkflow);
    const result = analyze(handWorkflow, rows, profile);
    const rules = new Set(result.findings.map((f) => f.rule));
    expect(rules.has("R1")).toBe(true);
    expect(rules.has("R4")).toBe(true);
    expect(rules.has("R5")).toBe(true);
    const r1 = result.findings.find((f) => f.rule === "R1")!;
    expect(r1.savingsActions).toBeGreaterThan(0);
    expect(r1.savingsDataCredits).toBeGreaterThan(0);
    // employee_count feeds ICP — must stay before the filter
    expect(result.suggestedStepOrder.indexOf("employee_count")).toBeLessThan(
      result.suggestedStepOrder.indexOf("icp_filter")
    );
    expect(result.suggestedStepOrder.indexOf("icp_filter")).toBeLessThan(
      result.suggestedStepOrder.indexOf("find_contacts")
    );
    expect(r1.stepIds).not.toContain("employee_count");
    expect(r1.stepIds).toContain("find_contacts");
    const r4 = result.findings.find((f) => f.rule === "R4")!;
    expect(r4.details?.recommendedOrder).toEqual([
      "prospeo",
      "hunter",
      "findymail",
    ]);
  });

  it("buildFixedWorkflow applies order, waterfall, and AI Formula", () => {
    const rows = makeRows();
    const profile = profileCsv(rows, handWorkflow);
    const result = analyze(handWorkflow, rows, profile);
    const fixed = buildFixedWorkflow(handWorkflow, result);
    expect(fixed.steps.map((s) => s.id)).toEqual(result.suggestedStepOrder);
    expect(fixed.steps.find((s) => s.id === "title_cleanup")?.type).toBe("ai_formula");
    const wf = fixed.steps.find((s) => s.id === "work_email");
    expect(wf?.providers?.map((p) => p.id)).toEqual([
      "prospeo",
      "hunter",
      "findymail",
    ]);
  });
});

describe("sample clay export", () => {
  it("profiles real CSV and finds R1 waste on late ICP", () => {
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
    // Dual meters exposed separately
    expect(result.metrics).toHaveProperty("actionsUsed");
    expect(result.metrics).toHaveProperty("dataCreditsUsed");
  });
});
