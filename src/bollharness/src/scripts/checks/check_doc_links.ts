import * as fs from "fs";
import * as path from "path";
import { Finding } from "./finding";

export function run(repoRoot: string, mode: string = "full"): Finding[] {
  const findings: Finding[] = [];

  const docFiles = ["Bolloon.md", "docs/ROADMAP.md", "README.md"];
  const maxAgeDays = 7;

  for (const docFile of docFiles) {
    const fullPath = path.join(repoRoot, docFile);
    if (!fs.existsSync(fullPath)) continue;

    try {
      const stats = fs.statSync(fullPath);
      const ageMs = Date.now() - stats.mtimeMs;
      const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

      if (ageDays > maxAgeDays) {
        findings.push({
          severity: "P2",
          message: `${docFile} has not been updated in ${ageDays} days (threshold: ${maxAgeDays})`,
          file: docFile,
          blocking: false,
          category: "doc_freshness",
          problem_class: "unknown",
          required_skills: [],
          required_reads: [],
        });
      }
    } catch {}
  }

  return findings;
}