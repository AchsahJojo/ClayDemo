import { NextResponse } from "next/server";
import { DEFAULT_PRICES } from "@/lib/costs";
import {
  analyze,
  DEFAULT_ICP_RULE,
  parseCsv,
  parseWorkflow,
  profileCsv,
  type AnalyzeOptions,
  type IcpRule,
} from "@/lib/engine";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const csvText = String(body.csv ?? "");
    const workflowRaw = body.workflow;
    if (!csvText.trim()) {
      return NextResponse.json({ error: "CSV is required" }, { status: 400 });
    }
    if (!workflowRaw) {
      return NextResponse.json({ error: "workflow JSON is required" }, { status: 400 });
    }

    const workflow = parseWorkflow(
      typeof workflowRaw === "string" ? JSON.parse(workflowRaw) : workflowRaw
    );
    const rows = parseCsv(csvText);
    const profile = profileCsv(rows, workflow);

    const icpIn = body.icpRule as Partial<IcpRule> | undefined;
    const icpRule: IcpRule = {
      column: String(icpIn?.column ?? DEFAULT_ICP_RULE.column),
      min: Number(icpIn?.min ?? DEFAULT_ICP_RULE.min),
      max: Number(icpIn?.max ?? DEFAULT_ICP_RULE.max),
      preferPassColumn:
        icpIn?.preferPassColumn === null
          ? undefined
          : String(icpIn?.preferPassColumn ?? DEFAULT_ICP_RULE.preferPassColumn ?? ""),
    };
    if (!icpRule.preferPassColumn) delete icpRule.preferPassColumn;

    const prices = {
      actionUsd: Number(body.prices?.actionUsd ?? DEFAULT_PRICES.actionUsd),
      dataCreditUsd: Number(body.prices?.dataCreditUsd ?? DEFAULT_PRICES.dataCreditUsd),
    };

    const options: AnalyzeOptions = {
      icpRule,
      prices,
      icpGoal: body.icpGoal ? String(body.icpGoal) : undefined,
      workflowDescription: body.workflowDescription
        ? String(body.workflowDescription)
        : undefined,
    };

    const result = analyze(workflow, rows, profile, options);

    return NextResponse.json({
      ok: true,
      workflowName: workflow.name,
      rowCount: rows.length,
      result,
      engineJson: result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Analyze failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
