import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = process.cwd();

interface GateState {
  current_gate: number;
}

function getCurrentGate(): number {
  const envGate = process.env.BOLL_GATE_TO;
  if (envGate) {
    return parseInt(envGate, 10);
  }

  try {
    const gateFile = path.join(REPO_ROOT, ".boll", "gate", "current");
    if (fs.existsSync(gateFile)) {
      const content = fs.readFileSync(gateFile, "utf-8").trim();
      const state = JSON.parse(content) as GateState;
      return state.current_gate;
    }
  } catch {}

  const envGateFinal = process.env.BOLL_GATE;
  if (envGateFinal) {
    return parseInt(envGateFinal, 10);
  }

  return 0;
}

async function getCoreJudgments(): Promise<string> {
  try {
    const judgmentPath = path.join(REPO_ROOT, "src", "bollharness-integration", "context-router-judgment.js");
    if (!fs.existsSync(judgmentPath)) {
      return "";
    }

    const { getCoreJudgmentsForSession } = await import(judgmentPath);
    return await getCoreJudgmentsForSession(0.9);
  } catch (e) {
    console.error("[Gate Judgment] Failed to load core judgments:", e);
    return "";
  }
}

async function getGateJudgments(gate: number): Promise<string> {
  try {
    const judgmentPath = path.join(REPO_ROOT, "src", "bollharness-integration", "context-router-judgment.js");
    if (!fs.existsSync(judgmentPath)) {
      return "";
    }

    const { generateJudgmentInjection } = await import(judgmentPath);
    return await generateJudgmentInjection(".", gate);
  } catch (e) {
    console.error("[Gate Judgment] Failed to load gate judgments:", e);
    return "";
  }
}

async function getContextChainInjection(gate: number): Promise<string> {
  try {
    const chainPath = path.join(REPO_ROOT, "src", "bollharness-integration", "context-chain-router.js");
    if (!fs.existsSync(chainPath)) {
      return "";
    }

    const { generateContextChainInjection } = await import(chainPath);
    return await generateContextChainInjection(gate);
  } catch (e) {
    console.error("[Gate Judgment] Failed to load context chains:", e);
    return "";
  }
}

export async function main(): Promise<void> {
  const gate = getCurrentGate();

  const INJECT_GATES = [0, 3];

  if (!INJECT_GATES.includes(gate)) {
    process.exit(0);
  }

  const judgments = gate === 0
    ? await getCoreJudgments()
    : await getGateJudgments(gate);

  const chains = await getContextChainInjection(gate);

  if (judgments || chains) {
    process.stdout.write("\n");
    if (judgments) {
      process.stdout.write(judgments + "\n\n");
    }
    if (chains) {
      process.stdout.write(chains + "\n");
    }
  }

  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[Gate Judgment] Error:", e);
    process.exit(1);
  });
}
