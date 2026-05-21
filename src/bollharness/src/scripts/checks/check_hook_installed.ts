import * as fs from "fs";
import * as path from "path";
import { Finding } from "./finding";

export function run(repoRoot: string, mode: string = "full"): Finding[] {
  const findings: Finding[] = [];

  const hookFiles = [
    "src/scripts/hooks/loop-detection.ts",
    "src/scripts/hooks/risk-tracker.ts",
    "src/scripts/hooks/stop-evaluator.ts",
    "src/scripts/hooks/guard-feedback.ts",
    "src/scripts/hooks/deploy-guard.ts",
  ];

  const settingsFile = path.join(repoRoot, ".boll", "settings.json");

  if (!fs.existsSync(settingsFile)) {
    findings.push({
      severity: "P1",
      message: ".boll/settings.json does not exist",
      file: ".boll/settings.json",
      blocking: false,
      category: "general",
      problem_class: "unknown",
      required_skills: [],
      required_reads: [],
    });
    return findings;
  }

  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
    const registeredHooks = settings.hooks || {};

    for (const [stage, hooks] of Object.entries(registeredHooks)) {
      const hookList = hooks as Array<{ hooks?: Array<{ command?: string }> }>;
      for (const hookGroup of hookList) {
        for (const hook of hookGroup.hooks || []) {
          const cmd = hook.command || "";
          if (cmd.includes("python3") && cmd.includes(".py")) {
            findings.push({
              severity: "P1",
              message: `Hook in ${stage} still references Python script: ${cmd}`,
              file: ".boll/settings.json",
              blocking: false,
              category: "governance_bootstrap",
              problem_class: "unknown",
              required_skills: [],
              required_reads: [],
            });
          }
        }
      }
    }
  } catch (exc) {
    findings.push({
      severity: "P1",
      message: `Failed to parse settings.json: ${exc}`,
      file: ".boll/settings.json",
      blocking: false,
      category: "governance_bootstrap",
      problem_class: "unknown",
      required_skills: [],
      required_reads: [],
    });
  }

  return findings;
}