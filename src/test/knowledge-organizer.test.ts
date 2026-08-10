/**
 * knowledge-organizer.test.ts — 自动整理心跳 · 知识层整理单元验证 (临时 HOME, 无网络)
 *
 * 覆盖 9 个整理器 + runKnowledgeOrganize 汇总:
 *  context-os 归档 / 社交关系 / 外部智能体 / 内部智能体 / judgeness / 项目理解 / 用户画像 / 日志归档 / 目标维护
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  archiveContextOs,
  tidySocialRelations,
  tidyExternalAgents,
  tidyInternalAgents,
  maintainJudgeness,
  understandProjects,
  understandUserProfile,
  archiveRecentLogs,
  maintainGoals,
  runKnowledgeOrganize,
} from '../agents/knowledge-organizer.js';

const tmpHome = path.join(os.tmpdir(), `bolloon-knowledge-organizer-${Date.now()}`);
let oldHome = '';

async function mk(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}
async function write(p: string, content: string): Promise<void> {
  await mk(path.dirname(p));
  await fs.writeFile(p, content, 'utf-8');
}
/** 把文件 mtime 改到 N 天前 (测试归档判定) */
async function ageFile(p: string, days: number): Promise<void> {
  const t = new Date(Date.now() - days * 24 * 3600 * 1000);
  await fs.utimes(p, t, t);
}

describe('knowledge-organizer', () => {
  beforeAll(async () => {
    oldHome = process.env.HOME || '';
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    // 1. context-os 结构
    await mk(path.join(tmpHome, '.bolloon', 'context-os', '01-Me'));
    await mk(path.join(tmpHome, '.bolloon', 'context-os', '04-Projects'));
    await write(path.join(tmpHome, '.bolloon', 'context-os', '01-Me', '个人档案.md'), '# 档案\n内容'.repeat(20));
    await write(path.join(tmpHome, '.bolloon', 'context-os', 'tmp', '旧草稿.md'), '# 旧');
    await ageFile(path.join(tmpHome, '.bolloon', 'context-os', 'tmp', '旧草稿.md'), 2); // >1 天 → 归档
    await write(path.join(tmpHome, '.bolloon', 'context-os', 'tmp', '新草稿.md'), '# 新'); // 新 → 保留
    // 2. known_peers + dunbar tier
    await write(
      path.join(tmpHome, '.bolloon', 'known_peers.json'),
      JSON.stringify({
        version: 1,
        peers: {
          nodeA: { publicKey: 'a'.repeat(64), name: 'nodeA', lastConnectedAt: new Date().toISOString() },
          nodeB: { publicKey: 'b'.repeat(64), name: 'nodeB', lastConnectedAt: new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString() },
        },
      })
    );
    await write(
      path.join(tmpHome, '.bolloon', 'peers', 'a'.repeat(64), 'dunbar-tier.json'),
      JSON.stringify({ tier: 'friends', trustScore: 25 })
    );
    // 3. 外部 agent manifest
    await write(path.join(tmpHome, '.bolloon', 'peers', 'a'.repeat(64), 'agents', 'agent-1.json'), JSON.stringify({ name: '远端A' }));
    // 4. channels (真实路径 sessions/channels.json, 纯数组格式) + persona
    await write(
      path.join(tmpHome, '.bolloon', 'sessions', 'channels.json'),
      JSON.stringify([
        { id: 'ch1', name: '小微', persona: { name: '小微', description: '助手' } },
        { id: 'ch2', name: '无 persona' },
      ])
    );
    await write(path.join(tmpHome, '.bolloon', 'persona', 'agent-xiao', 'user.md'), '# 用户\n刘元杰, 杭州, 研究曲率飞船');
    await write(path.join(tmpHome, '.bolloon', 'persona', 'agent-xiao', 'soul.md'), '# 灵魂\n温暖');
    // 5. judgeness descriptions
    await write(path.join(tmpHome, '.bolloon', 'judgeness', 'descriptions', 'jd-old.md'), '# 旧判断\n内容'.repeat(20));
    await ageFile(path.join(tmpHome, '.bolloon', 'judgeness', 'descriptions', 'jd-old.md'), 40); // >30 天 → 归档
    await write(path.join(tmpHome, '.bolloon', 'judgeness', 'descriptions', 'jd-new.md'), '# 新判断\n内容'.repeat(20));
    // 6. 项目目录
    await write(path.join(tmpHome, 'Downloads', 'proj-a', 'package.json'), '{"name":"proj-a"}');
    await write(path.join(tmpHome, 'Downloads', 'proj-b', 'pyproject.toml'), '[project]');
    await write(path.join(tmpHome, 'lean', 'proj-c', 'Cargo.toml'), '[package]');
    // 8. 日志
    await write(path.join(tmpHome, '.bolloon', 'goals', 'event.jsonl'), '{"event":"x"}\n');
    await ageFile(path.join(tmpHome, '.bolloon', 'goals', 'event.jsonl'), 40);
    await write(path.join(tmpHome, '.bolloon', 'engine', 'backpressure.jsonl'), '{"x":1}\n');
    // 9. goals
    await write(path.join(tmpHome, '.bolloon', 'goals', 'queue.json'), JSON.stringify([{ id: 'g1', description: '完成曲率飞船研究' }, { id: 'g2', description: '开发 alou' }]));
    await write(path.join(tmpHome, '.bolloon', 'context-os', '03-Current', '当前任务.md'), '# 任务\nx'.repeat(20));
  });

  afterAll(async () => {
    process.env.HOME = oldHome;
    process.env.USERPROFILE = oldHome;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('archiveContextOs: 统计资产 + 快照清单 + 过期 tmp 归档', async () => {
    const r = await archiveContextOs(tmpHome);
    expect(r.key).toBe('context-os');
    expect(r.handled).toBeGreaterThanOrEqual(1);
    expect(r.summary).toContain('层');
    // tmp 旧草稿被归档
    const snapshots = await fs.readdir(path.join(tmpHome, '.bolloon', 'context-os', 'snapshots'));
    const trashDirs = snapshots.filter((f) => f.startsWith('trash-'));
    expect(trashDirs.length).toBeGreaterThan(0);
    const trashFiles = await fs.readdir(path.join(tmpHome, '.bolloon', 'context-os', 'snapshots', trashDirs[0]));
    expect(trashFiles).toContain('旧草稿.md');
    // 新草稿保留
    const tmpFiles = await fs.readdir(path.join(tmpHome, '.bolloon', 'context-os', 'tmp'));
    expect(tmpFiles).toContain('新草稿.md');
    // manifest 快照
    expect(snapshots.some((f) => f.startsWith('manifest-'))).toBe(true);
  });

  it('tidySocialRelations: peers 统计 + tier 分布', async () => {
    const r = await tidySocialRelations(tmpHome);
    expect(r.handled).toBe(2);
    expect(r.summary).toContain('活跃 1');
    expect(r.summary).toContain('失联 1');
    expect(r.summary).toContain('friends=1');
  });

  it('tidyExternalAgents: 远端 agent manifest 统计', async () => {
    const r = await tidyExternalAgents(tmpHome);
    expect(r.handled).toBe(1);
    expect(r.summary).toContain('1 个远端 agent');
  });

  it('tidyInternalAgents: channels persona + persona 文档统计 (sessions/channels.json 主路径)', async () => {
    const r = await tidyInternalAgents(tmpHome);
    expect(r.handled).toBe(2);
    expect(r.summary).toContain('1 有 persona');
    expect(r.summary).toContain('2 个文档');
  });

  it('tidyInternalAgents: 旧路径 channels.json fallback', async () => {
    await write(
      path.join(tmpHome, '.bolloon', 'channels.json'),
      JSON.stringify({ version: 1, channels: [{ id: 'legacy-1', name: '旧', persona: { name: '旧' } }] })
    );
    // 暂时移走主路径文件, 验证 fallback (旧对象形态)
    await fs.rename(
      path.join(tmpHome, '.bolloon', 'sessions', 'channels.json'),
      path.join(tmpHome, '.bolloon', 'sessions', 'channels.json.bak')
    );
    const r = await tidyInternalAgents(tmpHome);
    expect(r.handled).toBe(1);
    await fs.rename(
      path.join(tmpHome, '.bolloon', 'sessions', 'channels.json.bak'),
      path.join(tmpHome, '.bolloon', 'sessions', 'channels.json')
    );
  });

  it('maintainJudgeness: 旧描述归档 (>30 天), 新描述保留', async () => {
    const r = await maintainJudgeness(tmpHome);
    expect(r.handled).toBe(2);
    expect(r.summary).toContain('归档 1 条旧描述');
    const archiveDir = path.join(tmpHome, '.bolloon', 'judgeness', 'archive');
    const archived = await fs.readdir(archiveDir);
    expect(archived).toContain('jd-old.md');
    const kept = await fs.readdir(path.join(tmpHome, '.bolloon', 'judgeness', 'descriptions'));
    expect(kept).toContain('jd-new.md');
    expect(kept).not.toContain('jd-old.md');
  });

  it('understandProjects: 扫描项目 → 项目理解.md', async () => {
    const r = await understandProjects(tmpHome);
    expect(r.handled).toBeGreaterThanOrEqual(3); // proj-a/b/c
    const out = await fs.readFile(path.join(tmpHome, '.bolloon', 'context-os', '04-Projects', '项目理解.md'), 'utf-8');
    expect(out).toContain('proj-a');
    expect(out).toContain('proj-b');
  });

  it('understandProjects: 带 LLM 增强', async () => {
    const r = await understandProjects(tmpHome, async (p) => '- proj-a: 一个 Node 项目');
    expect(r.handled).toBeGreaterThanOrEqual(3);
    const out = await fs.readFile(path.join(tmpHome, '.bolloon', 'context-os', '04-Projects', '项目理解.md'), 'utf-8');
    expect(out).toContain('LLM 理解');
  });

  it('understandUserProfile: persona user.md + 01-Me → 画像快照', async () => {
    const r = await understandUserProfile(tmpHome);
    expect(r.handled).toBeGreaterThanOrEqual(2);
    const out = await fs.readFile(path.join(tmpHome, '.bolloon', 'context-os', '01-Me', '用户画像快照.md'), 'utf-8');
    expect(out).toContain('刘元杰');
  });

  it('archiveRecentLogs: 旧 jsonl 归档 (>30 天), event.jsonl 受保护', async () => {
    // goals/ 下再造一个旧日志 (event.jsonl 受保护不归档)
    await write(path.join(tmpHome, '.bolloon', 'goals', 'old-goal-log.jsonl'), '{"old":1}\n');
    await ageFile(path.join(tmpHome, '.bolloon', 'goals', 'old-goal-log.jsonl'), 40);
    const r = await archiveRecentLogs(tmpHome);
    expect(r.handled).toBeGreaterThanOrEqual(2); // old-goal-log + backpressure (event.jsonl 受保护不计)
    expect(r.summary).toContain('归档 1 个旧文件');
    const archived = await fs.readdir(path.join(tmpHome, '.bolloon', 'goals', 'archive'));
    expect(archived).toContain('old-goal-log.jsonl');
    expect(archived).not.toContain('event.jsonl'); // 受保护
    // event.jsonl 仍留在原位 (goal-resume 依赖)
    const kept = await fs.readdir(path.join(tmpHome, '.bolloon', 'goals'));
    expect(kept).toContain('event.jsonl');
    // 新日志保留
    const engineKept = await fs.readdir(path.join(tmpHome, '.bolloon', 'engine'));
    expect(engineKept).toContain('backpressure.jsonl');
  });

  it('maintainGoals: queue + 03-Current → 目标摘要 (带 LLM 分层)', async () => {
    const r = await maintainGoals(tmpHome, async (p) => '- [长期] 曲率飞船\n- [短期] 开发 alou');
    expect(r.handled).toBeGreaterThanOrEqual(3);
    const out = await fs.readFile(path.join(tmpHome, '.bolloon', 'context-os', '03-Current', '目标摘要.md'), 'utf-8');
    expect(out).toContain('曲率飞船');
    expect(out).toContain('LLM 目标分层');
  });

  it('runKnowledgeOrganize: 汇总 9 个 section', async () => {
    const r = await runKnowledgeOrganize({ home: tmpHome });
    expect(r.sections).toHaveLength(9);
    const keys = r.sections.map((s) => s.key);
    expect(keys).toEqual([
      'context-os', 'social', 'agents-ext', 'agents-int', 'judgeness',
      'projects', 'user', 'logs', 'goals',
    ]);
    expect(r.totalHandled).toBeGreaterThan(0);
    // 全部无致命错误 (每个 section 独立容错)
    for (const s of r.sections) {
      expect(s.error).toBeUndefined();
    }
  });
});
