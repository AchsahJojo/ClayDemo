"use client";

import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { AnalysisResult, WorkflowDefinition } from "@/lib/engine";

interface Props {
  workflow: WorkflowDefinition;
  result: AnalysisResult;
}

const TYPE_COLOR: Record<string, string> = {
  enrich: "#0f766e",
  waterfall: "#b45309",
  filter: "#1d4ed8",
  ai_formula: "#15803d",
  use_ai: "#a16207",
  claygent: "#9f1239",
  export: "#334155",
};

export function WorkflowGraph({ workflow, result }: Props) {
  const { nodes, edges } = useMemo(() => {
    const suggested = new Set(
      result.suggestedStepOrder.length
        ? result.suggestedStepOrder
        : workflow.steps.map((s) => s.id)
    );
    const order = workflow.steps.map((s) => s.id);
    const nodes: Node[] = workflow.steps.map((step, i) => {
      const sim = result.simulation.steps.find((s) => s.stepId === step.id);
      const flagged = result.findings.some((f) => f.stepIds.includes(step.id));
      const providers =
        step.type === "waterfall" && step.providers
          ? `\n[${(result.suggestedWaterfallOrders[step.id] ?? step.providers.map((p) => p.id)).join(" → ")}]`
          : "";
      return {
        id: step.id,
        position: { x: (i % 4) * 220, y: Math.floor(i / 4) * 140 },
        data: {
          label: `${step.name}\n${step.type} · ${sim ? `${sim.actionsUsed.toFixed(1)}A / ${sim.dataCreditsUsed.toFixed(1)}DC` : ""}${providers}`,
        },
        style: {
          border: flagged ? "2px solid #b45309" : "1px solid #cbd5e1",
          borderRadius: 8,
          padding: 10,
          fontSize: 11,
          whiteSpace: "pre-wrap",
          width: 190,
          background: "#fffdf8",
          color: TYPE_COLOR[step.type] ?? "#0f172a",
          opacity: suggested.has(step.id) ? 1 : 0.85,
        },
      };
    });

    const edges: Edge[] = [];
    for (const step of workflow.steps) {
      for (const dep of step.dependsOn) {
        edges.push({
          id: `${dep}-${step.id}`,
          source: dep,
          target: step.id,
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
          style: { stroke: "#94a3b8" },
        });
      }
    }

    // Suggested order ribbon: light edges along suggestedStepOrder
    for (let i = 0; i < result.suggestedStepOrder.length - 1; i++) {
      const a = result.suggestedStepOrder[i];
      const b = result.suggestedStepOrder[i + 1];
      if (!order.includes(a) || !order.includes(b)) continue;
      edges.push({
        id: `suggest-${a}-${b}`,
        source: a,
        target: b,
        animated: true,
        style: { stroke: "#0f766e", strokeDasharray: "4 4" },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#0f766e" },
      });
    }

    return { nodes, edges };
  }, [workflow, result]);

  return (
    <div className="h-[360px] w-full overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
      <ReactFlow nodes={nodes} edges={edges} fitView proOptions={{ hideAttribution: true }}>
        <Background gap={18} color="#e7e0d4" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
