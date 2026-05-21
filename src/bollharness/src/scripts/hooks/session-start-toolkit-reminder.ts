import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = process.cwd();

export function main(): void {
  process.stdout.write("Session start toolkit reminder.\n");
}

if (require.main === module) {
  main();
}