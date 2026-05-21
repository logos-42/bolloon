import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const REPO_ROOT = process.cwd();
const TRUST_TOKEN_FILE = path.join(REPO_ROOT, ".boll", "install-trust-token.json");

export function main(): void {
  const args = process.argv.slice(2);

  if (args.includes("--install")) {
    const targetProject = args[args.indexOf("--install") + 1];
    if (!targetProject) {
      console.error("Usage: phase2_auto.ts --install <project-path>");
      process.exit(1);
    }
    console.log(`Installing bollharness to ${targetProject}`);
    process.exit(0);
  }

  console.log("bollharness installer");
  console.log("Usage: phase2_auto.ts --install <project-path> [--tier drop-in|adapt|mine]");
  process.exit(0);
}

if (require.main === module) {
  main();
}