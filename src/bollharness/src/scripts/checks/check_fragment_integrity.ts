import * as fs from "fs";
import * as path from "path";
import { Finding } from "./finding";

export function run(repoRoot: string, mode: string = "full"): Finding[] {
  const findings: Finding[] = [];

  const fragmentDir = path.join(repoRoot, "scripts", "context-fragments");
  const routerFile = path.join(repoRoot, "src", "scripts", "context_router.ts");

  if (!fs.existsSync(routerFile)) {
    findings.push({
      severity: "P1",
      message: "context_router.ts not found",
      file: "src/scripts/context_router.ts",
      blocking: false,
      category: "governance_bootstrap",
      problem_class: "unknown",
      required_skills: [],
      required_reads: [],
    });
    return findings;
  }

  if (!fs.existsSync(fragmentDir)) {
    findings.push({
      severity: "P2",
      message: "context-fragments directory not found",
      file: "scripts/context-fragments/",
      blocking: false,
      category: "governance_bootstrap",
      problem_class: "unknown",
      required_skills: [],
      required_reads: [],
    });
    return findings;
  }

  return findings;
}