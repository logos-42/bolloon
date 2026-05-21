import * as fs from "fs";
import * as path from "path";
import { Finding } from "./finding";

export function run(repoRoot: string, mode: string = "full"): Finding[] {
  const findings: Finding[] = [];

  const docsIssuesDir = path.join(repoRoot, "docs", "issues");

  if (!fs.existsSync(docsIssuesDir)) {
    return findings;
  }

  const issueFiles = fs.readdirSync(docsIssuesDir).filter(f => f.endsWith(".md"));

  for (const issueFile of issueFiles) {
    const issuePath = path.join(docsIssuesDir, issueFile);
    const content = fs.readFileSync(issuePath, "utf-8");

    const hasStatus = /^(status|State):\s*/im.test(content);
    const hasResolution = /^(resolution|Closed):\s*/im.test(content);

    if (!hasStatus) {
      findings.push({
        severity: "P2",
        message: `Issue ${issueFile} missing status field`,
        file: `docs/issues/${issueFile}`,
        blocking: false,
        category: "doc_integrity",
        problem_class: "unknown",
        required_skills: [],
        required_reads: [],
      });
    }

    if (!hasResolution) {
      findings.push({
        severity: "P2",
        message: `Issue ${issueFile} missing resolution/closed field`,
        file: `docs/issues/${issueFile}`,
        blocking: false,
        category: "doc_integrity",
        problem_class: "unknown",
        required_skills: [],
        required_reads: [],
      });
    }
  }

  return findings;
}