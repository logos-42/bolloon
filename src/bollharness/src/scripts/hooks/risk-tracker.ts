import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = process.cwd();
const STATE_FILE = path.join(REPO_ROOT, ".boll", "state", "risk-snapshot.json");

const RISK_ORDER: Record<string, number> = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4 };

const RISK_ELEVATORS: [string, string][] = [
  ["scripts/deploy", "R4"],
  ["backend/product/db/migration", "R4"],
  ["Bolloon.md", "R3"],
  [".boll/settings.json", "R3"],
  [".boll/skills/", "R3"],
  [".boll/rules/", "R3"],
  [".boll/agents/", "R3"],
  ["scripts/hooks/", "R3"],
  ["scripts/checks/", "R3"],
  [".github/", "R3"],
  ["backend/product/routes/", "R2"],
  ["backend/product/config.py", "R2"],
  ["backend/server.py", "R2"],
  ["docs/decisions/ADR-", "R2"],
  ["mcp-server/", "R2"],
  ["mcp-server-node/", "R2"],
  ["website/app/", "R2"],
];

function readPayload(): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(0, "utf-8");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function loadSnapshot(): Record<string, unknown> {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    } catch {}
  }
  return {
    risk_level: "R0",
    risk_sources: [],
    ratchet_locked: false,
    files_touched: [],
  };
}

function saveSnapshot(snap: Record<string, unknown>): void {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(snap, null, 2) + "\n", "utf-8");
}

function classifyFile(filePath: string): string {
  for (const [pattern, risk] of RISK_ELEVATORS) {
    if (filePath.startsWith(pattern)) return risk;
  }
  return "R0";
}

export function main(): void {
  const payload = readPayload();
  const toolInput = payload.tool_input as Record<string, string> || {};
  const filePath = toolInput.file_path || "";

  if (!filePath) return;

  let relPath: string;
  try {
    relPath = path.relative(REPO_ROOT, filePath);
  } catch {
    relPath = filePath;
  }

  const fileRisk = classifyFile(relPath);
  const snap = loadSnapshot();
  const currentLevel = (snap.risk_level as string) || "R0";
  const currentOrder = RISK_ORDER[currentLevel] ?? 0;
  const newOrder = RISK_ORDER[fileRisk] ?? 0;

  const filesTouched = (snap.files_touched as string[]) || [];
  if (!filesTouched.includes(relPath)) {
    filesTouched.push(relPath);
  }

  let finalRisk = fileRisk;
  let finalOrder = newOrder;

  if (filesTouched.length >= 4 && currentOrder < RISK_ORDER.R1) {
    finalRisk = "R1";
    finalOrder = RISK_ORDER.R1;
  }

  if (finalOrder > currentOrder) {
    snap.risk_level = finalRisk;
    snap.ratchet_locked = true;
    const sources = (snap.risk_sources as unknown[]) || [];
    sources.push({
      type: "path",
      value: relPath,
      elevated_to: finalRisk,
      ts: new Date().toISOString(),
    });
    snap.risk_sources = sources;
  }

  snap.files_touched = filesTouched;
  snap.last_updated = new Date().toISOString();

  saveSnapshot(snap);
}

if (require.main === module) {
  main();
}