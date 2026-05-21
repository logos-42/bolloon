import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = process.cwd();

export function main(): void {
  process.exit(0);
}

if (require.main === module) {
  main();
}