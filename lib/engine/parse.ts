import { z } from "zod";
import type { WorkflowDefinition } from "./types";

const runConditionSchema = z.object({
  field: z.string(),
  op: z.enum(["not_blank", "blank", "eq", "neq", "truthy"]),
  value: z.string().optional(),
});

const providerSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  dataCreditCost: z.number().nonnegative(),
  hitRate: z.number().min(0).max(1).optional(),
});

const stepSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum([
    "enrich",
    "waterfall",
    "filter",
    "ai_formula",
    "use_ai",
    "claygent",
    "export",
  ]),
  field: z.string(),
  dependsOn: z.array(z.string()).default([]),
  actionCost: z.number().nonnegative(),
  dataCreditCost: z.number().nonnegative(),
  providers: z.array(providerSchema).optional(),
  providerWinColumn: z.string().optional(),
  passColumn: z.string().optional(),
  passValue: z.string().optional(),
  runCondition: runConditionSchema.optional(),
  taskClass: z.enum(["deterministic", "reasoning", "research"]).optional(),
  purpose: z.string().optional(),
  provider: z.string().optional(),
  statusColumn: z.string().optional(),
  isFinalOutput: z.boolean().optional(),
});

export const workflowSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(stepSchema).min(1),
});

export function parseWorkflow(input: unknown): WorkflowDefinition {
  const parsed = workflowSchema.parse(input);
  const ids = new Set(parsed.steps.map((s) => s.id));
  if (ids.size !== parsed.steps.length) {
    throw new Error("Duplicate step ids in workflow");
  }
  for (const step of parsed.steps) {
    for (const dep of step.dependsOn) {
      if (!ids.has(dep)) {
        throw new Error(`Step ${step.id} depends on unknown step ${dep}`);
      }
    }
    if (step.type === "waterfall" && (!step.providers || step.providers.length === 0)) {
      throw new Error(`Waterfall step ${step.id} requires providers`);
    }
    if (
      (step.type === "ai_formula" || step.type === "filter") &&
      (step.actionCost !== 0 || step.dataCreditCost !== 0)
    ) {
      throw new Error(`${step.type} steps must have zero Actions and Data Credits`);
    }
  }
  return parsed as WorkflowDefinition;
}
