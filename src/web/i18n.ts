/**
 * i18n.ts — 用户可见静态文案目录 (借鉴 Hermes agent/i18n.py + locales/*.yaml)
 *
 * Hermes 设计要点 (照搬):
 *   1. 范围纪律: 只翻「用户可见静态消息」(审批提示/系统回复); agent 生成的输出、
 *      日志、报错、工具输出一律不翻译 (agent/i18n.py scope rationale)。
 *   2. 嵌套目录扁平化成 dotted keys (approval.choose_long)。
 *   3. 值可含 {placeholder} 占位符 (str.format 语义)。
 *   4. 语言解析: env (BOLLOON_LANGUAGE) > config > default (zh)。
 *   5. 目录每语言缓存; 键缺失 → en 回退 (en 是 source of truth)。
 *   6. parity 测试: 每个 locale 键集合 == en, 占位符集合 == en (tests 断言)。
 *
 * 载体用 TS 模块 (locales/*.ts) 而非 YAML 文件: 无运行时文件依赖/构建拷贝问题,
 * 机制与 YAML 目录完全一致 (嵌套对象 + 扁平化)。
 */

import * as en from '../locales/en.js';
import * as zh from '../locales/zh.js';

export const DEFAULT_LANGUAGE = 'zh';
export const SUPPORTED_LANGUAGES = ['en', 'zh'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export interface CatalogEntry {
  /** 扁平化后的 dotted key → 模板字符串 */
  flat: Record<string, string>;
}

/** 语言别名 + 区域标签归一化 (Hermes _normalize_lang) */
export function normalizeLang(value: unknown): Language {
  if (typeof value !== 'string') return DEFAULT_LANGUAGE;
  const key = value.trim().toLowerCase();
  if (!key) return DEFAULT_LANGUAGE;
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(key)) return key as Language;
  const base = key.split('-', 1)[0];
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(base)) return base as Language;
  return DEFAULT_LANGUAGE;
}

/** 嵌套目录扁平化成 dotted keys (Hermes _flatten_into) */
export function flattenCatalog(node: unknown, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node)) {
      const childKey = prefix ? `${prefix}.${key}` : key;
      Object.assign(out, flattenCatalog(value, childKey));
    }
  } else if (typeof node === 'string') {
    out[prefix] = node;
  }
  return out;
}

const catalogs: Record<Language, Record<string, string>> = {
  en: flattenCatalog(en.catalog),
  zh: flattenCatalog(zh.catalog),
};

/** 语言缓存 (Hermes _catalog_cache) — 进程内一次加载 */
const resolvedLanguage: { lang: Language } = { lang: DEFAULT_LANGUAGE };

/** 解析活动语言: env BOLLOON_LANGUAGE > 默认 */
export function getLanguage(): Language {
  const envLang = process.env.BOLLOON_LANGUAGE;
  if (envLang) {
    resolvedLanguage.lang = normalizeLang(envLang);
  }
  return resolvedLanguage.lang;
}

/**
 * 翻译 dotted key (Hermes t()).
 * 键缺失 → en 回退; en 也缺失 → 返回 key 本身 (不抛).
 */
export function t(key: string, lang?: Language, vars?: Record<string, unknown>): string {
  const target = lang ?? getLanguage();
  const catalog = catalogs[target] ?? catalogs.en;
  let template = catalog[key];
  if (template === undefined) {
    template = catalogs.en[key] ?? key; // en 回退
  }
  if (vars && Object.keys(vars).length > 0) {
    for (const [k, v] of Object.entries(vars)) {
      template = template.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return template;
}

/** parity 检查 (Hermes test_i18n.py): 键集合 + 占位符集合 vs en */
export function catalogParity(): Array<{ lang: Language; missingKeys: string[]; extraKeys: string[]; placeholderMismatch: string[] }> {
  const enKeys = Object.keys(catalogs.en);
  const placeholderRe = /\{([a-zA-Z0-9_]+)\}/g;
  const enPlaceholders = new Map<string, Set<string>>();
  for (const [k, v] of Object.entries(catalogs.en)) {
    enPlaceholders.set(k, new Set([...v.matchAll(placeholderRe)].map((m) => m[1])));
  }
  return SUPPORTED_LANGUAGES.filter((l) => l !== 'en').map((lang) => {
    const langKeys = Object.keys(catalogs[lang]);
    const missingKeys = enKeys.filter((k) => !catalogs[lang][k]);
    const extraKeys = langKeys.filter((k) => !catalogs.en[k]);
    const placeholderMismatch: string[] = [];
    for (const [k, enPh] of enPlaceholders) {
      const langV = catalogs[lang][k];
      if (langV === undefined) continue;
      const langPh = new Set([...langV.matchAll(placeholderRe)].map((m) => m[1]));
      const diff = new Set([...enPh].filter((p) => !langPh.has(p)));
      if (diff.size > 0) placeholderMismatch.push(`${k}: 缺占位符 ${[...diff].join(',')}`);
    }
    return { lang, missingKeys, extraKeys, placeholderMismatch };
  });
}
