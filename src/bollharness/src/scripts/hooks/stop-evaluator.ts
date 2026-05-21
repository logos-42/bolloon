import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const REPO_ROOT = process.cwd();
const EVALUATOR_MD = path.join(REPO_ROOT, "scripts", "hooks", "stop-evaluator.md");
const INITIALIZER_AGENT = path.join(REPO_ROOT, "src", "scripts", "hooks", "initializer-agent.ts");
const STATE_DIR = path.join(REPO_ROOT, ".boll", "guard");
const METRICS_DIR = path.join(REPO_ROOT, ".boll", "metrics");
const TTL_SECONDS = 3600;

const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

function emitMetric(event: string, sessionKey: string, data: Record<string, unknown> = {}): void {
  try {
    if (!fs.existsSync(METRICS_DIR)) {
      fs.mkdirSync(METRICS_DIR, { recursive: true });
    }
    const record = {
      ts: new Date().toISOString(),
      session_key: sessionKey,
      event,
      ...data,
    };
    fs.appendFileSync(
      path.join(METRICS_DIR, "stop-events.jsonl"),
      JSON.stringify(record) + "\n",
      "utf-8"
    );
  } catch {}
}

function readHookPayload(): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(0, "utf-8");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function getSessionKey(payload: Record<string, unknown>): string {
  const sid = payload.session_id;
  if (typeof sid === "string" && sid) return sid;
  return `ppid-${process.ppid}`;
}

function getStateFile(sessionKey: string): string {
  const safe = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return path.join(STATE_DIR, `stop-${safe}.flag`);
}

function alreadyBlocked(sessionKey: string): boolean {
  const stateFile = getStateFile(sessionKey);
  if (!fs.existsSync(stateFile)) return false;
  try {
    const ts = parseFloat(fs.readFileSync(stateFile, "utf-8").trim());
    return Date.now() / 1000 - ts < TTL_SECONDS;
  } catch {
    return false;
  }
}

function markBlocked(sessionKey: string): void {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
  fs.writeFileSync(getStateFile(sessionKey), String(Date.now() / 1000), "utf-8");
}

function extractEditedFiles(transcriptPath: string): Set<string> | null {
  if (!transcriptPath) return null;
  try {
    const files = new Set<string>();
    const content = fs.readFileSync(transcriptPath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        const msg = rec.message || {};
        if (msg.role !== "assistant") continue;
        const blocks = msg.content || [];
        for (const block of blocks) {
          if (block.type === "tool_use" && WRITE_TOOLS.has(block.name)) {
            const fp = block.input?.file_path;
            if (fp) {
              try {
                files.add(path.relative(REPO_ROOT, fp));
              } catch {}
            }
          }
        }
      } catch {}
    }
    return files;
  } catch {
    return null;
  }
}

function isCompletionCandidate(transcriptPath: string): [boolean, string] {
  const sessionFiles = extractEditedFiles(transcriptPath);
  if (sessionFiles === null) return [true, "transcript_unreadable_failopen"];
  if (sessionFiles.size === 0) return [false, "no_session_writes"];

  let gitDirty: Set<string> = new Set();
  try {
    const result = execSync("git diff --name-only", { cwd: REPO_ROOT, encoding: "utf-8", timeout: 5000 });
    if (result.trim()) {
      gitDirty = new Set(result.trim().split("\n").filter(l => l));
    }
  } catch {}

  const uncommitted = new Set([...sessionFiles].filter(f => gitDirty.has(f)));
  if (uncommitted.size > 0) return [true, "uncommitted_session_changes"];

  try {
    const result = execSync("git diff --cached --name-only", { cwd: REPO_ROOT, encoding: "utf-8", timeout: 5000 });
    if (result.trim()) return [true, "staged_changes"];
  } catch {}

  return [false, "all_committed"];
}

export function main(): void {
  const payload = readHookPayload();
  const sessionKey = getSessionKey(payload);

  if (payload.stop_hook_active === true) {
    emitMetric("stop_pass", sessionKey, { reason: "stop_hook_active_guard" });
    process.exit(0);
  }

  if (alreadyBlocked(sessionKey)) {
    emitMetric("stop_pass", sessionKey, { reason: "already_blocked_once" });
    process.exit(0);
  }

  const isCandidate = isCompletionCandidate((payload.transcript_path as string) || "");
  if (!isCandidate[0]) {
    emitMetric("stop_pass", sessionKey, { reason: isCandidate[1] });
    process.exit(0);
  }

  if (!fs.existsSync(EVALUATOR_MD)) {
    emitMetric("stop_skip", sessionKey, { reason: "evaluator_md_missing" });
    process.exit(0);
  }

  try {
    const checklist = fs.readFileSync(EVALUATOR_MD, "utf-8");
    process.stderr.write(checklist + "\n");
    markBlocked(sessionKey);
    emitMetric("stop_block", sessionKey, { reason: `completion_candidate_${isCandidate[1]}` });
    process.exit(2);
  } catch {
    emitMetric("stop_skip", sessionKey, { reason: "evaluator_md_read_error" });
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}