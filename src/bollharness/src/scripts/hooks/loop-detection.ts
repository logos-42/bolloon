import * as fs from "fs";
import * as path from "path";

const LOOP_THRESHOLD = 5;
const STATE_DIR = ".boll/guard";
const STATE_FILE_PREFIX = "loop-";
const TTL_SECONDS = 3600;

function getStateFile(): string {
  const pid = process.ppid;
  return path.join(STATE_DIR, `${STATE_FILE_PREFIX}${pid}.json`);
}

function loadState(): Record<string, unknown> {
  const stateFile = getStateFile();
  if (!fs.existsSync(stateFile)) return {};

  try {
    const data = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    if (Date.now() / 1000 - (data._ts as number) > TTL_SECONDS) {
      return {};
    }
    return data;
  } catch (exc) {
    process.stderr.write(`[loop-detection] corrupt state ${stateFile}: ${exc}; resetting\n`);
    try {
      fs.unlinkSync(stateFile);
    } catch {}
    return {};
  }
}

function saveState(state: Record<string, unknown>): void {
  try {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
    state._ts = Date.now() / 1000;
    fs.writeFileSync(getStateFile(), JSON.stringify(state), "utf-8");
  } catch (exc) {
    process.stderr.write(`[loop-detection] save_state OSError: ${exc}; counter not persisted\n`);
  }
}

export function postToolUseInject(message: string): void {
  process.stdout.write(`\n\n## Loop Detection\n\n${message}\n`);
}

export function main(): void {
  let event: { tool_name?: string; tool_input?: { file_path?: string } };

  try {
    event = JSON.parse(fs.readFileSync(0, "utf-8") || "{}");
  } catch {
    return;
  }

  const toolName = event.tool_name || "";
  const toolInput = event.tool_input || {};

  if (!["Write", "Edit"].includes(toolName)) return;

  const filePath = toolInput.file_path || "";
  if (!filePath) return;

  const state = loadState();
  const counts = (state.counts as Record<string, number>) || {};
  counts[filePath] = (counts[filePath] || 0) + 1;
  state.counts = counts;
  saveState(state);

  const count = counts[filePath];

  if (count >= LOOP_THRESHOLD) {
    postToolUseInject(
      `[LoopDetection] 你已经编辑 ${filePath} ${count} 次了。考虑换一个方法或退一步重新思考整体方案。[来源: LangChain LoopDetection middleware]`
    );
  }
}

if (require.main === module) {
  main();
}