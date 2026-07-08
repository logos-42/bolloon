#!/usr/bin/env node
//
// ESM smoke gate.
//
// Background:
//   The repo root has "type": "module", which means any dist/**/*.js that references
//   bare __dirname at module-eval time crashes with ReferenceError the moment it's
//   imported under Node's ESM loader. This file runs in `prepublishOnly` to catch
//   that class of regression BEFORE the npm tarball ships.
//
// Two layers:
//   1. `node --check` syntax/parse pass on every .js under dist/ (catches broken
//      ESM imports / syntax without running side-effects).
//   2. `dynamic import` of any pure-functional module that does not start CLI /
//      P2P / REPL on evaluation. `dist/bollharness/src/scripts/context_router.js`
//      is the canonical regression target -- it does nothing but export a constant
//      at module-eval time, so loading it is exactly the same as parsing it.
//
// Cost: <1s on warm node, $0 (no model calls).
//
// Note: file deliberately avoids `/** ... */` JSDoc blocks because Node 24's
// ESM source-text lexer mishandles `**` inside JSDoc strings (treats `**` as a
// stray token). Line comments are fine.
//

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

// Pure-functional module-eval smoke targets (no CLI / P2P side-effects).
// Add new entry points to this list when a new ESM subtree needs guarding.
const PURE_TARGETS = [
  'dist/bollharness/src/scripts/context_router.js',
];

const missing = PURE_TARGETS.filter((p) => !existsSync(path.join(repoRoot, p)));
if (missing.length > 0) {
  console.error(`[smoke:esm] missing required dist files: ${missing.join(', ')}`);
  console.error('  run `npm run build:all` first.');
  process.exit(2);
}

// Layer 1: walk dist/, syntax-check every .js with `node --check`.
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const distDir = path.join(repoRoot, 'dist');
const allJs = existsSync(distDir) ? walk(distDir) : [];
const checkTargets = allJs.filter((p) => !p.includes(`${path.sep}node_modules${path.sep}`));

if (checkTargets.length === 0) {
  console.error('[smoke:esm] no dist/**/*.js found -- did you run `npm run build:all`?');
  process.exit(2);
}

console.log(`[smoke:esm] syntax-checking ${checkTargets.length} .js files in dist/ ...`);

let syntaxErr = null;
for (const abs of checkTargets) {
  try {
    execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
  } catch (e) {
    syntaxErr = `${path.relative(repoRoot, abs)}: ${e.stderr ? e.stderr.toString().trim() : e.message}`;
    break;
  }
}
if (syntaxErr) {
  console.error(`[smoke:esm] ESM syntax check FAILED: ${syntaxErr}`);
  process.exit(1);
}
console.log(`[smoke:esm] syntax check OK.`);

// Layer 2: dynamic-import each pure-functional target in a child node so a
// ReferenceError / import-time exception fails the gate fast.
const probe = `
  const targets = ${JSON.stringify(PURE_TARGETS)};
  const errors = [];
  for (const rel of targets) {
    const abs = \`\${process.cwd()}/\${rel}\`;
    try {
      const mod = await import(abs);
      if (!mod) {
        errors.push(\`\${rel}: imported module is null\`);
      }
    } catch (e) {
      errors.push(\`\${rel}: \${e && e.message ? e.message : String(e)}\`);
    }
  }
  if (errors.length) {
    console.error('SMOKE_FAIL');
    for (const e of errors) console.error('  ' + e);
    process.exit(1);
  }
  process.stdout.write('SMOKE_OK\\n');
`;

execFile(
  process.execPath,
  ['--input-type=module', '-e', probe],
  { cwd: repoRoot, timeout: 15_000 },
  (err, stdout, stderr) => {
    try {
      if (err && !stdout.includes('SMOKE_OK')) {
        console.error('[smoke:esm] ESM import smoke FAILED');
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        console.error(`[smoke:esm] child exited with code ${err.code ?? 'null'}, signal ${err.signal ?? 'null'}`);
        process.exit(1);
      }
      if (stdout.includes('SMOKE_OK')) {
        console.log(
          `[smoke:esm] import OK -- ${PURE_TARGETS.length} pure-functional ESM targets loaded cleanly.`,
        );
        console.log('[smoke:esm] PASS.');
        process.exit(0);
      }
      console.error('[smoke:esm] unexpected output (no SMOKE_OK marker):');
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      process.exit(1);
    } catch (e) {
      console.error(`[smoke:esm] callback threw: ${e.stack || e.message}`);
      process.exit(2);
    }
  },
);
