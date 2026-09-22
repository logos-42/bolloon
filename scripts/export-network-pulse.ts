/**
 * export-network-pulse.ts — 把本节点的**真实观察投影**导出成可部署的公开观察入口
 *
 * 用途: bolloon.cn 是纯静态站, 没有后端。网关页/首页的「网络脉冲」通过
 *   ① data-pulse-src ② ?pulse=<url> ③ 同源 network-pulse.json ④ unavailable
 * 取数。本脚本生成第 ③ 档 —— **同源签名快照** —— 让静态站也能"动态加载"真实观察数据
 * (快照过期后前端自己降级为 stale, 不伪装实时)。
 *
 * 用法:
 *   npx tsx scripts/export-network-pulse.ts                      # 导出到 stdout 摘要 + 默认路径
 *   npx tsx scripts/export-network-pulse.ts --out /tmp/network-pulse.json
 *   npx tsx scripts/export-network-pulse.ts --home /tmp/node-b --out .../network-pulse.json
 *   npx tsx scripts/export-network-pulse.ts --no-sign            # 调试用, 不加签名
 *
 * 硬约束: 导出的文件只含**公开聚合**(机器数/agent 数/能力粗类别/金额无关的活动类型),
 * 绝不包含 DID / peerId / IP / 钱包 / 任务正文 —— 由 `assertNoPrivateFields` 兜底检查。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as NP from '../src/agents/network-pulse.js';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const home = arg('home');
  const out = arg('out');
  const sign = !has('no-sign');

  const snap: any = await NP.getNetworkPulse(home ? { home } : {});
  snap.status = NP.snapshotStatus(snap);
  snap.agent_sites = NP.readAgentSites(home);   // 本节点显式发布的 IPNS 私有站 (可为空数组)

  // 静态观察入口的「新鲜窗口」必须等于它的**发布周期**, 否则文件永远显示 stale。
  // 这是"定期发布"语义 (stale-while-revalidate), 不是假装实时 —— 页面同时显示快照时间与相对年龄。
  const ttlSec = Number(arg('ttl', '7200'));
  const now = Date.now();
  snap.generated_at = snap.generated_at || now;
  snap.fresh_until = now + ttlSec * 1000;
  snap.freshness_window_ms = ttlSec * 1000;
  snap.freshness_semantics = 'periodic-publication: fresh_until = published_at + 发布周期 (不是实时)';
  snap.status = NP.snapshotStatus(snap);

  // 公开入口的元信息 (前端只展示, 不参与聚合)
  const entry = {
    ...snap,
    observation_entry: 'static-signed-snapshot',
    published_at: Date.now(),
    published_by: 'bolloon-node-export',
  };

  // 交给脉冲模块自己的签名 (私钥只在本地进程内使用, 不进任何日志/公开输出)
  let finalSnap: any = entry;
  if (sign) {
    try {
      finalSnap = await NP.signSnapshot(entry as any, home);
    } catch (e: any) {
      console.error(`[export-pulse] 签名失败 (${e?.message || e}) → 导出**未签名**快照 (前端会显示 observed, 不会显示 verified)`);
      finalSnap = { ...entry, signature: undefined };
    }
    if (!finalSnap.signature) {
      const why = NP.lastSnapshotSignError?.() || '未知原因';
      console.error(`[export-pulse] 未签名原因: ${why}`);
    }
  }

  // 兜底: 公开文件里绝不能有私有字段
  const leaks = NP.assertNoPrivateFields(finalSnap);
  if (leaks.length) {
    console.error(`[export-pulse] 拒绝导出: 检出私有字段 ${leaks.join(', ')}`);
    process.exit(2);
  }

  // 兜底: 公开页会**同屏展示**的数字之间不许自相矛盾 —— 自检不过就拒绝导出 (不把打架的快照发出去)
  const issues = NP.snapshotConsistencyIssues(finalSnap as any);
  if (issues.length) {
    console.error(`[export-pulse] 拒绝导出: 快照内部自相矛盾 —— ${issues.join('; ')}`);
    process.exit(3);
  }

  const json = JSON.stringify(finalSnap, null, 2);
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(path.resolve(out), json, 'utf8');
  } else {
    process.stdout.write(json);
  }

  const t = finalSnap.totals || {};
  const at = finalSnap.activity_totals || {};
  const cis = finalSnap.chain_id_scope || {};
  const act = Array.isArray(finalSnap.confirmed_activity) ? finalSnap.confirmed_activity : [];
  console.error(
    `[export-pulse] status=${finalSnap.status} scope=${finalSnap.scope} ` +
    `nodes=${t.nodes} agents=${t.agents} active=${t.active_agents} 24h=${t.seen_last_24h} ` +
    `caps=${(finalSnap.capabilities || []).map((c: any) => `${c.key}:${c.count}`).join(',') || '(none)'} ` +
    `signed=${!!finalSnap.signature} out=${out || '(stdout)'}`,
  );
  // ★ 两套口径分开报: totals 是 24h 脉冲事件; activity_totals 与上表同源 (rows 必须 === 行数)
  console.error(
    `[export-pulse] totals(24h 脉冲事件口径)=tasks:${t.tasks}/tasks_completed:${t.tasks_completed}/tasks_verified:${t.tasks_verified}/signatures:${t.signatures} ` +
    `activity_totals(${finalSnap.confirmed_activity_source} 同源)=rows:${at.rows}/tasks:${at.tasks}/tasks_completed:${at.tasks_completed}/` +
    `tasks_settled:${at.tasks_settled}/finality:${JSON.stringify(at.by_finality)} ` +
    `differs_from_activity=${!!(finalSnap.totals_scope || {}).differs_from_activity}`,
  );
  console.error(
    `[export-pulse] confirmed_activity=${act.length} 行 · chain_ids=${JSON.stringify(cis.chain_ids)} ` +
    `activity_chain_id=${cis.activity_chain_id}(${cis.is_public_network ? '公网' : '非公网'}) ` +
    `public_network_rows=${cis.public_network_rows} · consistency=OK`,
  );
}

main().catch((e) => { console.error('[export-pulse] 失败:', e?.message || e); process.exit(1); });
