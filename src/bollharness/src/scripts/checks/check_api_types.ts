import * as fs from "fs";
import * as path from "path";
import { Finding } from "./finding";

export function run(repoRoot: string, mode: string = "full"): Finding[] {
  const findings: Finding[] = [];

  const tsFile = path.join(repoRoot, "generated", "api-types.ts");
  if (!fs.existsSync(tsFile)) {
    findings.push({
      severity: "P1",
      message: "generated/api-types.ts does not exist — run scripts/export_api_types.py",
      file: "generated/api-types.ts",
      blocking: false,
      category: "general",
      problem_class: "unknown",
      required_skills: [],
      required_reads: [],
    });
    return findings;
  }

  const content = fs.readFileSync(tsFile, "utf-8");
  const interfaceMatch = content.match(/export interface (\w+) \{/g);

  if (!interfaceMatch) {
    findings.push({
      severity: "P1",
      message: "generated/api-types.ts contains no interfaces",
      file: "generated/api-types.ts",
      blocking: false,
      category: "general",
      problem_class: "unknown",
      required_skills: [],
      required_reads: [],
    });
    return findings;
  }

  findings.push({
    severity: "P2",
    message: "API type checking requires backend model comparison (Python 3.10+ backend not available in TypeScript check)",
    file: "generated/api-types.ts",
    blocking: false,
    category: "general",
    problem_class: "unknown",
    required_skills: [],
    required_reads: [],
  });

  return findings;
}