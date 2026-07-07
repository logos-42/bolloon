// 临时脚本: 在用户真实 ~/.bolloon/human-values 上跑 dryCleanup (只 read)
// 安全 — 不写盘
import { dryCleanup } from '../src/pi-ecosystem-judgment/cleanup.ts';

async function main() {
  const r = await dryCleanup();
  console.log('DRY-CLEANUP REPORT');
  console.log('=================');
  console.log('Total before:', r.totalBefore);
  console.log('Total after (kept):', r.totalAfter);
  console.log('Will be cleaned (rejected):', r.removed);
  console.log('Sample removed (first 10):');
  for (const j of r.sample) console.log(`  ${j.id}  → "${j.decision}"`);
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
