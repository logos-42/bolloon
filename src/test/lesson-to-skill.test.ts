/**
 * 教训 ⇒ 技能 (2026-10-01)。门锁三条纪律: 先找已有的 ✓ · 读后写 ✓ · 匹配不强就不写技能(防碎片化) ✓。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decideLessonSink, scoreLessonAgainstSkill, mergeLessonIntoBody, applyLessonToSkill,
  tokens, LESSON_MATCH_MIN_SCORE, LESSON_SECTION,
  routeLessonToSkill, ensureSinkSkill, SINK_SKILL_NAME, sinkSkillDir,
} from '../agents/lesson-to-skill.js';
import { shouldReviewTask, DEFAULT_MIN_INTERVAL_MS } from '../agents/experience-review.js';

let TMP = '';
beforeAll(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-lesson-')); });
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } });

const LESSON = { title: '提交后先等钩子跑完再改代码', body: '钩子跑着时改代码会被它的 git add 收进上一条提交, 造成提交信息与内容错位。', klass: 'bolloon-cli' };

describe('教训 ⇒ 技能的匹配与落盘', () => {
  it('**强**命中才有资格自动写技能(描述高度重合)', () => {
    const skills = [
      // 描述里几乎就是这条教训的用词 ⇒ 强命中(现实中对应"这条教训就是讲这个技能的")
      { name: 'bolloon-cli-commit-hooks', description: '提交后先等钩子跑完再改代码; 提交后先等钩子跑完再改代码, 免得 git add 把新改动收进上一条提交', file: path.join(TMP, 'a', 'SKILL.md') },
      { name: 'unrelated-skill', description: '量子色动力学格点计算', file: path.join(TMP, 'b', 'SKILL.md') },
    ];
    const d = decideLessonSink(LESSON, skills);
    expect(d.kind).toBe('skill');
    expect(d.skill!.name).toBe('bolloon-cli-commit-hooks');
    expect(d.score!).toBeGreaterThanOrEqual(LESSON_MATCH_MIN_SCORE);
  });
  it('弱/瞎命中(实测: 真教训撞 1300 个技能最高分只有 2) ⇒ 只留经验 + 给候选, 不自动改写', () => {
    const skills = [
      { name: 'note-taking-personal-vault-maintenance', description: '维护 Obsidian 个人 vault(迁移、MOC、git 提交)', file: path.join(TMP, 'z', 'SKILL.md') },
    ];
    const d = decideLessonSink(LESSON, skills);
    expect(d.kind).toBe('experience-only');
    expect(d.suggestions.length).toBeGreaterThan(0);        // 但要**把候选给人看**
    expect(d.suggestions[0].name).toBe('note-taking-personal-vault-maintenance');
    expect(d.reason).toContain('宁缺勿碎');
  });
  it('毫无匹配 ⇒ 只留经验, **不自动新建技能**(防碎片化)', () => {
    const d = decideLessonSink({ title: '完全无关的教训 zzz', body: 'qqq' }, [{ name: 'x', description: 'y', file: path.join(TMP, 'c', 'SKILL.md') }]);
    expect(d.kind).toBe('experience-only');
    expect(d.reason).toContain('宁缺勿碎');
  });
  it('没有文件路径的技能(只读库)不参与改写', () => {
    const d = decideLessonSink(LESSON, [{ name: 'bolloon-development', description: '改 Bolloon 仓库代码时的陷阱与闭环' }]);
    expect(d.kind).toBe('experience-only');
  });
  it('并进正文: 首次建"教训"小节; 同标题 ⇒ **更新那一条**, 不重复堆', () => {
    const a = mergeLessonIntoBody('# 技能\n\n正文', LESSON);
    expect(a.updated).toBe(false);
    expect(a.body).toContain(LESSON_SECTION);
    expect((a.body.match(/^- \*\*/gm) || []).length).toBe(1);
    const b = mergeLessonIntoBody(a.body, { ...LESSON, body: '换了个说法' });
    expect(b.updated).toBe(true);
    expect(b.body).toContain('换了个说法');
    expect((b.body.match(/^- \*\*/gm) || []).length).toBe(1);   // 还是 1 条
  });
  it('读后写: 文件不存在 ⇒ 不写; 空文件 ⇒ 不盲改', () => {
    expect(applyLessonToSkill({ name: 'n', file: path.join(TMP, 'nope', 'SKILL.md') }, LESSON).patched).toBe(false);
    const empty = path.join(TMP, 'empty', 'SKILL.md');
    fs.mkdirSync(path.dirname(empty), { recursive: true });
    fs.writeFileSync(empty, '', 'utf-8');
    const r = applyLessonToSkill({ name: 'n', file: empty }, LESSON);
    expect(r.patched).toBe(false);
    expect(fs.readFileSync(empty, 'utf-8')).toBe('');            // 没被动过
  });
  it('真读真写: 落盘后文件里确实多了一条教训', () => {
    const f = path.join(TMP, 'real', 'SKILL.md');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '# 真技能\n\n说明\n', 'utf-8');
    const r = applyLessonToSkill({ name: 'real', file: f }, LESSON);
    expect(r.patched).toBe(true);
    expect(fs.readFileSync(f, 'utf-8')).toContain(LESSON.title);
  });
  it('分词器: 中文 **3 字**窗口(2 字误命中率太高) + 英文词, 且去掉常见停用词', () => {
    const t = tokens('Bolloon 提交后先等钩子 the and');
    expect(t).toContain('提交后');
    expect(t).not.toContain('提交');                 // 2 字窗口已按实测数据弃用
    expect(t).toContain('bolloon');                  // 英文词照旧
    expect(t).not.toContain('the');
  });
});


describe('每次任务都复盘 (用户: 「自动每次做完任务都要总结经验」)', () => {
  it('★ 换了任务(签名变) ⇒ 立刻复盘 —— 哪怕离上次只过了 1 毫秒', () => {
    const now = 1_000_000;
    expect(shouldReviewTask(now, now - 1, 'sigA', 'sigB')).toBe(true);
  });
  it('同一任务重复 ⇒ 回到节流(免得反复审同一段)', () => {
    const now = 1_000_000;
    expect(shouldReviewTask(now, now - 1000, 'sigA', 'sigA')).toBe(false);
    expect(shouldReviewTask(now, now - DEFAULT_MIN_INTERVAL_MS - 1, 'sigA', 'sigA')).toBe(true);
  });
  it('从未复盘过 / 空签名 ⇒ 放行 (fail-open)', () => {
    expect(shouldReviewTask(1_000_000, undefined, undefined, 'sigA')).toBe(true);
    expect(shouldReviewTask(0, undefined, undefined, '')).toBe(true);
  });
});


describe('每条教训都必须进技能库 (用户: 「改为都进去进入技能和库」)', () => {
  it('★ 弱命中(现实中大多数) ⇒ 也进技能库: 写进沉淀技能 lessons-learned', () => {
    const partial = { name: 'note-taking-x', description: '提交后先等钩子跑完再改代码 相关的笔记与 vault 维护', file: path.join(TMP, 'zz', 'SKILL.md') };
    const r = routeLessonToSkill(LESSON, [partial], TMP);
    expect(r.skill.name).toBe(SINK_SKILL_NAME);                  // 没到强命中门槛 ⇒ 走沉淀
    expect(r.skill.patched).toBe(true);
    expect(r.candidates.length).toBeGreaterThan(0);              // 但候选要留痕
    const body = fs.readFileSync(r.skill.file, 'utf-8');
    expect(body).toContain(LESSON.title);                        // 教训确实进去了
    expect(body).toContain('候选技能');                            // 候选写在条目里(便于人工挑拣/管理)
    expect(body).toContain('note-taking-x');
  });
  it('沉淀技能**幂等**: 第二次不重建, 且同标题更新不堆', () => {
    const a = ensureSinkSkill(TMP);
    expect(a.created).toBe(false);                                // 上一条已建过
    const before = fs.readFileSync(a.file, 'utf-8');
    const r = routeLessonToSkill({ ...LESSON, body: '换了个说法' }, [], TMP);
    const after = fs.readFileSync(a.file, 'utf-8');
    expect(after).toContain('换了个说法');
    // 同标题 ⇒ 只更新那一条, 不重复堆(正文可能变短 —— 那是正常的, 不该断言长度 ✗)
    expect((after.match(new RegExp(`^- \\*\\*${LESSON.title}\\*\\*:`, 'gm')) || []).length).toBe(1);
    expect(before).toContain(LESSON.title);
  });
  it('强命中 ⇒ 写进那个技能(不走沉淀)', () => {
    const f = path.join(TMP, 'strong', 'SKILL.md');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '# strong\n', 'utf-8');
    const strong = { name: 'bolloon-cli-commit-hooks', description: '提交后先等钩子跑完再改代码; 提交后先等钩子跑完再改代码, 免得 git add 收进上一条提交', file: f };
    const r = routeLessonToSkill(LESSON, [strong], TMP);
    expect(r.skill.name).toBe('bolloon-cli-commit-hooks');
    expect(fs.readFileSync(f, 'utf-8')).toContain(LESSON.title);
  });
  it('沉淀技能位置在用户级技能库 (~/.bolloon/skills/lessons-learned)', () => {
    expect(sinkSkillDir(TMP)).toBe(path.join(TMP, '.bolloon', 'skills', 'lessons-learned'));
  });
});
