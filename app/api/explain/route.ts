import { NextResponse } from "next/server";
import type { AnalysisResult, Finding } from "@/lib/engine";
import { fmtNum, fmtUsd } from "@/lib/utils";

export const runtime = "nodejs";

function templateExplain(result: AnalysisResult): string {
  const m = result.metrics;
  const lines: string[] = [];
  lines.push(
    `This workflow uses about ${fmtNum(m.actionsUsed)} Actions and ${fmtNum(m.dataCreditsUsed)} Data Credits (~${fmtUsd(m.usdPerRun)}/run). Potential overlapping waste (R1–R3): ${fmtNum(m.wasteActions)} Actions and ${fmtNum(m.wasteDataCredits)} Data Credits.`
  );
  lines.push("");
  for (const f of result.findings) {
    lines.push(formatFinding(f));
  }
  lines.push("");
  lines.push(
    "Blank cells are not scored as paid failures — Clay exports “run condition not met” as blank, and refunds also look blank. Numbers above come only from the deterministic engine."
  );
  return lines.join("\n");
}

function formatFinding(f: Finding): string {
  return `• [${f.rule}] ${f.title}: ${f.summary} Savings ≈ ${fmtNum(f.savingsActions)} Actions / ${fmtNum(f.savingsDataCredits)} Data Credits (${fmtUsd(f.savingsUsd)}).`;
}

async function llmExplain(result: AnalysisResult): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You narrate Clay workflow health findings. HARD RULE: only restate numbers present in the JSON. Never invent savings, costs, or hit rates. Keep under 220 words. Mention Actions and Data Credits as separate meters.",
          },
          {
            role: "user",
            content: JSON.stringify({
              metrics: result.metrics,
              findings: result.findings,
            }),
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    return typeof text === "string" ? text.trim() : null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const result = body.result as AnalysisResult;
    if (!result?.metrics || !Array.isArray(result.findings)) {
      return NextResponse.json({ error: "result findings JSON required" }, { status: 400 });
    }
    const templated = templateExplain(result);
    const llm = await llmExplain(result);
    return NextResponse.json({
      ok: true,
      source: llm ? "llm" : "template",
      explanation: llm ?? templated,
      templated,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Explain failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
