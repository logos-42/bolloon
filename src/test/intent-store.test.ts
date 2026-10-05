/**
 * intent-store.test.ts — Intent Store (2026-10-05, Intent Network P0)
 *
 * 测: world/intents 目录布局 (leo: 「intents 专门设计一个文件夹」「world 也是文件夹」) ·
 * 一意图一文件 · set 幂等 · list/get/remove · 坏文件不崩 · 路径穿越防护。
 * 全部用隔离 HOME, 不碰真实 ~/.bolloon。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import {
  worldDir, intentsDir, intentFile,
  setIntent, listIntents, getIntent, removeIntent, extractTags, bumpMatchedCount,
} from '../agents/intent-store.js';

const tmpRoot = path.join(os.tmpdir(), 'bolloon-intent-test-' + Date.now());
const fakeHome = path.join(tmpRoot, 'home');

describe('intent-store (World 目录布局 · 一意图一文件)', () => {
  beforeEach(async () => {
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(fakeHome, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('目录结构: world/ + intents/ (leo 要求专门文件夹)', async () => {
    await setIntent({ text: '建立聚变公司' });
    const wd = worldDir();
    const id = intentsDir();
    expect(wd.endsWith(path.join('.bolloon', 'world'))).toBe(true);
    expect(id.endsWith(path.join('world', 'intents'))).toBe(true);
    const stat = await fs.stat(id);
    expect(stat.isDirectory()).toBe(true);
  });

  it('一意图一文件 (int_<id>.json), 不只一个聚合文件', async () => {
    const a = await setIntent({ text: '意图A' });
    const b = await setIntent({ text: '意图B' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    const dirEntries = await fs.readdir(intentsDir());
    expect(dirEntries).toHaveLength(2);
    expect(dirEntries).toContain(`${a.intent!.id}.json`);
    expect(dirEntries).toContain(`${b.intent!.id}.json`);
    // 文件内容是真意图, 不是聚合数组
    const raw = JSON.parse(await fs.readFile(intentFile(a.intent!.id)!, 'utf-8'));
    expect(raw.id).toBe(a.intent!.id);
    expect(raw.text).toBe('意图A');
  });

  it('同 text 幂等: 不重复建文件, 更新已有', async () => {
    const a = await setIntent({ text: '聚变仿真', tags: ['fusion'] });
    const b = await setIntent({ text: '聚变仿真', priority: 5 });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.intent!.id).toBe(a.intent!.id);
    expect(b.intent!.priority).toBe(5);
    expect(b.intent!.tags).toContain('fusion');
    expect(await fs.readdir(intentsDir())).toHaveLength(1);
  });

  it('标签提取: 英文词 + 中文词元 + 手工标签', () => {
    const tags = extractTags('建立 fusion 聚变创业公司', ['plasma']);
    expect(tags).toContain('fusion');
    expect(tags.some((t) => t.includes('聚变'))).toBe(true);
    expect(tags.some((t) => t.includes('创业'))).toBe(true);
    expect(tags).toContain('plasma');
  });

  it('list: 按创建倒序 + status 过滤', async () => {
    await setIntent({ text: '先声明' });
    await new Promise((r) => setTimeout(r, 5));
    await setIntent({ text: '后声明' });
    const all = await listIntents();
    expect(all.intents).toHaveLength(2);
    expect(all.intents[0].text).toBe('后声明'); // 倒序
    const active = await listIntents(undefined, 'active');
    expect(active.intents).toHaveLength(2);
    const done = await listIntents(undefined, 'done');
    expect(done.intents).toHaveLength(0);
  });

  it('get: 按 id 读单条; 不存在 → ok 无 intent', async () => {
    const a = await setIntent({ text: '读我' });
    const r = await getIntent(a.intent!.id);
    expect(r.ok).toBe(true);
    expect(r.intent!.text).toBe('读我');
    const miss = await getIntent('int_00000000000000');
    expect(miss.ok).toBe(true);
    expect(miss.intent).toBeUndefined();
  });

  it('remove: 删文件; --done 归档不删', async () => {
    const a = await setIntent({ text: '删我' });
    const done = await removeIntent(a.intent!.id, true);
    expect(done.ok).toBe(true);
    const after = await getIntent(a.intent!.id);
    expect(after.intent!.status).toBe('done');
    // 再删 (真的删掉)
    const rm = await removeIntent(a.intent!.id);
    expect(rm.ok).toBe(true);
    const miss = await getIntent(a.intent!.id);
    expect(miss.intent).toBeUndefined();
    expect(await fs.readdir(intentsDir())).toHaveLength(0);
  });

  it('remove 不存在 → 报错不崩', async () => {
    const r = await removeIntent('int_ffffffffffffff');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/没有意图|非法/);
  });

  it('路径穿越防护: 非法 id 拿不到文件路径', () => {
    expect(intentFile('../../etc/passwd')).toBeNull();
    expect(intentFile('int_')).toBeNull();
    expect(intentFile('int_a!b')).toBeNull();
    expect(intentFile('int_abcdef123456')).not.toBeNull();
  });

  it('坏文件: 目录里一个损坏 json 不拖垮整列', async () => {
    await setIntent({ text: '好的那个' });
    await fs.writeFile(path.join(intentsDir(), 'int_broken000001.json'), '{ not json', 'utf-8');
    const all = await listIntents();
    expect(all.ok).toBe(true);
    expect(all.intents).toHaveLength(1);
    expect(all.intents[0].text).toBe('好的那个');
  });

  it('bumpMatchedCount: 匹配数 +1 落盘', async () => {
    const a = await setIntent({ text: '计数' });
    await bumpMatchedCount(a.intent!.id);
    await bumpMatchedCount(a.intent!.id);
    const r = await getIntent(a.intent!.id);
    expect(r.intent!.matchedCount).toBe(2);
  });

  it('空优先: priority 越界拒绝', async () => {
    const r = await setIntent({ text: 'x', priority: 9 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/1-5/);
  });
});