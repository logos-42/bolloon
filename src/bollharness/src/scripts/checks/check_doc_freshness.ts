import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { Finding } from "./finding";

function countRouteDecorators(repoRoot: string): number {
  const routesDir = path.join(repoRoot, "backend", "product", "routes");
  if (!fs.existsSync(routesDir)) return 0;

  let count = 0;
  try {
    const files = fs.readdirSync(routesDir).filter(f => f.endsWith(".py"));
    for (const file of files) {
      const content = fs.readFileSync(path.join(routesDir, file), "utf-8");
      const matches = content.match(/@router\.(get|post|put|patch|delete|websocket)\(/g);
      if (matches) count += matches.length;
    }
  } catch {}
  return count;
}

function countScenes(repoRoot: string): number {
  const scenesDir = path.join(repoRoot, "scenes");
  if (!fs.existsSync(scenesDir)) return 0;
  try {
    return fs.readdirSync(scenesDir).filter(f => {
      const fullPath = path.join(scenesDir, f);
      return fs.statSync(fullPath).isDirectory() && !f.startsWith(".");
    }).length;
  } catch {
    return 0;
  }
}

function countADRs(repoRoot: string): number {
  const decisions = path.join(repoRoot, "docs", "decisions");
  if (!fs.existsSync(decisions)) return 0;
  try {
    return fs.readdirSync(decisions).filter(f => f.startsWith("ADR-") && f.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

function countPlans(repoRoot: string): number {
  const decisions = path.join(repoRoot, "docs", "decisions");
  if (!fs.existsSync(decisions)) return 0;
  try {
    return fs.readdirSync(decisions).filter(f => f.startsWith("PLAN-") && f.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

function extractRoadmapNumbers(repoRoot: string): Record<string, string> {
  const roadmap = path.join(repoRoot, "docs", "ROADMAP.md");
  if (!fs.existsSync(roadmap)) return {};

  const content = fs.readFileSync(roadmap, "utf-8");
  const numbers: Record<string, string> = {};
  const regex = /\|\s*(\S[^|]+?)\s*\|\s*(\S[^|]+?)\s*\|/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const key = match[1].trim();
    const val = match[2].trim();
    if (key !== "指标" && key !== "---") {
      numbers[key] = val;
    }
  }
  return numbers;
}

export function run(repoRoot: string, mode: string = "full"): Finding[] {
  const findings: Finding[] = [];

  const actualRoutes = countRouteDecorators(repoRoot);
  const routesDoc = path.join(repoRoot, ".boll", "rules", "backend-routes.md");
  const claudeMd = path.join(repoRoot, "Bolloon.md");

  if (fs.existsSync(routesDoc)) {
    const routesContent = fs.readFileSync(routesDoc, "utf-8");
    const routeClaims = routesContent.match(/-\s+`(?:GET|POST|PUT|PATCH|DELETE|WS)\s+/g) || [];
    const docRoutes = routeClaims.length;
    if (actualRoutes - docRoutes > 5) {
      findings.push({
        severity: "P1",
        message: `.boll/rules/backend-routes.md documents ${docRoutes} routes but code has ${actualRoutes} decorators (gap: ${actualRoutes - docRoutes})`,
        file: ".boll/rules/backend-routes.md",
        blocking: false,
        category: "doc_integrity",
        problem_class: "unknown",
        required_skills: [],
        required_reads: [],
      });
    }
  }

  const actualADRs = countADRs(repoRoot);
  const actualPlans = countPlans(repoRoot);
  const roadmapNums = extractRoadmapNumbers(repoRoot);

  if ("ADR" in roadmapNums) {
    const match = roadmapNums["ADR"].match(/\d+/);
    if (match) {
      const claimed = parseInt(match[0], 10);
      if (actualADRs - claimed > 2) {
        findings.push({
          severity: "P2",
          message: `ROADMAP claims ${claimed} ADRs but ${actualADRs} exist`,
          file: "docs/ROADMAP.md",
          blocking: false,
          category: "doc_integrity",
          problem_class: "unknown",
          required_skills: [],
          required_reads: [],
        });
      }
    }
  }

  if ("PLAN" in roadmapNums) {
    const match = roadmapNums["PLAN"].match(/\d+/);
    if (match) {
      const claimed = parseInt(match[0], 10);
      if (actualPlans - claimed > 3) {
        findings.push({
          severity: "P2",
          message: `ROADMAP claims ${claimed} PLANs but ${actualPlans} exist`,
          file: "docs/ROADMAP.md",
          blocking: false,
          category: "doc_integrity",
          problem_class: "unknown",
          required_skills: [],
          required_reads: [],
        });
      }
    }
  }

  return findings;
}