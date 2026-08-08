import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  resolveUserDid,
  catalogUpsertQuiet,
  backfillDidCatalog,
  openUserCatalog,
  catalogMemoryRows,
  catalogPersonaRows,
} from '../storage/did-catalog-bridge.js';
import { registryOpen } from '../storage/did-catalog.js';

const DID = 'did:key:z6MkTestBridge123';
const tmpHome = path.join(os.tmpdir(), `bolloon-bridge-test-${Date.now()}`);
let oldHome = '';

describe('did-catalog-bridge (现有落盘读写 → DID 目录写穿 + 启动回填)', () => {
  beforeAll(async () => {
    oldHome = process.env.HOME || '';
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    const bolloon = path.join(tmpHome, '.bolloon');
    // 用户身份 (DID 主键来源)
    await fs.mkdir(path.join(bolloon, 'identity'), { recursive: true });
    await fs.writeFile(
      path.join(bolloon, 'identity', 'user.json'),
      JSON.stringify({ did: DID, publicKeyHex: 'abcd', name: 'tester' }),
      'utf-8',
    );
    // 既有磁盘数据: memory 摘要 / persona / skills / channels / context-os
    await fs.mkdir(path.join(bolloon, 'memory', 'agentA', 'sessions'), { recursive: true });
    await fs.writeFile(path.join(bolloon, 'memory', 'agentA', 'sessions', 'ch1__s1.summary.md'), '# 摘要 1\n\n做过的事情\n', 'utf-8');
    await fs.mkdir(path.join(bolloon, 'persona', 'agentA'), { recursive: true });
    await fs.writeFile(path.join(bolloon, 'persona', 'agentA', 'soul.md'), '---\nname: 小星\n---\n我是 agentA 的灵魂', 'utf-8');
    await fs.mkdir(path.join(bolloon, 'skills', 'test-skill'), { recursive: true });
    await fs.writeFile(path.join(bolloon, 'skills', 'test-skill', 'SKILL.md'), '# test-skill\n\n技能正文', 'utf-8');
    await fs.writeFile(
      path.join(bolloon, 'channels.json'),
      JSON.stringify([{ id: 'ch1', name: '默认', agentId: 'agentA', publicKey: 'pk1', updatedAt: 111 }]),
      'utf-8',
    );
    await fs.mkdir(path.join(bolloon, 'context-os', '07-Knowledge'), { recursive: true });
    await fs.writeFile(path.join(bolloon, 'context-os', '07-Knowledge', 'note.md'), '知识资产', 'utf-8');
  });

  afterAll(async () => {
    process.env.HOME = oldHome;
    process.env.USERPROFILE = oldHome;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('resolveUserDid 从 user.json 读 DID', async () => {
    expect(await resolveUserDid(tmpHome)).toBe(DID);
    // 无 user.json 的目录 → ''
    const empty = path.join(tmpHome, 'empty-home');
    await fs.mkdir(empty, { recursive: true });
    expect(await resolveUserDid(empty)).toBe('');
  });

  it('backfillDidCatalog: 扫描既有磁盘 → 灌入 5 张表', async () => {
    const cat = await openUserCatalog({ home: tmpHome });
    expect(cat).not.toBeNull();
    const r = await backfillDidCatalog(cat!, { home: tmpHome });

    const byTable = Object.fromEntries(r.map(x => [x.table, x]));
    expect(byTable.memory.added).toBeGreaterThanOrEqual(1);
    expect(byTable.persona.added).toBeGreaterThanOrEqual(1);
    expect(byTable.skills.added).toBeGreaterThanOrEqual(1);
    expect(byTable.channels.added).toBeGreaterThanOrEqual(1);
    expect(byTable.context_os.added).toBeGreaterThanOrEqual(1);

    // memory 表有摘要行, 内容可读 (读侧合并用)
    const memRows = catalogMemoryRows(cat!, 'agentA');
    expect(memRows.length).toBeGreaterThanOrEqual(1);
    expect(String((memRows[0].row.data as any).summary)).toContain('摘要 1');

    // persona 表叠加可用
    const persona = catalogPersonaRows(cat!, 'agentA');
    expect(persona.soul).toContain('小星');
  });

  it('backfill 幂等: 内容未变 → 二次回填 0 新增', async () => {
    const cat = await openUserCatalog({ home: tmpHome });
    const walBefore = cat!.walEvents.length;
    const r2 = await backfillDidCatalog(cat!, { home: tmpHome });
    const totalAdded = r2.reduce((a, x) => a + x.added, 0);
    expect(totalAdded).toBe(0);
    expect(cat!.walEvents.length).toBe(walBefore); // 无新 WAL 事件
  });

  it('catalogUpsertQuiet: 写穿 → 行落表 + persist 可见', async () => {
    const ok = await catalogUpsertQuiet('memory', 'sessions/agentA/ch1__s2.summary.md', {
      agentId: 'agentA', kind: 'summary', summary: '写穿摘要', updatedAt: Date.now(),
    }, { home: tmpHome });
    expect(ok).toBe(true);

    const cat = await openUserCatalog({ home: tmpHome });
    const row = cat!.get('memory', 'sessions/agentA/ch1__s2.summary.md');
    expect(row).toBeDefined();
    expect((row!.data as any).summary).toBe('写穿摘要');
  });

  it('catalogUpsertQuiet: 无 user.json → 静默 false', async () => {
    const empty = path.join(tmpHome, 'empty-home2');
    await fs.mkdir(empty, { recursive: true });
    const ok = await catalogUpsertQuiet('memory', 'k', { v: 1 }, { home: empty });
    expect(ok).toBe(false);
  });

  it('registryOpen 默认单例: 同 did 复用同一实例', async () => {
    const a = await registryOpen(DID); // 无 opts → 默认注册表 (进程级单例)
    const b = await registryOpen(DID);
    expect(a).toBe(b);
  });
});
