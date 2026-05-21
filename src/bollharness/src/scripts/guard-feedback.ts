import * as fs from "fs";
import * as path from "path";
import { match, loadFragment, FALLBACK_FRAGMENTS } from "./context_router";
import { readAllSignals, runGuards, writeSessionSignal } from "./guard_router";
import { Finding } from "./checks/finding";

const INJECTED_TTL = 3600;
const INJECTED_FILE = path.join(process.cwd(), ".boll", "guard", "injected.json");
const METRICS_DIR = path.join(process.cwd(), ".boll", "metrics");
const METRICS_FILE = path.join(METRICS_DIR, "guard-events.jsonl");

function emitMetric(event: string, data: Record<string, unknown> = {}): void {
  try {
    if (!fs.existsSync(METRICS_DIR)) {
      fs.mkdirSync(METRICS_DIR, { recursive: true });
    }
    const record = {
      ts: new Date().toISOString(),
      session_pid: process.ppid,
      event,
      ...data,
    };
    fs.appendFileSync(METRICS_FILE, JSON.stringify(record) + "\n", "utf-8");
  } catch {}
}

function readInjected(): Set<string> {
  if (!fs.existsSync(INJECTED_FILE)) return new Set();
  try {
    const data = JSON.parse(fs.readFileSync(INJECTED_FILE, "utf-8"));
    if (Date.now() / 1000 - data.timestamp > INJECTED_TTL) return new Set();
    return new Set(data.fragments || []);
  } catch {
    return new Set();
  }
}

function writeInjected(fragments: Set<string>): void {
  const guardDir = path.join(process.cwd(), ".boll", "guard");
  if (!fs.existsSync(guardDir)) {
    fs.mkdirSync(guardDir, { recursive: true });
  }
  const data = { timestamp: Date.now() / 1000, fragments: Array.from(fragments).sort() };
  fs.writeFileSync(INJECTED_FILE, JSON.stringify(data, null, 2), "utf-8");
}

function getFilePath(): string | null {
  if (process.argv.includes("--dry-run")) {
    const idx = process.argv.indexOf("--dry-run");
    if (idx + 1 < process.argv.length) {
      return process.argv[idx + 1];
    }
    return null;
  }

  try {
    const input = JSON.parse(fs.readFileSync(0, "utf-8"));
    return input.tool_input?.file_path ?? input.tool_input?.path ?? null;
  } catch {
    return null;
  }
}

function makeRelative(filePath: string, repoRoot: string): string | null {
  try {
    const resolved = path.resolve(filePath);
    return path.relative(repoRoot, resolved);
  } catch {
    return null;
  }
}

function appendFindings(outputParts: string[], findings: Finding[]): void {
  outputParts.push("\n\n## Guard Findings\n");
  for (const raw of findings) {
    const f = raw;
    const blockingTag = f.blocking ? " [blocking]" : "";
    const skills = f.required_skills.join(", ");
    const skillsLine = skills ? `\n  required_skills: ${skills}` : "";
    outputParts.push(
      `- ${f.severity}${blockingTag} ${f.category}: ${f.message}${skillsLine}`
    );
  }
}

const REPO_ROOT = process.cwd();
const checksDir = path.join(REPO_ROOT, "src", "scripts", "checks");

export async function main(): Promise<void> {
  const startMs = Date.now();
  const checkOnly = process.argv.includes("--check-only");
  const once = process.argv.includes("--once");
  const dryRun = process.argv.includes("--dry-run");

  emitMetric("hook_trigger", {
    mode: checkOnly ? "check_only" : "post_tool_use",
    once,
    dry_run: dryRun,
  });

  if (once) {
    const guardDir = path.join(process.cwd(), ".boll", "guard");
    const sessionFile = path.join(guardDir, `once-${process.pid}.flag`);
    if (fs.existsSync(sessionFile)) {
      try {
        const ts = parseFloat(fs.readFileSync(sessionFile, "utf-8").trim());
        if (Date.now() / 1000 - ts < 3600) {
          process.exit(0);
        }
      } catch {}
    }
    if (!fs.existsSync(guardDir)) {
      fs.mkdirSync(guardDir, { recursive: true });
    }
    fs.writeFileSync(sessionFile, String(Date.now() / 1000), "utf-8");
  }

  const outputParts: string[] = [];

  if (checkOnly) {
    const signal = readAllSignals(process.pid);
    const findings = signal.findings;
    if (findings.length) {
      appendFindings(outputParts, findings);
      process.stderr.write(outputParts.join("\n") + "\n");
      emitMetric("check_only_findings", {
        findings_count: findings.length,
        elapsed_ms: Date.now() - startMs,
      });
      process.exit(0);
    }
    process.exit(0);
  }

  let filePath = getFilePath();
  if (!filePath) process.exit(0);

  filePath = makeRelative(filePath, REPO_ROOT);
  if (!filePath) {
    emitMetric("path_rejected", { reason: "outside_repo_or_unresolvable" });
    process.exit(0);
  }

  const alreadyInjected = readInjected();

  let fragments = match(filePath);
  if (!fragments.length) {
    fragments = Array.isArray(FALLBACK_FRAGMENTS) ? FALLBACK_FRAGMENTS : [FALLBACK_FRAGMENTS];
  }

  const newFragments = fragments.filter(f => !alreadyInjected.has(f));

  const contentParts: string[] = [];
  for (const name of newFragments) {
    const text = loadFragment(name);
    if (text) contentParts.push(text);
  }

  if (newFragments.length) {
    const totalBytes = contentParts.reduce((sum, p) => sum + Buffer.byteLength(p, "utf-8"), 0);
    emitMetric("fragment_inject", {
      file_path: filePath,
      fragments: newFragments,
      count: newFragments.length,
      bytes: totalBytes,
      est_tokens: Math.ceil(totalBytes / 4),
    });
  }

  if (contentParts.length) {
    outputParts.push("## Context\n");
    outputParts.push(contentParts.join("\n\n---\n\n"));
    newFragments.forEach(f => alreadyInjected.add(f));
    writeInjected(alreadyInjected);
  }

  const findings = await runGuards(filePath, checksDir);

  if (findings.length) {
    const blockingCount = findings.filter(f => f.blocking).length;
    const categories: Record<string, number> = {};
    const severities: Record<string, number> = {};
    for (const f of findings) {
      categories[f.category] = (categories[f.category] || 0) + 1;
      severities[f.severity] = (severities[f.severity] || 0) + 1;
    }
    emitMetric("guard_findings", {
      file_path: filePath,
      findings_count: findings.length,
      blocking_count: blockingCount,
      categories,
      severities,
    });

    writeSessionSignal(findings);
    appendFindings(outputParts, findings);
  }

  emitMetric("hook_done", {
    file_path: filePath,
    had_output: outputParts.length > 0,
    elapsed_ms: Date.now() - startMs,
  });

  if (outputParts.length) {
    process.stderr.write(outputParts.join("\n") + "\n");
    process.exit(2);
  }

  process.exit(0);
}

if (require.main === module) {
  main();
}