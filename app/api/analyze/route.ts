import { NextResponse } from "next/server";
import {
  analyze,
  parseCsv,
  parseWorkflow,
  profileCsv,
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
    const result = analyze(workflow, rows, profile);

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
