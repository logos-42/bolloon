/**
 * 回合后自审 → 沉淀库 (2026-10-01 用户「落实」)。
 * 关键性质都在这里门住: 节流 fail-open · 同教训=改不许加 · none 不写 · 绝不抛错 · 提示词反囤积 · 挂点存在。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  shouldReview, parseReviewDecision, applyExperience, buildReviewPrompt,
  runExperienceReview, experienceDir, DEFAULT_MIN_INTERVAL_MS,
} from '../agents/experience-review.js';

let TMP = '';
beforeAll(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-exp-')); });
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } });

describe('节流 (fail-open: 配置/时钟坏掉也放行)', () => {
  it('从未审过 ⇒ 放行', () => expect(shouldReview(Date.now(), 0)).toBe(true));
  it('刚审过 ⇒ 拦', () => expect(shouldReview(1_000_000, 999_999)).toBe(false));
  it('超过间隔 ⇒ 放行', () => expect(shouldReview(DEFAULT_MIN_INTERVAL_MS + 10, 1)).toBe(true));
  it('**时间戳坏 / 间隔配置坏 ⇒ 一律放行** (宁可多审, 不要因配置坏掉就永久不审)', () => {
    expect(shouldReview(NaN, 5)).toBe(true);
    expect(shouldReview(100, 5, NaN)).toBe(true);
    expect(shouldReview(100, 5, 0)).toBe(true);
  });
});

describe('解析 (容错, 绝不半写)', () => {
  it('none ⇒ none', () => expect(parseReviewDecision('{"action":"none"}').action).toBe('none'));
  it('非 JSON / 缺字段 ⇒ none', () => {
    expect(parseReviewDecision('随便说点什么').action).toBe('none');
    expect(parseReviewDecision('{"action":"write","title":""}').action).toBe('none');
    expect(parseReviewDecision('{"action":"write","title":"x"}').action).toBe('none');
  });
  it('带包装文字也能取出 JSON', () => {
    const d = parseReviewDecision('好的 \n {"action":"write","class":"Cli","title":"T","body":"B"} \n 完');
    expect(d).toMatchObject({ action: 'write', klass: 'cli', title: 'T', body: 'B' });
  });
});

describe('落库 (同一教训 = 更新那一条, 不是加一条)', () => {
  it('首写 ⇒ 新条目; 再写同 title ⇒ 更新 + hit 递增 + 文件里仍只有一条', () => {
    const d1 = { action: 'write' as const, klass: 'cli', title: '分界线要满宽', body: '规矩 A' };
    const r1 = applyExperience(d1, TMP);
    expect(r1.wrote).toBe(true);
    expect(r1.wrote && r1.updated).toBe(false);
    const d2 = { action: 'write' as const, klass: 'cli', title: '分界线要满宽', body: '规矩 A 修订版' };
    const r2 = applyExperience(d2, TMP);
    expect(r2.wrote && r2.updated).toBe(true);
    const body = fs.readFileSync(path.join(experienceDir(TMP), 'cli.md'), 'utf-8');
    expect((body.match(/^## /gm) || []).length).toBe(1);   // **只有一条**
    expect(body).toContain('规矩 A 修订版');                // 内容被更新
    expect(body).toContain('hit:2');                        // 走的是"更新"路径 (计数 +1), 不是新增一条
    expect(body.split('规矩 A').length - 1, '同一条正文只该出现一次').toBe(1);
  });
  it('类级分文件 (不同 class ⇒ 不同文件)', () => {
    applyExperience({ action: 'write', klass: 'identity', title: '身份按 agent 取', body: 'X' }, TMP);
    expect(fs.existsSync(path.join(experienceDir(TMP), 'identity.md'))).toBe(true);
  });
  it('没有标题/正文 ⇒ 什么都不写', () => {
    const before = fs.readdirSync(experienceDir(TMP)).length;
    expect(applyExperience({ action: 'write', title: '', body: 'x' }, TMP).wrote).toBe(false);
    expect(fs.readdirSync(experienceDir(TMP)).length).toBe(before);
  });
});

describe('提示词: 反囤积规矩必须在 (库干净还是垃圾堆的分水岭)', () => {
  it('含: 同一教训=一条 · 不要沉淀事件叙述 · 写空是正常 · 只回 JSON', () => {
    const p = buildReviewPrompt('turn', '(库空)');
    for (const kw of ['同一教训学两次', '不要', '写空是正常结果', 'J SON'.replace(' ', ''), '可复用']) {
      expect(p, `缺 ${kw}`).toContain(kw);
    }
  });
});

describe('编排: 绝不抛错 + 按规矩不写', () => {
  it('模型回 none ⇒ reviewed=true 但 applied=false, 库不变', async () => {
    const before = fs.existsSync(experienceDir(TMP)) ? fs.readdirSync(experienceDir(TMP)).length : 0;
    const r = await runExperienceReview({ turnSummary: 'x'.repeat(100), chat: async () => '{"action":"none"}', home: TMP });
    expect(r.reviewed).toBe(true);
    expect(r.applied).toBe(false);
    expect(fs.existsSync(experienceDir(TMP)) ? fs.readdirSync(experienceDir(TMP)).length : 0).toBe(before);
  });
  it('**chat 抛错 ⇒ 只返回 error, 不向外抛** (主回合绝不能被它带崩)', async () => {
    const r = await runExperienceReview({ turnSummary: 'y'.repeat(100), chat: async () => { throw new Error('boom'); }, home: TMP });
    expect(r.reviewed).toBe(false);
    expect(r.reason).toBe('error');
  });
  it('回合太短 ⇒ 连模型都不叫', async () => {
    let called = false;
    const r = await runExperienceReview({ turnSummary: 'hi', chat: async () => { called = true; return '{}'; }, home: TMP });
    expect(r.reviewed).toBe(false);
    expect(called).toBe(false);
  });
  it('节流生效时也不叫模型', async () => {
    let called = false;
    const r = await runExperienceReview({ turnSummary: 'z'.repeat(100), chat: async () => { called = true; return '{}'; }, home: TMP, nowMs: 1000, lastAtMs: 999 });
    expect(r.reviewed).toBe(false);
    expect(called).toBe(false);
  });
});

describe('挂点存在 (源级核对: 别只写了模块忘了接)', () => {
  it('pi-sdk 里 runExperienceReview 被调用, 且挂点在 runReActLoop 之后', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/agents/pi-sdk.ts'), 'utf-8');
    expect(src).toContain('runExperienceReview({');
    expect(src).toContain('shouldReviewTask(reviewNow');
      // 2026-10-01: 判定从"每 10 分钟一次"(shouldReview) 换成"**换任务就立刻复盘**(shouldReviewTask)" ——
      //   用户要的是「自动每次做完任务都要总结经验」⇒ 门跟着核对**新契约**(不是留着老写法 ✗)
      expect(src).toContain('taskSig');
      // 同一条教训还要**接入判断力系统**(不只落经验文件)
      expect(src).toContain('storeHumanJudgment(');
      expect(src).toContain('onLesson');
  });
});


describe('复盘的两条保命线 (用户: 「卡在这就不动了」)', () => {
  it('① chat 超时 ⇒ 如实放行, 绝不许挂死', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-timeout-'));
    const hang = () => new Promise<string>(() => { /* 永不返回 */ });
    const r = await runExperienceReview({ turnSummary: 'x'.repeat(120), chat: hang as any, home, force: true, nowMs: 10, log: () => {} });
    expect(r.reviewed).toBe(false);
    expect(r.reason).toBe('chat-timeout');
  }, 40_000);
  it('② 模型给散文而非 JSON ⇒ 宽解析仍能拿到 write(不再白跑)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-lenient-'));
    const prose = async () => '我的判断是 action: write\ntitle: 提交后先等钩子跑完\nbody: 钩子在后台跑时改源码会被卷进那条提交, 先 wait 再动代码。';
    const r = await runExperienceReview({ turnSummary: 'y'.repeat(120), chat: prose, home, force: true, nowMs: 20, log: () => {} });
    expect(r.applied).toBe(true);
  });
});
