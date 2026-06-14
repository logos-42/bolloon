import * as fs from "fs";
import * as path from "path";
import { Finding } from "./checks/finding";

export const GUARD_MAP: Record<string, string[]> = {
  "bridge_agent/": ["check_bridge_deps"],
  "backend/product/bridge/": ["check_bridge_deps"],
  "mcp-server/": ["check_mcp_parity"],
  "mcp-server-node/": ["check_mcp_parity"],
  "docs/issues/": ["check_issue_closure"],
  "backend/product/routes/": ["check_doc_freshness"],
  "docs/ROADMAP.md": ["check_doc_freshness"],
  "Bolloon.md": ["check_doc_freshness"],
  "docs/magic/": ["check_doc_freshness"],
  ".boll/rules/backend-routes.md": ["check_doc_freshness"],
  ".boll/settings.json": ["check_hook_installed"],
  ".githooks/": ["check_hook_installed"],
  "scripts/context_router.ts": ["check_fragment_integrity"],
  "scripts/context-fragments/": ["check_fragment_integrity"],
};

export const DEFAULT_GUARDS: string[] = [];

export const CATEGORY_TO_SKILLS: Record<string, string[]> = {
  closure_semantics: ["lead", "boll-ops"],
  contract_drift: ["boll-dev", "boll-eng-test"],
  bridge_boundary: ["boll-bridge", "boll-ops"],
  policy_freeze: ["lead", "arch", "plan-lock"],
  doc_integrity: ["boll-ops"],
  version_drift: ["boll-ops"],
  artifact_linkage: ["lead"],
  governance_bootstrap: ["boll-ops"],
};

const SESSION_TTL_SECONDS = 3600;

export function route(filePath: string): string[] {
  const matched: string[] = [];
  const sortedPatterns = Object.keys(GUARD_MAP).sort((a, b) => b.length - a.length);

  for (const pattern of sortedPatterns) {
    if (filePath.startsWith(pattern) || filePath === pattern.replace(/\/$/, "")) {
      matched.push(...GUARD_MAP[pattern]);
    }
  }

  if (matched.length === 0) {
    return [...DEFAULT_GUARDS];
  }

  return [...new Set(matched)];
}

export async function runGuards(
  filePath: string,
  checksDir: string
): Promise<Finding[]> {
  const guardNames = route(filePath);
  const findings: Finding[] = [];

  for (const name of guardNames) {
    try {
      const checkModule = await import(path.join(checksDir, `${name}.js`));
      if (!checkModule.run) {
        findings.push({
          severity: "P1",
          message: `${name} has no run() function`,
          file: `scripts/checks/${name}.ts`,
          blocking: false,
          category: "governance_bootstrap",
          problem_class: "unknown",
          required_skills: [],
          required_reads: [],
        });
        continue;
      }

      const result = checkModule.run(checksDir, { mode: "full" });
      if (Array.isArray(result)) {
        findings.push(...result);
      } else {
        findings.push(result);
      }
    } catch (exc) {
      findings.push({
        severity: "P0",
        message: `Failed to import guard ${name}: ${exc}`,
        file: `scripts/checks/${name}.ts`,
        blocking: true,
        category: "governance_bootstrap",
        problem_class: "unknown",
        required_skills: [],
        required_reads: [],
      });
    }
  }

  return findings;
}

function getGuardDir(): string {
  return path.join(process.cwd(), ".boll", "guard");
}

export interface SessionSignal {
  pid: number;
  timestamp: number;
  findings: Finding[];
}

export function writeSessionSignal(findings: Finding[]): string {
  const guardDir = getGuardDir();
  if (!fs.existsSync(guardDir)) {
    fs.mkdirSync(guardDir, { recursive: true });
  }

  const pid = process.pid;
  const target = path.join(guardDir, `session-${pid}.json`);
  const tmp = path.join(guardDir, `session-${pid}.tmp`);

  const data: SessionSignal = {
    pid,
    timestamp: Date.now() / 1000,
    findings,
  };

  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, target);
  return target;
}

export interface ReadSignalsResult {
  severity: string | null;
  blocking: boolean;
  required_skills: string[];
  findings: Finding[];
}

export function readAllSignals(pid?: number): ReadSignalsResult {
  const guardDir = getGuardDir();
  if (!fs.existsSync(guardDir)) {
    return { severity: null, blocking: false, required_skills: [], findings: [] };
  }

  const severityOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
  const now = Date.now() / 1000;

  const allFindings: Finding[] = [];
  let maxSeverity: string | null = null;
  let blocking = false;
  const skills = new Set<string>();

  let paths: string[];
  if (pid !== undefined) {
    paths = [path.join(guardDir, `session-${pid}.json`)];
  } else {
    paths = fs.readdirSync(guardDir)
      .filter(f => f.startsWith("session-") && f.endsWith(".json"))
      .map(f => path.join(guardDir, f));
  }

  for (const p of paths) {
    if (!fs.existsSync(p)) continue;

    try {
      const data: SessionSignal = JSON.parse(fs.readFileSync(p, "utf-8"));

      const ts = data.timestamp;
      if (now - ts > SESSION_TTL_SECONDS) {
        try {
          fs.unlinkSync(p);
        } catch {}
        continue;
      }

      for (const f of data.findings) {
        allFindings.push(f);
        const sev = f.severity;
        if (maxSeverity === null || severityOrder[sev] < severityOrder[maxSeverity]) {
          maxSeverity = sev;
        }
        if (f.blocking) blocking = true;
        f.required_skills.forEach(s => skills.add(s));
      }
    } catch {}
  }

  return {
    severity: maxSeverity,
    blocking,
    required_skills: Array.from(skills).sort(),
    findings: allFindings,
  };
}