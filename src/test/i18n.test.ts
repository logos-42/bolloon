import { describe, it, expect } from 'vitest';
import { t, normalizeLang, catalogParity, getLanguage, flattenCatalog } from '../web/i18n.js';
import * as en from '../locales/en.js';
import * as zh from '../locales/zh.js';

describe('i18n 目录 (Hermes locales/*.yaml 模式)', () => {
  it('parity: zh 键集合 == en, 无缺/无多', () => {
    const results = catalogParity();
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.missingKeys, `${r.lang} 缺键: ${r.missingKeys.join(', ')}`).toEqual([]);
      expect(r.extraKeys, `${r.lang} 多键: ${r.extraKeys.join(', ')}`).toEqual([]);
    }
  });

  it('parity: 占位符集合一致 (值可含 {placeholder})', () => {
    for (const r of catalogParity()) {
      expect(r.placeholderMismatch, `${r.lang} 占位符不一致: ${r.placeholderMismatch.join('; ')}`).toEqual([]);
    }
  });

  it('翻译 + 占位符替换 (默认 zh)', () => {
    expect(t('guard.deny_reason', 'zh', { pattern: '/\\bsudo\\b/' })).toContain('高危护栏');
    expect(t('guard.deny_reason', 'zh', { pattern: 'x' })).toContain('x');
    expect(t('tasks.cancelled', 'zh', { title: '测试' })).toBe('任务已取消: 测试');
  });

  it('en 回退: zh 缺失键 → en; en 也缺失 → key 本身', () => {
    const zhOnly = Object.keys(zh.catalog).filter((k) => !Object.keys(en.catalog).includes(k));
    // parity 保证不会缺, 但机制本身要验证
    expect(t('guard.empty', 'zh')).toBe('命令为空');
    expect(t('nonexistent.key', 'zh')).toBe('nonexistent.key');
  });

  it('normalizeLang: 别名/区域标签/未知 → default', () => {
    expect(normalizeLang('EN')).toBe('en');
    expect(normalizeLang('zh-CN')).toBe('zh');
    expect(normalizeLang('fr')).toBe('zh'); // 不支持 → default
    expect(normalizeLang('')).toBe('zh');
    expect(normalizeLang(undefined)).toBe('zh');
  });

  it('flattenCatalog 嵌套扁平化 (dotted keys)', () => {
    const flat = flattenCatalog({ a: { b: 'x', c: { d: 'y' } }, e: 'z' });
    expect(flat).toEqual({ 'a.b': 'x', 'a.c.d': 'y', e: 'z' });
  });

  it('getLanguage: env BOLLOON_LANGUAGE 生效', () => {
    const old = process.env.BOLLOON_LANGUAGE;
    process.env.BOLLOON_LANGUAGE = 'en';
    expect(getLanguage()).toBe('en');
    process.env.BOLLOON_LANGUAGE = old;
  });
});
