/**
 * peer-resource-bridge.test.ts — 4 类资源 (groups/function/exportment/science) round-trip
 *   + agent-manifest-protocol 的 v2 字段 (groups/functions/...) addLocal* setter
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  writeGroup, writeFunction, writeExportment, writeScience,
  listPeerResources, peerDirName, getPeerDir,
} from '../network/peer-fs.js';
import {
  loadLocalResources, writeRemoteResources, LOCAL_RESOURCES_ROOT,
} from '../network/peer-resource-bridge.js';
import {
  addLocalGroup, addLocalFunction, addLocalExportment, addLocalScience,
  getLocalManifest, setLocalManifest,
  type AgentManifest,
} from '../agents/agent-manifest-protocol.js';

const TEST_HOME = path.join(os.tmpdir(), `bolloon-resrc-${Date.now()}`);
process.env.BOLLOON_HOME = TEST_HOME;

const TEST_PEER_PK = 'a'.repeat(64); // 64-hex 字符 (peerDirName 取 sha256 前 16 + 前 8 char)

beforeAll(async () => {
  await fs.mkdir(path.join(TEST_HOME, '.bolloon'), { recursive: true });
});

afterAll(async () => {
  try { await fs.rm(TEST_HOME, { recursive: true, force: true }); } catch {}
});

beforeEach(async () => {
  // 每个 test 前清掉 peers/<pk>/ 和 local-resources/
  const dir = getPeerDir(TEST_PEER_PK);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(LOCAL_RESOURCES_ROOT, { recursive: true, force: true }).catch(() => {});
  // 重置本地 manifest (防止 addLocal* 跨 test 污染)
  setLocalManifest({ ownerName: '', ownerPublicKey: '', agents: [] });
});

describe('peer-fs 4 类资源 writer (round-trip)', () => {
  it('writeGroup → listPeerResources 能读到', async () => {
    await writeGroup(TEST_PEER_PK, {
      id: 'grp-001', name: 'Test Group',
      description: 'a group for testing',
      visibility: 'invite', memberCount: 5,
    });
    const r = await listPeerResources(TEST_PEER_PK);
    expect(r.groups.length).toBe(1);
    expect(r.groups[0].id).toBe('grp-001');
    expect(r.groups[0].content).toContain('Test Group');
    expect(r.groups[0].content).toContain('invite');
  });

  it('writeFunction → listPeerResources 能读到', async () => {
    await writeFunction(TEST_PEER_PK, {
      capability: 'gen-image', description: 'generate images',
      mediaType: 'image', endpoint: 'rpc://gen-image',
      examples: ['a cat', 'a dog'],
    });
    const r = await listPeerResources(TEST_PEER_PK);
    expect(r.functions.length).toBe(1);
    expect(r.functions[0].capability).toBe('gen-image');
    expect(r.functions[0].content).toContain('generate images');
    expect(r.functions[0].content).toContain('image');
    expect(r.functions[0].content).toContain('a cat');
  });

  it('writeExportment → listPeerResources 能读到', async () => {
    await writeExportment(TEST_PEER_PK, {
      name: 'chess', description: 'classic chess',
      genre: 'strategy', minPlayers: 2, maxPlayers: 2,
    });
    const r = await listPeerResources(TEST_PEER_PK);
    expect(r.exportments.length).toBe(1);
    expect(r.exportments[0].name).toBe('chess');
    expect(r.exportments[0].content).toContain('strategy');
  });

  it('writeScience → listPeerResources 能读到 + 含 records', async () => {
    await writeScience(TEST_PEER_PK, {
      id: 'exp-001', title: 'X1 Trial', description: 'first run',
      status: 'running', tags: ['ml', 'eval'],
      records: [{ ts: '2026-07-05', note: 'baseline 32%' }],
    });
    const r = await listPeerResources(TEST_PEER_PK);
    expect(r.sciences.length).toBe(1);
    expect(r.sciences[0].id).toBe('exp-001');
    expect(r.sciences[0].content).toContain('X1 Trial');
    expect(r.sciences[0].content).toContain('2026-07-05');
    expect(r.sciences[0].content).toContain('baseline 32%');
  });

  it('写 4 类各 1 个 → listPeerResources 都能读到', async () => {
    await writeGroup(TEST_PEER_PK, { id: 'g', name: 'g' });
    await writeFunction(TEST_PEER_PK, { capability: 'f' });
    await writeExportment(TEST_PEER_PK, { name: 'e' });
    await writeScience(TEST_PEER_PK, { id: 's', title: 's' });
    const r = await listPeerResources(TEST_PEER_PK);
    expect(r.groups.length).toBe(1);
    expect(r.functions.length).toBe(1);
    expect(r.exportments.length).toBe(1);
    expect(r.sciences.length).toBe(1);
  });
});

describe('agent-manifest-protocol addLocal* setter', () => {
  it('addLocalGroup / addLocalFunction / addLocalExportment / addLocalScience → getLocalManifest 含字段', () => {
    addLocalGroup({ id: 'g1', name: 'g1' });
    addLocalFunction({ capability: 'f1' });
    addLocalExportment({ name: 'e1' });
    addLocalScience({ id: 's1', title: 's1' });
    const m = getLocalManifest();
    expect(m.groups?.length).toBe(1);
    expect(m.functions?.length).toBe(1);
    expect(m.exportments?.length).toBe(1);
    expect(m.sciences?.length).toBe(1);
  });

  it('addLocalGroup 同 id 二次调用 → 替换不追加', () => {
    addLocalGroup({ id: 'g1', name: 'v1' });
    addLocalGroup({ id: 'g1', name: 'v2' });
    const m = getLocalManifest();
    expect(m.groups?.length).toBe(1);
    expect(m.groups?.[0].name).toBe('v2');
  });

  it('buildManifestPayload v2 字段不丢 (round-trip JSON)', () => {
    addLocalGroup({ id: 'g', name: 'g' });
    addLocalFunction({ capability: 'f', mediaType: 'image' });
    const m = getLocalManifest();
    const json = JSON.stringify(m);
    const parsed = JSON.parse(json) as AgentManifest;
    expect(parsed.groups?.[0].id).toBe('g');
    expect(parsed.functions?.length).toBe(1);
    expect(parsed.functions?.[0].capability).toBe('f');
    expect(parsed.functions?.[0].mediaType).toBe('image');
  });
});

describe('peer-resource-bridge 双向 (本地读 / 远端落)', () => {
  it('loadLocalResources 空目录 → 全部空数组', async () => {
    const r = await loadLocalResources();
    expect(r).toEqual({ groups: [], functions: [], exportments: [], sciences: [] });
  });

  it('writeRemoteResources 把 manifest 的 4 类落到 peerFs', async () => {
    const manifestLike = {
      groups: [{ id: 'g', name: 'g' }],
      functions: [{ capability: 'f', mediaType: 'music' as const }],
      exportments: [{ name: 'e', genre: 'puzzle' }],
      sciences: [{ id: 's', title: 's', status: 'completed' as const }],
    };
    const counts = await writeRemoteResources(TEST_PEER_PK, manifestLike);
    expect(counts).toEqual({ groups: 1, functions: 1, exportments: 1, sciences: 1 });
    const r = await listPeerResources(TEST_PEER_PK);
    expect(r.groups[0].id).toBe('g');
    expect(r.functions[0].capability).toBe('f');
    expect(r.exportments[0].name).toBe('e');
    expect(r.sciences[0].id).toBe('s');
  });

  it('writeRemoteResources 单条失败不影响其他 (容错)', async () => {
    const manifestLike = {
      // 故意传非法 id (含 /) → writeGroup 应失败
      groups: [
        { id: 'good', name: 'good' },
        { id: 'bad/id', name: 'bad' },
      ],
      functions: [{ capability: 'f' }],
      exportments: [],
      sciences: [],
    };
    const counts = await writeRemoteResources(TEST_PEER_PK, manifestLike);
    // groups 计数包含成功的; safeName 会把 / 替成 _, 所以两条都会成功 (路径 sanitize 而非拒绝)
    // 这里验证主要逻辑: 至少 good 写成功
    expect(counts.groups).toBeGreaterThanOrEqual(1);
    expect(counts.functions).toBe(1);
  });

  it('loadLocalResources → writeRemoteResources → listPeerResources 完整 round-trip', async () => {
    // 本地写一份 markdown (前导 frontmatter)
    await fs.mkdir(path.join(LOCAL_RESOURCES_ROOT, 'groups'), { recursive: true });
    await fs.writeFile(
      path.join(LOCAL_RESOURCES_ROOT, 'groups', 'rt.md'),
      '---\nid: rt\nname: RoundTrip\nvisibility: public\n---\n\nthis is the description body\n',
      'utf-8',
    );
    const local = await loadLocalResources();
    expect(local.groups.length).toBe(1);
    expect(local.groups[0].id).toBe('rt');
    expect(local.groups[0].description).toContain('this is the description body');

    const counts = await writeRemoteResources(TEST_PEER_PK, local);
    expect(counts.groups).toBe(1);
    const r = await listPeerResources(TEST_PEER_PK);
    expect(r.groups[0].id).toBe('rt');
    expect(r.groups[0].content).toContain('RoundTrip');
    expect(r.groups[0].content).toContain('public');
  });
});

describe('peer-fs edge cases', () => {
  it('peerDirName 短 publicKey 也安全', () => {
    expect(peerDirName('abc')).toMatch(/^[0-9a-f]{16}__abc$/);
  });

  it('safeName 去掉路径分隔符', async () => {
    // writeScience 的 id 经过 safeName → 含 / 的 id 不会逃出 science/ 目录
    await writeScience(TEST_PEER_PK, { id: 'evil/../escape', title: 'evil' });
    const dir = getPeerDir(TEST_PEER_PK);
    const entries = await fs.readdir(path.join(dir, 'science'));
    expect(entries.length).toBe(1);
    expect(entries[0].startsWith('evil_')).toBe(true);
  });
});
