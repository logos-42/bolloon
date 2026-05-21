import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { Finding } from "./finding";

const CODE_EXTENSIONS = new Set([".py", ".ts", ".tsx", ".js", ".jsx"]);
const CONFIG_EXTENSIONS = new Set([".json", ".yml", ".yaml", ".toml"]);
const TEST_PREFIXES = ["tests/", "test_"];
const ARTIFACT_PREFIXES = ["docs/issues/", "docs/decisions/"];
const BUILD_DIRS = new Set([".open-next", "dist", "build", ".next", "node_modules"]);

function isCodeFile(filePath: string): boolean {
  const p = path.parse(filePath);
  if (!CODE_EXTENSIONS.has(p.ext)) return false;
  const parts = p.dir.split(path.sep);
  for (const part of parts) {
    if (part.startsWith("test_") || part === "tests") return false;
  }
  for (const part of parts) {
    if (BUILD_DIRS.has(part)) return false;
  }
  return true;
}

function isArtifactFile(filePath: string): boolean {
  return ARTIFACT_PREFIXES.some(prefix => filePath.startsWith(prefix)) && filePath.endsWith(".md");
}

function extractScope(artifactPath: string): string[] {
  try {
    const text = fs.readFileSync(artifactPath, "utf-8");
    if (!text.startsWith("---")) return [];

    const end = text.indexOf("\n---", 3);
    if (end === -1) return [];

    const frontmatter = text.slice(3, end);
    const scopes: string[] = [];
    let inScope = false;

    for (const line of frontmatter.split("\n")) {
      const stripped = line.trim();
      if (stripped.startsWith("scope:")) {
        const value = stripped.slice(6).trim();
        if (value && !value.startsWith("[")) {
          scopes.push(value);
          inScope = false;
        } else if (value.startsWith("[")) {
          const inner = value.replace(/[\[\] ]/g, "");
          scopes.push(...inner.split(",").filter(s => s));
          inScope = false;
        } else {
          inScope = true;
        }
        continue;
      }
      if (inScope) {
        if (stripped.startsWith("- ")) {
          scopes.push(stripped.slice(2).trim().replace(/^["']|["']$/g, ""));
        } else if (stripped && !stripped.startsWith("#")) {
          inScope = false;
        }
      }
    }

    return scopes.filter(s => s);
  } catch {
    return [];
  }
}

function checkScopeBinding(
  codeFiles: string[],
  artifactFiles: string[],
  repoRoot: string
): Finding[] {
  const allScopes: string[] = [];
  for (const af of artifactFiles) {
    allScopes.push(...extractScope(path.join(repoRoot, af)));
  }

  if (allScopes.length === 0) return [];

  const uncovered: string[] = [];
  for (const cf of codeFiles) {
    if (!allScopes.some(scope => cf.startsWith(scope))) {
      uncovered.push(cf);
    }
  }

  if (uncovered.length === 0) return [];

  return [{
    severity: "P2",
    message: `Scope binding gap: ${uncovered.length} code file(s) not covered by any artifact scope. Uncovered: ${uncovered.slice(0, 5).join(", ")}${uncovered.length > 5 ? ` (and ${uncovered.length - 5} more)` : ""}. Add a scope field to the relevant artifact doc.`,
    file: uncovered[0],
    blocking: false,
    category: "scope_binding",
    problem_class: "unknown",
    required_skills: ["lead"],
    required_reads: [],
  }];
}

function getChangedFiles(mode: string, repoRoot: string): string[] {
  if (mode === "staged") {
    try {
      const result = execSync("git diff --cached --name-only", { cwd: repoRoot, encoding: "utf-8" });
      return result.split("\n").map(l => l.trim()).filter(l => l);
    } catch {
      return [];
    }
  } else if (mode === "ci") {
    try {
      const result = execSync("git diff origin/main..HEAD --name-only", { cwd: repoRoot, encoding: "utf-8" });
      return result.split("\n").map(l => l.trim()).filter(l => l);
    } catch {
      return [];
    }
  }
  return [];
}

export function run(repoRoot: string, mode: string = "full"): Finding[] {
  if (mode === "full") return [];

  const files = getChangedFiles(mode, repoRoot);
  if (!files.length) return [];

  const codeFiles = files.filter(f => isCodeFile(f));
  const artifactFiles = files.filter(f => isArtifactFile(f));
  const hasCode = codeFiles.length > 0;
  const hasArtifact = artifactFiles.length > 0;

  const findings: Finding[] = [];

  if (hasCode && !hasArtifact) {
    findings.push({
      severity: "P1",
      message: `Code changes without artifact documentation. ${codeFiles.length} code file(s) changed but no docs/issues/ or docs/decisions/ file included. Add an issue or decision doc.`,
      file: codeFiles[0],
      blocking: true,
      category: "artifact_linkage",
      problem_class: "unknown",
      required_skills: ["lead"],
      required_reads: [],
    });
    return findings;
  }

  if (hasCode && hasArtifact) {
    findings.push(...checkScopeBinding(codeFiles, artifactFiles, repoRoot));
  }

  return findings;
}