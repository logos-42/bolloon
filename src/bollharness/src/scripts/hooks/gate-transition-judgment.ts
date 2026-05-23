import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = process.cwd();

async function getGateJudgments(gate: number, filePath = "."): Promise<string> {
  try {
    const judgmentPath = path.join(REPO_ROOT, "src", "bollharness-integration", "context-router-judgment.js");
    if (!fs.existsSync(judgmentPath)) {
      return "";
    }

    const { generateJudgmentInjection } = await import(judgmentPath);
    return await generateJudgmentInjection(filePath, gate);
  } catch (e) {
    console.error("[Gate Transition Judgment] Failed to load judgments:", e);
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
    console.error("[Gate Transition Judgment] Failed to load context chains:", e);
    return "";
  }
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const envGate = process.env.BOLL_GATE_TO;
  const gate = args[0]
    ? parseInt(args[0], 10)
    : envGate
      ? parseInt(envGate, 10)
      : 0;
  const filePath = args[1] || ".";

  const INJECT_GATES = [0, 3];

  if (!INJECT_GATES.includes(gate)) {
    process.exit(0);
  }

  const judgments = await getGateJudgments(gate, filePath);
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
    console.error("[Gate Transition Judgment] Error:", e);
    process.exit(1);
  });
}
