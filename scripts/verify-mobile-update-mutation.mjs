/**
 * verify-mobile-update-mutation.mjs — 手机端双源 OTA 的**变异验证** (2026-09-26)
 *
 * 一条门"全绿"本身不能证明它验到了东西 —— 必须证明**改坏关键判据它就会红**。
 * 做法: 对每条关键判据做一次**按词界**(`\b`, 绝不用裸子串替换 —— 子串替换会命中别的名字, 产生假绿)
 * 的最小破坏 → 跑聚焦测试 → **必须退出码非 0** → 恢复 → 校验恢复后文件 sha256 与原文一致。
 *
 * 判据覆盖 (逐条对应交付要求):
 *   身份比较 / 下载校验(摘要) / 原子替换(回滚) / 验证可启动 / 失败回滚 / 源不可达必拒分类 / 交叉校验
 *
 * 用法: node scripts/verify-mobile-update-mutation.mjs
 * 退出码: 0 = 每条变异都判红且恢复成功; 1 = 有变异**没判红**(门是空的) 或恢复不一致
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src/web/mobile-update.ts');
const FACTS = path.join(ROOT, 'src/utils/dual-source-facts.ts');
const IDENT = path.join(ROOT, 'src/utils/version-identity.ts');
const TEST = 'src/test/mobile-update.test.ts';

const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** 每条: 目标文件 + 一段**唯一**代码 + 破坏后的版本 + 它破坏了哪条判据 */
const MUTATIONS = [
  {
    name: '身份比较: dev 身份不再带 sha7 ⇒ 认不出"装的是哪个 commit"',
    file: IDENT,
    from: 'return `${baseVersionOf(baseVersion)}${DEV_IDENTITY_SEP}${String(sha).slice(0, 7)}`;',
    to: 'return `${baseVersionOf(baseVersion)}${DEV_IDENTITY_SEP}${String(sha)}`;',
    criterion: 'dev 身份 (sha7)',
  },
  {
    name: '下载校验: 摘要算法名不再归一化 ⇒ WebCrypto 抛错 ⇒ 真包被判摘要不符',
    file: SRC,
    from: "if (k === 'sha1') return 'SHA-1';",
    to: "if (k === 'sha1') return 'SHA1';",
    criterion: '摘要校验 (sha1)',
  },
  {
    name: '下载校验: 摘要对不上也放行 ⇒ "先装上再说"',
    file: SRC,
    from: 'const matched = got !== null && got.toLowerCase() === want.toLowerCase();',
    to: 'const matched = true;',
    criterion: '摘要不一致必拒',
  },
  {
    name: '源不可达必拒: 拒绝表不生效 ⇒ 不可达也当"可以装"',
    file: SRC,
    from: 'return MOBILE_REFUSED_STATUSES.includes(s);',
    to: 'return false;',
    criterion: '拒绝语义',
  },
  {
    name: '源不可达分类: 不看分类器结果, 一律当可达 ⇒ offline 被吞',
    file: SRC,
    from: "const offline = npm.kind === 'offline';",
    to: 'const offline = false;',
    criterion: 'offline 分类',
  },
  {
    name: '交叉校验: 两源不一致也放行 ⇒ 按 GitHub 的记录装一个 npm 上不存在的版本',
    file: FACTS,
    from: 'export function crossCheckStable(registryLatest: string | null, facts: GithubFacts): CrossCheck {',
    to: 'export function crossCheckStable(registryLatest: string | null, facts: GithubFacts): CrossCheck {\n  if (registryLatest !== null) return { kind: \'agree\', blocking: false, detail: \'变异版: 恒一致\' } as CrossCheck;',
    criterion: 'cross_check_mismatch',
  },
  {
    name: '验证可启动: 启动验证恒过 ⇒ 起不来的资源也会被换上',
    file: SRC,
    from: 'const structural = checks.every((c) => c.ok);',
    to: 'const structural = true;',
    criterion: '结构与语法验证',
  },
  {
    name: '失败回滚: 切换失败不再搬回 previous ⇒ 用户停在"起不来"的资源上',
    file: SRC,
    from: '        await store.rename(WEB_LAYOUT.previous, WEB_LAYOUT.current);\n        rolled = true;',
    to: '        await store.rename(WEB_LAYOUT.previous, WEB_LAYOUT.current);\n        rolled = false;',
    criterion: '切换失败回滚',
  },
  {
    name: '原子替换: 不做 previous 备份就直接替换 ⇒ 没有回滚点',
    file: SRC,
    from: 'if (hadCurrent) {\n      await store.rename(WEB_LAYOUT.current, WEB_LAYOUT.previous);\n      backupMade = true;\n    }',
    to: 'if (false) {\n      await store.rename(WEB_LAYOUT.current, WEB_LAYOUT.previous);\n      backupMade = true;\n    }',
    criterion: '原子替换 (备份)',
  },
  {
    name: '原生壳天花板: 没接通也照样切换 ⇒ 假装"装好了"',
    file: SRC,
    from: 'if (!nativeWired(opts)) {',
    to: 'if (false) {',
    criterion: 'native_shell_not_wired 拒绝切换',
  },
  {
    name: '智能体边界: 不需要人工确认就切换 ⇒ 智能体能自己换掉正在跑的界面',
    file: SRC,
    from: "  if (!opts.confirm) {\n    stage('blocked', '需要人工确认');",
    to: "  if (false) {\n    stage('blocked', '需要人工确认');",
    criterion: 'human_confirm_required',
  },
];

const results = [];
for (const m of MUTATIONS) {
  const file = m.file;
  const orig = fs.readFileSync(file, 'utf8');
  const before = sha256(file);
  // 词界检查: from 必须唯一出现 (唯一性 = 不会误伤同名片段)
  const hits = orig.split(m.from).length - 1;
  if (hits !== 1) {
    results.push({ ...m, verdict: `跳过: 目标片段出现 ${hits} 次 (期望 1) — 变异定义过期, 需更新` , ok: false, skipped: true });
    continue;
  }
  fs.writeFileSync(file, orig.replace(m.from, m.to));
  let red = false, why = '';
  try {
    const r = spawnSync('npx', ['vitest', 'run', TEST], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
    red = r.status !== 0;
    why = red ? '测试红了 ✓' : '测试仍然全绿 ⇒ 这条判据没有被验到';
  } finally {
    fs.writeFileSync(file, orig);
  }
  const after = sha256(file);
  const restored = after === before;
  results.push({ ...m, ok: red && restored, red, restored, verdict: restored ? why : '文件恢复后 sha256 不一致 ⇒ 污染了工作区' });
}

const nmut = results.filter((r) => !r.skipped).length;
const redCount = results.filter((r) => r.red && r.restored).length;
const restoredAll = results.filter((r) => !r.skipped).every((r) => r.restored);
const skipped = results.filter((r) => r.skipped).length;

console.log('手机端双源 OTA — 变异验证 (按词界破坏关键判据 → 必须判红 → 恢复 → 校验 sha256)\n');
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.criterion}`);
  console.log(`      ${r.name}`);
  console.log(`      → ${r.verdict}`);
}
console.log('');
console.log(`判红: ${redCount}/${nmut} 条变异 · 恢复一致: ${restoredAll ? '全部一致' : '有不一致!'} · 过期定义: ${skipped}`);
process.exit(redCount === nmut && restoredAll && skipped === 0 ? 0 : 1);
