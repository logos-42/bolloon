/**
 * x402-bridge.test.ts — 判断力资产 x402 化: 打包往返 / 发布落盘 / 判断调用 (LLM stub)
 *
 * 隔离 env 双设 (judgeness 用 BOLLOON_HOME, 参考 skill 陷阱): BOLLOON_HOME 必须是完整 .bolloon 路径。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { JudgenessDescription } from '../../judgeness/types.js';
import { saveDescription, loadDescription } from '../../judgeness/store.js';
import {
  judgenessToPaidMarkdown, parsePaidJudgeness, publishJudgenessAsPaidInfo, sellingUrl,
} from '../../judgeness/paid-export.js';
import {
  buildJudgeSystemPrompt, buildJudgeUserPrompt, parseJudgment, judgeWithAsset,
} from '../../judgeness/call-service.js';
import { x402InfoDir } from '../../agents/x402/paid-info-store.js';

let tmpHome: string;
let oldHome: string | undefined;
let oldBolloonHome: string | undefined;

const SAMPLE_JD: JudgenessDescription = {
  descriptionId: 'jd-test-abc123',
  judgmentRef: 'hv-test-ref',
  description_version: 1,
  facets: { judgment: 0.9, taste_aesthetic: 0.7, novelty_score: 0.6, imaginative_score: 0.4, curiosity_vector: 0.8 },
  basis: { taste_basis: '偏好极简与留白', novelty_basis: '先验证再引入新做法', imagination_basis: '跨域类比时保真优先' },
  scope: { domains: ['code'], topics: ['架构'] },
  visibility: 'public',
  openState: 'open',
  by: 'human',
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-20T00:00:00.000Z',
};

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'x402-bridge-'));
  oldHome = process.env.HOME;
  oldBolloonHome = process.env.BOLLOON_HOME;
  process.env.HOME = tmpHome;
  process.env.BOLLOON_HOME = path.join(tmpHome, '.bolloon');
});

afterEach(async () => {
  if (oldHome !== undefined) process.env.HOME = oldHome;
  if (oldBolloonHome !== undefined) process.env.BOLLOON_HOME = oldBolloonHome;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe('judgenessToPaidMarkdown / parsePaidJudgeness (打包往返)', () => {
  it('打包→解析 还原 5 维/basis/scope/id', async () => {
    const md = judgenessToPaidMarkdown(SAMPLE_JD);
    expect(md).toContain('# 判断力资产 jd-test-abc123');
    expect(md).toContain('- judgment: 0.9');
    expect(md).toContain('- taste_basis: 偏好极简与留白');

    const parsed = parsePaidJudgeness(md);
    expect(parsed).not.toBeNull();
    expect(parsed!.descriptionId).toBe('jd-test-abc123');
    expect(parsed!.judgmentRef).toBe('hv-test-ref');
    expect(parsed!.facets.judgment).toBe(0.9);
    expect(parsed!.facets.novelty_score).toBe(0.6);
    expect(parsed!.basis.taste_basis).toBe('偏好极简与留白');
    expect(parsed!.domains).toEqual(['code']);
    expect(parsed!.topics).toEqual(['架构']);
  });

  it('缺省维/依据 解析为 undefined 而不是 NaN/空串', () => {
    const jd: JudgenessDescription = {
      ...SAMPLE_JD,
      descriptionId: 'jd-test-empty',
      facets: {},
      basis: {},
    };
    const md = judgenessToPaidMarkdown(jd);
    const parsed = parsePaidJudgeness(md)!;
    expect(parsed.facets.judgment).toBeUndefined();
    expect(parsed.basis.taste_basis).toBeUndefined();
  });

  it('非判断力资产内容 → null', () => {
    expect(parsePaidJudgeness('随便一段普通文本')).toBeNull();
  });
});

describe('publishJudgenessAsPaidInfo (发布落盘)', () => {
  it('发布后 x402-info 目录出现条目, 内容含判断力资产标题', async () => {
    await saveDescription(SAMPLE_JD);
    // 假身份文件 (provider 需要 did)
    await fs.mkdir(path.join(tmpHome, '.bolloon'), { recursive: true });
    await fs.writeFile(
      path.join(tmpHome, '.bolloon', 'identity.json'),
      JSON.stringify({ did: 'did:key:zTest123456789', name: '测试卖方' }),
    );

    const { item, markdown } = await publishJudgenessAsPaidInfo('jd-test-abc123', {
      amount: '0.01',
      payTo: '0x1234567890123456789012345678901234567890',
      home: tmpHome,
    });
    expect(item.id).toBeTruthy();
    expect(item.category).toBe('data');
    expect(item.price.amount).toBe('0.01');
    expect(item.price.payTo).toMatch(/^0x/);
    expect(item.provider.did).toBe('did:key:zTest123456789');
    expect(item.contentHash).toMatch(/^sha256:/);
    expect(markdown).toContain('判断力资产');
    expect(sellingUrl(item.id)).toContain(`/api/x402/info/${item.id}`);

    // 读回落盘文件
    const files = await fs.readdir(x402InfoDir(tmpHome));
    expect(files.length).toBe(1);
    const stored = JSON.parse(await fs.readFile(path.join(x402InfoDir(tmpHome), files[0]), 'utf-8'));
    expect(stored.item.id).toBe(item.id);
    expect(stored.content).toContain('# 判断力资产 jd-test-abc123');
  });

  it('jd 不存在 → 报错', async () => {
    await expect(
      publishJudgenessAsPaidInfo('jd-not-exist', { amount: '0.01', payTo: '0x1234567890123456789012345678901234567890' }),
    ).rejects.toThrow('判断力资产不存在');
  });

  it('缺 payTo → 报错', async () => {
    await saveDescription(SAMPLE_JD);
    await expect(
      publishJudgenessAsPaidInfo('jd-test-abc123', { amount: '0.01', payTo: '' }),
    ).rejects.toThrow('payTo 必填');
  });
});

describe('parseJudgment (容错解析)', () => {
  it('裸 JSON 通过', () => {
    const r = parseJudgment('{"verdict":"approve","confidence":0.8,"reasoning":"符合资产判断依据"}');
    expect(r).toEqual({ verdict: 'approve', confidence: 0.8, reasoning: '符合资产判断依据', values: undefined, assetId: undefined });
  });

  it('```json 围栏 + 杂讯通过', () => {
    const r = parseJudgment('好的，我的判断如下：\n```json\n{"verdict":"reject","confidence":0.6,"reasoning":"与 taste_basis 冲突","values":["谨慎"]}\n```\n完');
    expect(r!.verdict).toBe('reject');
    expect(r!.confidence).toBe(0.6);
    expect(r!.values).toEqual(['谨慎']);
  });

  it('verdict 非法 / 无 reasoning / 非 JSON → null', () => {
    expect(parseJudgment('{"verdict":"maybe","confidence":0.5,"reasoning":"x"}')).toBeNull();
    expect(parseJudgment('{"verdict":"approve","confidence":0.5}')).toBeNull();
    expect(parseJudgment('这不是 JSON')).toBeNull();
  });

  it('confidence 越界被夹回 0..1', () => {
    expect(parseJudgment('{"verdict":"approve","confidence":1.7,"reasoning":"x"}')!.confidence).toBe(1);
    expect(parseJudgment('{"verdict":"approve","confidence":-0.2,"reasoning":"x"}')!.confidence).toBe(0);
  });
});

describe('judgeWithAsset (判断调用核心, LLM stub)', () => {
  const assetText = judgenessToPaidMarkdown(SAMPLE_JD);

  it('LLM 返回合法裁决 → 结构化结果 (带 assetId)', async () => {
    const r = await judgeWithAsset({
      assetText,
      question: '要不要先重构再上功能?',
      llm: async (system, user) => {
        expect(system).toContain('判断力执行器');
        expect(system).toContain('jd-test-abc123');
        expect(user).toContain('要不要先重构再上功能?');
        return '{"verdict":"approve","confidence":0.9,"reasoning":"依据 judgment 0.9 与 taste_basis, 值得先重构"}';
      },
    });
    expect(r).not.toBeNull();
    expect(r!.verdict).toBe('approve');
    expect(r!.confidence).toBe(0.9);
    expect(r!.assetId).toBe('jd-test-abc123');
  });

  it('LLM 返回 null (不可用) → null', async () => {
    const r = await judgeWithAsset({ assetText, question: 'q', llm: async () => null });
    expect(r).toBeNull();
  });

  it('LLM 输出不可解析 → null', async () => {
    const r = await judgeWithAsset({ assetText, question: 'q', llm: async () => '抱歉我无法判断' });
    expect(r).toBeNull();
  });

  it('prompt 组装: system 含资产, user 含问题与背景', () => {
    const sys = buildJudgeSystemPrompt(assetText);
    const user = buildJudgeUserPrompt('q1', 'ctx1');
    expect(sys).toContain('judgment: 0.9');
    expect(sys).toContain('verdict');
    expect(user).toContain('问题: q1');
    expect(user).toContain('背景: ctx1');
  });
});
