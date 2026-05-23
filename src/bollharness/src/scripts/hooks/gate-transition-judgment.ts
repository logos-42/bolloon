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

  const injection = await getGateJudgments(gate, filePath);
  if (injection) {
    process.stdout.write("\n" + injection + "\n");
  }

  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[Gate Transition Judgment] Error:", e);
    process.exit(1);
  });
}
