/**
 * k10-orbitdb-init-guard.test.ts — 群聊修复批: dataDir 认 BOLLOON_HOME · 有界初始化 · 可行动的错误
 *
 * 起因 (2026-10-02, leo 要求测 OrbitDB 群聊): `bolloon task group create` 报
 *   `TRANSPORT_FAILED / 创建群组失败: Database failed to open`, 隔离 HOME 复跑同样失败。
 * 抓到根因 (打 cause 才看见): `IO error: lock /Users/apple/.bolloon/orbitdb/stores/keystore/LOCK:
 *   Resource temporarily unavailable` ⇒ 两件事:
 *   ① 那个 **real** 路径说明 `BOLLOON_HOME` **没被这个模块认** ⇒ "隔离运行"其实在开真实库 (隔离失效);
 *   ② 打不开时原文 (`Database failed to open` / 裸 ELOCKED) **完全没说锁被谁占着** ⇒ 误导成"功能坏了";
 *     而且初始化三步**一个超时都没有** ⇒ 真卡住时是**无声挂死** (实测探针 300s 未返回)。
 *
 * 判据三段: A. dataDir 解析; B. `describeOrbitDbFailure` 把锁/超时翻成可行动的话; C. `withStageTimeout` 有界 + 带卡点。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeOrbitDbFailure, withStageTimeout } from '../orbitdb/cid-database.js';

describe('群聊修复-A. dataDir 必须认 BOLLOON_HOME (隔离运行不许写真实库)', () => {
  const src = readFileSync(join(process.cwd(), 'src/orbitdb/cid-database.ts'), 'utf8');
  it('构造函数的默认 dataDir 走 `${BOLLOON_HOME:-~/.bolloon}` 口径', () => {
    expect(src).toMatch(/process\.env\.BOLLOON_HOME \|\| path\.join\(home\(\), '\.bolloon'\)/);
    // 反面: 只走 home() 的老写法不许回来
    expect(src).not.toMatch(/constructor\(readonly dataDir: string = path\.join\(home\(\), '\.bolloon', 'orbitdb'\)\)/);
  });
});

describe('群聊修复-B. 打不开要说人话 (锁被谁占着 / 卡在哪一步)', () => {
  it('锁冲突 (Resource temporarily unavailable / ELOCKED / Database failed to open) ⇒ 指明"另一个实例占着库" + 给两条出路', () => {
    const msg = describeOrbitDbFailure(new Error('IO error: lock /Users/apple/.bolloon/orbitdb/stores/keystore/LOCK: Resource temporarily unavailable'));
    expect(msg).toContain('被另一个进程占着');
    expect(msg).toContain('BOLLOON_HOME');
    expect(msg).toMatch(/退出其它实例/);
    // 变体也要认
    expect(describeOrbitDbFailure(new Error('Database failed to open'))).toContain('被另一个进程占着');
    expect(describeOrbitDbFailure({ code: 'ELOCKED' })).toContain('被另一个进程占着');
  });

  it('超时 ⇒ 原样给出卡点; 其它错误 ⇒ 保留原文 (不吞细节)', () => {
    const t = describeOrbitDbFailure(new Error('[orbitdb] 启动 IPFS/helia 节点 超时 (20000ms) —— 这一步没能在预算内完成'));
    expect(t).toContain('启动 IPFS/helia 节点');
    expect(t).toContain('超时');
    const other = describeOrbitDbFailure(new Error('随便一个底层错'));
    expect(other).toBe('随便一个底层错');
    expect(describeOrbitDbFailure(null)).toBe('未知原因');
  });
});

describe('群聊修复-C. withStageTimeout: 有界 + 带卡点 (卡住必须变成可判定的失败)', () => {
  it('正常完成 ⇒ 原值返回 (不改变行为)', async () => {
    await expect(withStageTimeout('x', 1000, Promise.resolve(42))).resolves.toBe(42);
  });

  it('超时 ⇒ 抛带**卡点 + 预算**的错误 (上游据此说清"卡在哪")', async () => {
    const never = new Promise<never>(() => { /* 永不 settle */ });
    await expect(withStageTimeout('打开 CID 库', 30, never)).rejects.toThrow(/打开 CID 库 超时 \(30ms\)/);
  });

  it('底层先抛 ⇒ 原样冒出去 (不被超时包装吃掉)', async () => {
    await expect(withStageTimeout('x', 1000, Promise.reject(new Error('底层炸了')))).rejects.toThrow('底层炸了');
  });

  it('ensure() 三步都被 withStageTimeout 包住 (源级)', () => {
    const src = readFileSync(join(process.cwd(), 'src/orbitdb/cid-database.ts'), 'utf8');
    for (const stage of ['启动 IPFS/helia 节点', '创建 OrbitDB 实例 (含 keystore)', '打开 CID 库']) {
      expect(src, `缺了 ${stage} 这一步的有界等待`).toMatch(new RegExp(`withStageTimeout\\('${stage.replace(/[()]/g, '\\$&')}'`));
    }
    // 默认预算可调 (运维/测试)
    expect(src).toMatch(/BOLLOON_ORBITDB_STAGE_TIMEOUT_MS/);
  });
});

describe('群聊修复-D. 四个群工具已在册 (AI 能自己入群/读/发言)', () => {
  const src = readFileSync(join(process.cwd(), 'src/agents/pi-sdk-tools.ts'), 'utf8');
  it('group_join / group_list / group_read / group_say 都注册了, 且发言走带隐私闸的唯一出口', () => {
    for (const t of ['group_join', 'group_list', 'group_read', 'group_say']) {
      expect(src, `缺工具 ${t}`).toMatch(new RegExp(`ctx\\.tools\\.set\\('${t}'`));
    }
    expect(src).toMatch(/sendTrailMessage\(res\.group\.groupId, text, who\.tag\)/);
    expect(src).toMatch(/resolveSenderTag\(null\)/);
  });
});
