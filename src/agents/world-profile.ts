/**
 * world-profile.ts — 用户画像 (初始化阶段收集, 常驻意图)
 *
 * leo (2026-10-05) 三条分发规划之③: 结合用户画像推送 —— 初始化时 AI 获取
 * 「你是谁/在做什么/标签」, 无 active intent 时画像标签当常驻意图参与匹配。
 * 独立文件是为了避免 opportunity-match ↔ world-watcher 循环依赖。
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { worldDir } from './intent-store.js';

export interface WorldProfile {
  name: string;
  about: string;
  tags: string[];
  updatedAt: number;
}

const profileFile = (): string => path.join(worldDir(), 'profile.json');

export async function readProfile(): Promise<WorldProfile | null> {
  try {
    const raw = await fs.readFile(profileFile(), 'utf-8');
    const p = JSON.parse(raw) as Partial<WorldProfile>;
    if (!p || typeof p !== 'object') return null;
    return {
      name: String(p.name || ''),
      about: String(p.about || ''),
      tags: Array.isArray(p.tags) ? p.tags.filter((t) => typeof t === 'string') : [],
      updatedAt: Number(p.updatedAt) || Date.now(),
    };
  } catch { return null; }
}

/** 写/更新用户画像 (初始化收集用) */
export async function setProfile(input: { name?: string; about?: string; tags?: string[] }): Promise<{ ok: boolean; profile: WorldProfile; error?: string }> {
  const prev = await readProfile();
  const profile: WorldProfile = {
    name: String(input.name ?? prev?.name ?? '').trim(),
    about: String(input.about ?? prev?.about ?? '').trim(),
    tags: Array.isArray(input.tags) ? input.tags.map((t) => String(t).trim()).filter(Boolean) : (prev?.tags ?? []),
    updatedAt: Date.now(),
  };
  if (!profile.name && !profile.about && !profile.tags.length) {
    return { ok: false, profile, error: '画像至少要有一个字段 (name/about/tags)' };
  }
  try {
    await fs.mkdir(path.dirname(profileFile()), { recursive: true });
    await fs.writeFile(profileFile(), JSON.stringify(profile, null, 2) + '\n', { mode: 0o600 });
    return { ok: true, profile };
  } catch (err) {
    return { ok: false, profile, error: String(err instanceof Error ? err.message : err) };
  }
}
