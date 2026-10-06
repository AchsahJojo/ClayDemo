"use client";

import { useEffect, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  useReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { AnalysisResult, WorkflowDefinition } from "@/lib/engine";

export type GraphMode = "before" | "after";

interface Props {
  workflow: WorkflowDefinition;
  result: AnalysisResult;
  mode: GraphMode;
  highlightedStepIds?: string[];
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

function FitViewOnChange({
  mode,
  highlightKey,
  nodeCount,
}: {
  mode: GraphMode;
  highlightKey: string;
  nodeCount: number;
}) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (!nodeCount) return;
    const t = requestAnimationFrame(() => {
      fitView({ padding: 0.18, duration: 180, minZoom: 0.35, maxZoom: 1.1 });
    });
    return () => cancelAnimationFrame(t);
  }, [mode, highlightKey, nodeCount, fitView]);
  return null;
}

function GraphInner({
  workflow,
  result,
  mode,
  highlightedStepIds = [],
}: Props) {
  const highlight = useMemo(
    () => new Set(highlightedStepIds),
    [highlightedStepIds]
  );

  const { nodes, edges } = useMemo(() => {
    const order =
      mode === "after" && result.suggestedStepOrder.length
        ? result.suggestedStepOrder
        : workflow.steps.map((s) => s.id);
    const byId = new Map(workflow.steps.map((s) => [s.id, s]));
    const cols = Math.min(3, Math.max(1, order.length));

    const nodes: Node[] = order.map((id, i) => {
      const step = byId.get(id)!;
      const sim = result.simulation.steps.find((s) => s.stepId === step.id);
      const isHi = highlight.size === 0 || highlight.has(step.id);
      const providerIds =
        step.type === "waterfall" && step.providers
          ? mode === "after"
            ? result.suggestedWaterfallOrders[step.id] ??
              step.providers.map((p) => p.id)
            : step.providers.map((p) => p.id)
          : null;
      const providers = providerIds ? `\n[${providerIds.join(" → ")}]` : "";
      return {
        id: step.id,
        position: {
          x: (i % cols) * 220,
          y: Math.floor(i / cols) * 130,
        },
        data: {
          label: `${step.name}\n${step.type}${sim ? `\n${sim.actionsUsed.toFixed(1)}A / ${sim.dataCreditsUsed.toFixed(1)}DC` : ""}${providers}`,
        },
        style: {
          border: highlight.has(step.id)
            ? "2px solid #0f766e"
            : "1px solid #cbd5e1",
          borderRadius: 8,
          padding: 10,
          fontSize: 12,
          lineHeight: 1.35,
          fontWeight: highlight.has(step.id) ? 600 : 400,
          whiteSpace: "pre-wrap",
          width: 200,
          background: highlight.has(step.id) ? "#ccfbf1" : "#fffdf8",
          color: TYPE_COLOR[step.type] ?? "#0f172a",
          opacity: isHi ? 1 : 0.35,
          boxShadow: highlight.has(step.id)
            ? "0 0 0 3px rgba(15,118,110,0.25)"
            : undefined,
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
          style: {
            stroke:
              highlight.size && (highlight.has(dep) || highlight.has(step.id))
                ? "#0f766e"
                : "#94a3b8",
            strokeWidth: highlight.has(dep) || highlight.has(step.id) ? 2 : 1,
          },
        });
      }
    }

    for (let i = 0; i < order.length - 1; i++) {
      const a = order[i];
      const b = order[i + 1];
      edges.push({
        id: `seq-${mode}-${a}-${b}`,
        source: a,
        target: b,
        animated: mode === "after",
        style: {
          stroke: mode === "after" ? "#0f766e" : "#a8a29e",
          strokeDasharray: mode === "after" ? "5 4" : "2 4",
          opacity: 0.65,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: mode === "after" ? "#0f766e" : "#a8a29e",
        },
      });
    }

    return { nodes, edges };
  }, [workflow, result, mode, highlight]);

  return (
    <div className="h-[420px] w-full overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
      <ReactFlow
        key={`${mode}-${[...highlight].sort().join(",")}`}
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.18, minZoom: 0.35, maxZoom: 1.1 }}
        proOptions={{ hideAttribution: true }}
        minZoom={0.35}
        maxZoom={1.2}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
      >
        <Background gap={18} color="#e7e0d4" />
        <Controls showInteractive={false} />
        <FitViewOnChange
          mode={mode}
          highlightKey={[...highlight].sort().join(",")}
          nodeCount={nodes.length}
        />
      </ReactFlow>
    </div>
  );
}

export function WorkflowGraph(props: Props) {
  return (
    <ReactFlowProvider>
      <GraphInner {...props} />
    </ReactFlowProvider>
  );
}
