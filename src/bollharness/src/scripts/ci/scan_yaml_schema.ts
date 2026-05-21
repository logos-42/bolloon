import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const REPO_ROOT = process.cwd();

export function main(): void {
  console.log("Scanning YAML schemas...");
  process.exit(0);
}

if (require.main === module) {
  main();
}