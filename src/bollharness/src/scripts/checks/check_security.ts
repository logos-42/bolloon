import * as fs from "fs";
import * as path from "path";
import { Finding } from "./finding";

const SENSITIVE_PATTERNS = [
  { pattern: /api[_-]?key["\s:=]+["'][a-zA-Z0-9]{20,}["']/gi, severity: "P0" as const },
  { pattern: /password["\s:=]+["'][^"']{8,}["']/gi, severity: "P0" as const },
  { pattern: /secret["\s:=]+["'][a-zA-Z0-9]{16,}["']/gi, severity: "P0" as const },
  { pattern: /token["\s:=]+["'][a-zA-Z0-9]{20,}["']/gi, severity: "P1" as const },
  { pattern: /bearer\s+[a-zA-Z0-9]{20,}/gi, severity: "P1" as const },
];

export function run(repoRoot: string, mode: string = "full"): Finding[] {
  const findings: Finding[] = [];

  if (mode !== "full" && mode !== "ci") return findings;

  const extensions = [".ts", ".tsx", ".js", ".jsx", ".py", ".json", ".yaml", ".yml"];

  function scanDir(dir: string): void {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
          scanDir(fullPath);
        }
      } else if (extensions.includes(path.extname(entry.name))) {
        const content = fs.readFileSync(fullPath, "utf-8");
        for (const { pattern, severity } of SENSITIVE_PATTERNS) {
          const matches = content.match(pattern);
          if (matches) {
            findings.push({
              severity,
              message: `Potential secret detected: ${matches[0].slice(0, 30)}...`,
              file: path.relative(repoRoot, fullPath),
              blocking: severity === "P0",
              category: "security",
              problem_class: "secret_exposure",
              required_skills: [],
              required_reads: [],
            });
          }
        }
      }
    }
  }

  scanDir(repoRoot);

  return findings;
}