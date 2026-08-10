/**
 * skill-organizer.test.ts — 自动整理心跳核心逻辑单元验证 (临时 HOME/cwd, mock LLM, 无网络)
 *
 * 覆盖:
 *  1. leftoverReasons: 迁移残留 / 无描述 / 正文过短 / archived 判定
 *  2. scanLeftoverSkills: 目录扫描 + 跨目录同名重复
 *  3. parseEvolveJson: LLM JSON 容错解析
 *  4. runSkillOrganize: 候选 → LLM 完整经验 → 转正 skill + 清理候选 + 遗留报告
 *  5. startOrganizeHeartbeat: runOnce 触发 onStart/onEnd, 重入锁, stop
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  leftoverReasons,
  scanLeftoverSkills,
  parseEvolveJson,
  buildEvolvePrompt,
  runSkillOrganize,
  startOrganizeHeartbeat,
} from '../agents/skill-organizer.js';
import { writeSkillCandidate, listSkillCandidates } from '../agents/skill-writer.js';

const tmpHome = path.join(os.tmpdir(), `bolloon-skill-organizer-test-${Date.now()}`);
const tmpCwd = path.join(os.tmpdir(), `bolloon-skill-organizer-cwd-${Date.now()}`);
let oldHome = '';
let oldUserProfile = '';

async function writeSkill(dir: string, name: string, content: string): Promise<void> {
  await fs.mkdir(path.join(dir, name), { recursive: true });
  await fs.writeFile(path.join(dir, name, 'SKILL.md'), content, 'utf-8');
}

describe('skill-organizer', () => {
  beforeAll(async () => {
    oldHome = process.env.HOME || '';
    oldUserProfile = process.env.USERPROFILE || '';
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    await fs.mkdir(path.join(tmpHome, '.bolloon', 'skills'), { recursive: true });
    await fs.mkdir(path.join(tmpCwd, '.bolloon', 'skills'), { recursive: true });
  });

  afterAll(async () => {
    process.env.HOME = oldHome;
    process.env.USERPROFILE = oldUserProfile;
    await fs.rm(tmpHome, { recursive: true, force: true });
    await fs.rm(tmpCwd, { recursive: true, force: true });
  });

  it('leftoverReasons: 迁移残留/无描述/正文过短/archived', () => {
    // 正常 skill → 无原因
    expect(leftoverReasons({ name: 'p2p-debug', description: '调试 P2P', body: '## 流程\n'.repeat(20) })).toEqual([]);
    // 迁移残留 (外部智能体分类前缀)
    expect(leftoverReasons({ name: 'apple-test-skill', description: 'x', body: 'body'.repeat(20) })).toContain('迁移遗留 (外部智能体分类前缀)');
    expect(leftoverReasons({ name: 'autonomous-ai-agents-codex', description: 'x', body: 'body'.repeat(20) })).toContain('迁移遗留 (外部智能体分类前缀)');
    // 无描述
    expect(leftoverReasons({ name: 'x', body: 'body'.repeat(20) })).toContain('无 description');
    // 正文过短
    expect(leftoverReasons({ name: 'x', description: 'd', body: 'hi' })).toContain('正文过短 (疑似占位)');
    // archived 残留
    expect(leftoverReasons({ name: 'x', description: 'd', body: 'body'.repeat(20), status: 'archived' })).toContain('status=archived (归档残留)');
  });

  it('scanLeftoverSkills: 只报遗留, 正常 skill 不报', async () => {
    const homeSkills = path.join(tmpHome, '.bolloon', 'skills');
    const cwdSkills = path.join(tmpCwd, '.bolloon', 'skills');
    await writeSkill(homeSkills, 'normal-skill', `---\nname: normal-skill\ndescription: 正常技能\n---\n## 背景\n` + '# x\n'.repeat(30));
    await writeSkill(homeSkills, 'apple-leftover', `---\nname: apple-leftover\ndescription: 迁移来的\n---\n## 流程\n` + '# y\n'.repeat(30));
    await writeSkill(homeSkills, 'placeholder', `---\nname: placeholder\n---\nhi`);
    // 跨目录同名重复: cwd 也有 normal-skill
    await writeSkill(cwdSkills, 'normal-skill', `---\nname: normal-skill\ndescription: 项目级正常技能\n---\n## 背景\n` + '# z\n'.repeat(30));

    const leftovers = await scanLeftoverSkills({ home: tmpHome, cwd: tmpCwd });
    const names = leftovers.map((l) => l.name);
    expect(names).toContain('apple-leftover');
    expect(names).toContain('placeholder');
    // 同名重复检测 (normal-skill 在两级目录都有)
    expect(leftovers.some((l) => l.name === 'normal-skill' && l.reasons.includes('跨目录同名重复'))).toBe(true);
    // 只有 normal-skill 的 user 级本体不算遗留 (它本身正常)
    expect(leftovers.filter((l) => l.name === 'normal-skill' && !l.reasons.includes('跨目录同名重复'))).toHaveLength(0);
  });

  it('parseEvolveJson: 剥 markdown 代码块 + 取第一个 JSON', () => {
    const parsed = parseEvolveJson('```json\n{"name": "a", "description": "d", "body": "## 背景\\nb"}\n```');
    expect(parsed?.name).toBe('a');
    expect(parsed?.description).toBe('d');
    expect(parsed?.body).toContain('## 背景');
    expect(parseEvolveJson('no json')).toBeNull();
    expect(parseEvolveJson('')).toBeNull();
  });

  it('buildEvolvePrompt: 包含候选信息 + 要求完整结构', () => {
    const p = buildEvolvePrompt({ name: 'auto-a_b', description: 'desc', body: '## 流程\n1. 调用 a', runs: 2 });
    expect(p).toContain('auto-a_b');
    expect(p).toContain('已运行 2 次');
    expect(p).toContain('## 背景');
    expect(p).toContain('## 触发条件');
    expect(p).toContain('## 注意事项');
    expect(p).toContain('## 验证');
  });

  it('runSkillOrganize: 候选 → LLM 完整经验 → 转正 skill + 清理候选 + 遗留报告', async () => {
    // 造一个候选
    const candFile = await writeSkillCandidate({
      name: 'auto-p2p_debug',
      description: '自动候选: 2 个工具连续成功',
      body: '## 流程\n1. 调用 list_peers\n2. 调用 send_message',
      source: 'test',
      timestamp: new Date().toISOString(),
      signature: 'list_peers_send_message',
    });
    expect(candFile).toBeTruthy();

    // mock LLM: 返回完整经验 JSON
    const llm = async (prompt: string) => {
      expect(prompt).toContain('list_peers');
      return JSON.stringify({
        name: 'p2p-debug-v2',
        description: 'P2P 调试完整经验',
        body: '## 背景\n调试 P2P 连接\n## 触发条件\n连接失败时\n## 流程\n1. 调用 list_peers\n## 注意事项\n注意超时\n## 验证\npeer 可见',
      });
    };

    const r = await runSkillOrganize({ llm, source: 'test:organize', home: tmpHome, cwd: tmpCwd });
    expect(r.evolved).toContain('p2p-debug-v2');
    expect(r.scannedCandidates).toBeGreaterThanOrEqual(1);
    // 转正的 skill 落盘
    const skillFile = path.join(tmpHome, '.bolloon', 'skills', 'p2p-debug-v2', 'SKILL.md');
    const raw = await fs.readFile(skillFile, 'utf-8');
    expect(raw).toContain('name: p2p-debug-v2');
    expect(raw).toContain('## 触发条件');
    // 候选被清理
    const after = await listSkillCandidates(tmpHome);
    expect(after.some((c) => c.name === 'auto-p2p_debug')).toBe(false);
    // 遗留报告也在 (前面造了 apple-leftover / placeholder)
    expect(r.leftovers.length).toBeGreaterThan(0);
  });

  it('runSkillOrganize: 无 LLM → 只扫描 (evolve 降级)', async () => {
    const r = await runSkillOrganize({ evolve: true, home: tmpHome, cwd: tmpCwd }); // 不传 llm
    expect(r.evolved).toEqual([]);
    expect(Array.isArray(r.leftovers)).toBe(true);
  });

  it('startOrganizeHeartbeat: runOnce 触发 onStart/onEnd, 重入锁, stop', async () => {
    const events: string[] = [];
    const hb = startOrganizeHeartbeat({
      intervalMs: 5_000,
      onStart: () => events.push('start'),
      onEnd: () => events.push('end'),
      onError: () => events.push('error'),
      run: async () => {
        events.push('run');
        await new Promise((res) => setTimeout(res, 10));
        return { scannedCandidates: 0, evolved: [], leftovers: [] };
      },
    });
    // 并发 runOnce → 重入锁: 第二个立即返回 null, run 只执行一次
    const [r1, r2] = await Promise.all([hb.runOnce(), hb.runOnce()]);
    expect(r1).not.toBeNull();
    expect(r2).toBeNull();
    expect(events.filter((e) => e === 'run')).toHaveLength(1);
    expect(events).toContain('start');
    expect(events).toContain('end');
    hb.stop();
    const r3 = await hb.runOnce();
    expect(r3).toBeNull(); // stopped 后不再跑
  });

  it('startOrganizeHeartbeat: run 抛错 → onError', async () => {
    const events: string[] = [];
    const hb = startOrganizeHeartbeat({
      intervalMs: 5_000,
      onStart: () => events.push('start'),
      onEnd: () => events.push('end'),
      onError: (e) => events.push(`error:${e.message}`),
      run: async () => {
        throw new Error('boom');
      },
    });
    const r = await hb.runOnce();
    expect(r).toBeNull();
    expect(events).toContain('error:boom');
    hb.stop();
  });

  it('candidate 目录清理不误删其他候选', async () => {
    const f1 = await writeSkillCandidate({ name: 'auto-a', description: 'd1', body: 'b1', source: 't', timestamp: new Date().toISOString(), signature: 'a' });
    const f2 = await writeSkillCandidate({ name: 'auto-b', description: 'd2', body: 'b2', source: 't', timestamp: new Date().toISOString(), signature: 'b' });
    expect(f1).toBeTruthy();
    expect(f2).toBeTruthy();
    const all = await listSkillCandidates(tmpHome);
    expect(all.length).toBeGreaterThanOrEqual(2);
    // 清理 auto-a, auto-b 应保留
    for (const c of all) {
      if (c.name === 'auto-a') await fs.rm(c.file!, { force: true });
    }
    const after = await listSkillCandidates(tmpHome);
    expect(after.some((c) => c.name === 'auto-a')).toBe(false);
    expect(after.some((c) => c.name === 'auto-b')).toBe(true);
  });
});
