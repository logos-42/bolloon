import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = process.cwd();
const REGISTRY_FILE = path.join(REPO_ROOT, ".boll", "install-log.jsonl");

export function main(): void {
  process.exit(0);
}

if (require.main === module) {
  main();
}