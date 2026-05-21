import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const REPO_ROOT = process.cwd();

export function main(): void {
  const args = process.argv.slice(2);
  if (args[0] === "next") {
    try {
      const result = execSync("git log --oneline -1", { cwd: REPO_ROOT, encoding: "utf-8" });
      const match = result.match(/ADR-(\d+)/);
      if (match) {
        const nextNum = parseInt(match[1], 10) + 1;
        console.log(`ADR-${nextNum}`);
      }
    } catch {}
  }
  process.exit(0);
}

if (require.main === module) {
  main();
}