import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const runtime = "nodejs";

export async function GET() {
  const root = process.cwd();
  const csv = fs.readFileSync(path.join(root, "sample/companies.csv"), "utf8");
  const workflow = JSON.parse(
    fs.readFileSync(path.join(root, "sample/workflow.json"), "utf8")
  );
  return NextResponse.json({ csv, workflow });
}
