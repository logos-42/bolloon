/**
 * iroh-secret-persistence — 验证 iroh nodeId 在两次进程启动间保持稳定
 *
 * 用法:
 *   npx tsx src/test/iroh-secret-persistence.ts run1
 *   npx tsx src/test/iroh-secret-persistence.ts run2
 *
 * 期望: 两次 run 输出的 nodeId 完全相同
 */

import { irohTransport } from '../network/iroh-transport.js';

(async () => {
  const run = process.argv[2] || 'run1';
  console.log(`\n=== iroh-secret-persistence — ${run} ===\n`);

  try {
    const { nodeId } = await irohTransport.start(undefined, true);
    console.log(`nodeId: ${nodeId}`);
    console.log(`first  : ${nodeId.substring(0, 32)}`);

    // 写到固定文件方便外部 diff
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const outDir = path.join(os.homedir(), '.bolloon');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `iroh-nodeid-${run}.txt`);
    fs.writeFileSync(outFile, nodeId);
    console.log(`写入 ${outFile}`);

    // 给 iroh 一点时间 online
    await new Promise((r) => setTimeout(r, 1500));

    await irohTransport.shutdown();
    process.exit(0);
  } catch (e: any) {
    console.error('启动失败:', e.message);
    process.exit(1);
  }
})();
