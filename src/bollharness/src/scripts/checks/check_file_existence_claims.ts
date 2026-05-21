import * as fs from "fs";
import * as path from "path";
import { Finding } from "./finding";

export function run(repoRoot: string, mode: string = "full"): Finding[] {
  const findings: Finding[] = [];

  if (mode !== "full" && mode !== "staged") return findings;

  return findings;
}