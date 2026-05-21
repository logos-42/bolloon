#!/bin/bash
# /toolkit handler — print .boll/toolkit-index.yaml in human-readable form.
# Exit 0 = OK; 1 = missing index; 2 = parse error.

set -eu

ROOT="$(cd "$(/Users/nature/个人项目/boll/scripts/hooks/find-boll-root.sh)" && pwd)"
INDEX="$ROOT/.boll/toolkit-index.yaml"

if [ ! -f "$INDEX" ]; then
  echo "toolkit: index not found at $INDEX" >&2
  echo "toolkit: if this is a fresh repo, copy 99-appendix-prototypes/config/toolkit-index.yaml to .boll/" >&2
  exit 1
fi

MODE="${1:-grouped}"

npx ts-node - "$INDEX" "$MODE" <<'TS'
import * as fs from 'fs';
import * as yaml from 'js-yaml';

const [indexPath, mode] = process.argv.slice(2);
try {
    const data = yaml.load(fs.readFileSync(indexPath, 'utf8')) as any;
    const entries = data.get("entries", []);
    const active = entries.filter((e: any) => (e.get("status", "active") || "").toString().startsWith("active"));
    const retired = entries.filter((e: any) => !(e.get("status", "active") || "").toString().startsWith("active"));

    console.log("# /toolkit — .boll/ pull-surface tooling\n");
    console.log((data.get("purpose") || "").trim() + "\n");

    const render = (e: any) => {
        const name = e.get("name") || e.get("id") || "?";
        const cat = e.get("category") || "-";
        const status = e.get("status") || "active";
        const purpose = (e.get("purpose") || "").trim();
        const inv = e.get("invocation");
        console.log(`## ${name}`);
        console.log(`- id: \`${e.get('id')}\` | category: \`${cat}\` | status: \`${status}\``);
        if (purpose) console.log(`- purpose: ${purpose}`);
        if (typeof inv === "string") {
            console.log(`- run: \`${inv}\``);
        } else if (typeof inv === "object") {
            for (const [k, v] of Object.entries(inv)) {
                console.log(`- run (${k}): \`${v}\``);
            }
        }
        if (e.get("entries")) {
            console.log("- sub-entries:");
            for (const sub of e.get("entries")) {
                const writer = sub.get("writer") || "?";
                const wstatus = sub.get("writer_status") || "?";
                const pend = sub.get("pending_retire_wp");
                const retby = sub.get("retired_by_wp");
                let label = wstatus;
                if (pend) label += ` (pending retire in ${pend})`;
                if (retby) label += ` (retired by ${retby})`;
                console.log(`  - \`${sub.get('file')}\` — writer \`${writer}\`, ${label} — \`${sub.get('invocation')}\``);
            }
        }
        const retby = e.get("retired_by_wp");
        const pkt = e.get("retirement_packet");
        if (retby || pkt) {
            const bits = [];
            if (retby) bits.push(`retired by ${retby}`);
            if (pkt) bits.push(`packet: \`${pkt}\``);
            console.log(`- retirement: {' | '.join(bits)}`);
        }
        console.log();
    };

    if (mode === "all") {
        for (const e of entries) render(e);
    } else {
        if (active.length) {
            console.log("---\n## Active entries\n");
            for (const e of active) render(e);
        }
        if (retired.length) {
            console.log("---\n## Retired (kept for historical discoverability)\n");
            for (const e of retired) render(e);
        }
    }

    console.log("---");
    console.log(`Index: \`.boll/toolkit-index.yaml\` (last_updated: ${data.get('last_updated','?')}, by WP ${data.get('updated_by_wp','?')})`);
    console.log("Amendment protocol: update the yaml when a .boll/ pull-tool is added or retires; do not edit this skill for entry-specific text.");
} catch (e) {
    console.error(`toolkit: yaml parse error: ${e}`);
    process.exit(2);
}
TS
