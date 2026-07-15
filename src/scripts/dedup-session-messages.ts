/**
 * 历史 session.messages 清理脚本 (2026-07-15 Bug 4 修复配套)
 * 一次性扫描 ~/.bolloon/sessions/cache/ 下所有 session 文件, 相邻去重 (同 type+content),
 * 写回原文件. 老数据有此 bug (client PATCH + server /message 各 push 一份 user msg)
 * 会导致重启后"每个 user 气泡显示 2 个".
 *
 * 跑法:
 *   npx tsx src/scripts/dedup-session-messages.ts [--dry-run] [--only channelId]
 */
import { promises as fs } from 'fs';
import * as path from 'path';

const SESSIONS_DIR = path.join(process.env.HOME || '/tmp', '.bolloon', 'sessions', 'cache');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const onlyId = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

  let files: string[];
  try {
    files = await fs.readdir(SESSIONS_DIR);
  } catch (e: any) {
    console.log(`无法读 ${SESSIONS_DIR}: ${e.message}`);
    return;
  }
  console.log(`扫描 ${SESSIONS_DIR}/ (${files.length} 文件), dry-run=${dryRun}${onlyId ? `, only=${onlyId}` : ''}`);

  let totalScanned = 0;
  let totalFixed = 0;
  let totalDupes = 0;
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    if (onlyId && !f.startsWith(onlyId)) continue;
    const fp = path.join(SESSIONS_DIR, f);
    totalScanned++;
    try {
      const raw = await fs.readFile(fp, 'utf8');
      const session = JSON.parse(raw);
      const msgs = Array.isArray(session.messages) ? session.messages : [];
      if (msgs.length === 0) continue;

      let lastType: string | null = null;
      let lastContent: string | null = null;
      const deduped = msgs.filter((m: any) => {
        const same = lastType === m.type && lastContent === m.content;
        lastType = m.type; lastContent = m.content;
        return !same;
      });
      const dupes = msgs.length - deduped.length;
      if (dupes === 0) continue;
      totalFixed++;
      totalDupes += dupes;
      console.log(`  ${f}: ${msgs.length} → ${deduped.length} (去重 ${dupes} 条)`);
      if (!dryRun) {
        session.messages = deduped;
        session.lastUpdated = new Date().toISOString();
        await fs.writeFile(fp, JSON.stringify(session, null, 2));
      }
    } catch (e: any) {
      console.warn(`  ${f} 解析失败: ${e.message?.slice(0, 100)}`);
    }
  }
  console.log(`\n扫描 ${totalScanned} 文件, 修复 ${totalFixed} 个, 共去重 ${totalDupes} 条${dryRun ? ' (dry-run, 未写入)' : ''}`);
}

main().catch(e => { console.error('ERR:', e); process.exit(1); });
