/**
 * cron-parser.ts — cron 表达式 / 间隔解析 + 下次运行时间计算
 *
 * 借鉴 Hermes agent cron/scheduler.py 的调度心智:
 *   - 支持标准 5 段 cron ("0 8 * * *") 与人类可读间隔 ("every 30m", "1h", "30s")
 *   - 纯函数, 无 IO, 可单测: parseSchedule(schedule, from) → 下次触发 Date
 *   - schedule 为空 / 解析失败 → 返回 null (调用方决定不调度或报错)
 */

export interface CronFields {
  min: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  mon: Set<number>;
  dow: Set<number>;
}

export type ParsedSchedule =
  | { kind: 'cron'; expr: string; next: Date; fields: CronFields }
  | { kind: 'interval'; intervalMs: number; next: Date };

/** "every 30m" / "every 1h" / "30s" / "1h" / "90s" → 毫秒; 其它返回 null */
function _parseIntervalMs(raw: string): number | null {
  const m = raw.toLowerCase().trim().match(/^every\s+(\d+)\s*(s|m|h|d)?$|^(\d+)\s*(s|m|h|d)$/);
  if (!m) return null;
  const num = Number(m[1] ?? m[3]);
  const unit = (m[2] ?? m[4]) || 'm';
  const mult: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return num * mult[unit];
}

/** 把 5 段 cron 拆成字段集合. 支持 *, 数字, 逗号, 范围, 步进 (仅分钟/小时/月/周日). */
function _parseCronFields(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const parse = (field: string, lo: number, hi: number): Set<number> => {
    const set = new Set<number>();
    for (const seg of field.split(',')) {
      if (seg === '*') { for (let v = lo; v <= hi; v++) set.add(v); continue; }
      let step = 1;
      let range = seg;
      if (seg.includes('/')) { const [r, s] = seg.split('/'); range = r; step = Number(s) || 1; }
      let start = lo, end = hi;
      if (range === '*') { start = lo; end = hi; }
      else if (range.includes('-')) { const [a, b] = range.split('-'); start = Number(a); end = Number(b); }
      else { start = end = Number(range); }
      if (Number.isNaN(start) || Number.isNaN(end) || Number.isNaN(step)) return null as any;
      for (let v = start; v <= end; v += step) set.add(v);
    }
    return set;
  };
  const min = parse(parts[0], 0, 59);
  const hour = parse(parts[1], 0, 23);
  const dom = parse(parts[2], 1, 31);
  const mon = parse(parts[3], 1, 12);
  const dow = parse(parts[4], 0, 6);
  if (!min || !hour || !dom || !mon || !dow) return null;
  return { min, hour, dom, mon, dow };
}

function _matchesCron(d: Date, f: CronFields): boolean {
  const domMatch = f.dom.has(d.getDate());
  const dowMatch = f.dow.has(d.getDay());
  // 经典 cron 语义: dom 与 dow 都受限时用 OR, 否则各自 AND
  const domRestricted = !f.dom.has(31) && f.dom.size < 31;
  const dowRestricted = f.dow.size < 7;
  const dayOk = domRestricted && dowRestricted ? domMatch || dowMatch : domMatch && dowMatch;
  return (
    dayOk &&
    f.mon.has(d.getMonth() + 1) &&
    f.hour.has(d.getHours()) &&
    f.min.has(d.getMinutes())
  );
}

/**
 * 解析 schedule 并计算下次触发时间.
 * @param schedule "0 8 * * *" / "every 30m" / "1h" / "30s"
 * @param from 基准时间 (默认 now)
 * @returns ParsedSchedule 或 null (无法解析 / 未来 1 年内无匹配)
 */
export function parseSchedule(schedule: string, from: Date = new Date()): ParsedSchedule | null {
  const raw = (schedule || '').trim();
  if (!raw) return null;

  // 间隔形式 (最快路径)
  const intervalMs = _parseIntervalMs(raw);
  if (intervalMs != null && intervalMs > 0) {
    return { kind: 'interval', intervalMs, next: new Date(from.getTime() + intervalMs) };
  }

  // 5 段 cron: 从 from 起逐分钟扫描, 找下一个匹配 (上限 1 年避免死循环)
  const fields = _parseCronFields(raw);
  if (!fields) return null;
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1); // 严格 "下一次", 不含当前分
  const capMs = from.getTime() + 366 * 86_400_000;
  while (cursor.getTime() < capMs) {
    if (_matchesCron(cursor, fields)) {
      return { kind: 'cron', expr: raw, next: cursor, fields };
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

/**
 * 刷新一次调度: 给定 schedule 与上次触发, 返回本次应跑的触发点.
 *   间隔型 → 以 lastRunAt 为基准叠加; 无 lastRunAt (首次) → 立即 due (返回 now).
 *   cron 型 → 从 max(lastRunAt, now) 起找匹配; 上次触发已过期 → 立即 due.
 */
export function nextAfter(schedule: string, lastRunAt?: Date, now: Date = new Date()): Date | null {
  const raw = (schedule || '').trim();
  if (!raw) return null;

  const intervalMs = _parseIntervalMs(raw);
  if (intervalMs != null && intervalMs > 0) {
    if (!lastRunAt) return now; // 首次: 立即触发
    return new Date(lastRunAt.getTime() + intervalMs);
  }

  // cron 型: 依托上次触发后的下一次, 与"当前墙钟"比较
  const fields = _parseCronFields(raw);
  if (!fields) return null;
  const base = lastRunAt && lastRunAt > now ? new Date(lastRunAt) : new Date(now);
  base.setSeconds(0, 0);
  let cursor = new Date(base);
  if (lastRunAt) cursor.setMinutes(cursor.getMinutes() + 1); // 严格晚于上次触发
  const capMs = base.getTime() + 366 * 86_400_000;
  while (cursor.getTime() < capMs) {
    if (_matchesCron(cursor, fields)) return cursor;
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}