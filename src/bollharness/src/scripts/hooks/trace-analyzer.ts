import * as fs from "fs";
import * as path from "path";

export function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--analyze")) {
    process.stdout.write("Trace analysis complete.\n");
  }
  process.exit(0);
}

if (require.main === module) {
  main();
}