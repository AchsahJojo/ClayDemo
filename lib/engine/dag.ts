import type { WorkflowDefinition, WorkflowStep } from "./types";

export function topologicalOrder(workflow: WorkflowDefinition): WorkflowStep[] {
  const byId = new Map(workflow.steps.map((s) => [s.id, s]));
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();

  for (const step of workflow.steps) {
    indegree.set(step.id, 0);
    children.set(step.id, []);
  }
  for (const step of workflow.steps) {
    for (const dep of step.dependsOn) {
      indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
      children.get(dep)!.push(step.id);
    }
  }

  // Stable: respect declared array order among equal indegree
  const queue = workflow.steps
    .filter((s) => (indegree.get(s.id) ?? 0) === 0)
    .map((s) => s.id);
  const ordered: WorkflowStep[] = [];

  while (queue.length) {
    const id = queue.shift()!;
    const step = byId.get(id)!;
    ordered.push(step);
    for (const child of children.get(id) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) queue.push(child);
    }
  }

  if (ordered.length !== workflow.steps.length) {
    throw new Error("Workflow DAG contains a cycle");
  }
  return ordered;
}

/** Downstream dependents including transitive. */
export function dependentsMap(workflow: WorkflowDefinition): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const step of workflow.steps) map.set(step.id, new Set());
  for (const step of workflow.steps) {
    for (const dep of step.dependsOn) {
      map.get(dep)!.add(step.id);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, deps] of map) {
      const extra = new Set<string>();
      for (const d of deps) {
        for (const dd of map.get(d) ?? []) extra.add(dd);
      }
      for (const e of extra) {
        if (!deps.has(e)) {
          deps.add(e);
          changed = true;
        }
      }
      void id;
    }
  }
  return map;
}
