import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export const FRAGMENTS_DIR = path.join(__dirname, "..", "context-fragments");

export const CONTEXT_MAP: Record<string, string[]> = {
  "bridge_agent/": ["bridge-constitution"],
  "backend/product/bridge/": ["bridge-constitution"],
  "mcp-server/": ["mcp-parity"],
  "mcp-server-node/": ["mcp-parity"],
  "backend/product/routes/protocol.py": ["protocol-consumers", "contract-consumers"],
  "backend/product/protocol/": ["protocol-consumers"],
  "backend/product/routes/": ["contract-consumers"],
  "backend/product/db/crud_events.py": ["run-events-consumers"],
  "backend/product/auth/": ["auth-consumers"],
  "backend/product/db/": ["db-shared-structures"],
  "backend/product/catalyst/": ["catalyst-distributed"],
  "docs/issues/": ["fixed-three-layers", "closure-checklist"],
  "scenes/": ["scene-fidelity", "two-language"],
  "website/app/[scene]/": ["scene-fidelity", "two-language"],
  "website/components/scene/": ["scene-fidelity", "two-language"],
  "Bolloon.md": ["truth-source-hierarchy"],
  "MEMORY.md": ["truth-source-hierarchy"],
  "docs/INDEX.md": ["truth-source-hierarchy"],
  "mcp-server/pyproject.toml": ["version-sources"],
  "mcp-server-node/package.json": ["version-sources"],
  "website/": ["two-language"],
  "docs/decisions/": ["artifact-linkage"],
  "backend/product/": ["issue-first"],
  "backend/server.py": ["issue-first"],
  "mcp-server/boll_mcp/": ["issue-first"],
  "mcp-server-node/src/": ["issue-first"],
  "website/app/": ["issue-first"],
};

export const FALLBACK_FRAGMENTS = ["general-dev-principles"];

export function match(filePath: string): string[] {
  if (!filePath) return [];
  if (path.isAbsolute(filePath)) return [];

  const normalized = path.normalize(filePath).replace(/\\/g, "/");
  if (normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    return [];
  }

  const matched: string[] = [];
  const sortedPatterns = Object.keys(CONTEXT_MAP).sort((a, b) => b.length - a.length);

  for (const pattern of sortedPatterns) {
    if (normalized.startsWith(pattern) || normalized.endsWith(pattern)) {
      matched.push(...CONTEXT_MAP[pattern]);
    }
  }

  return [...new Set(matched)];
}

export function loadFragment(name: string): string {
  if (!name) return "";

  const candidate = path.join(FRAGMENTS_DIR, `${name}.md`);
  try {
    const resolved = path.resolve(candidate);
    const fragmentsDirResolved = path.resolve(FRAGMENTS_DIR);

    if (!resolved.startsWith(fragmentsDirResolved)) return "";

    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return fs.readFileSync(resolved, "utf-8").trim();
    }
  } catch {}

  return "";
}