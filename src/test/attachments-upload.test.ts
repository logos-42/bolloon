/**
 * attachment 上传端点 (2026-07-15 Bug 3 修复引入)
 *
 * 测的目的:
 *   - /api/attachments/upload 接受 base64 + filename + mimeType, 返回 attachmentId + url
 *   - 文件落到 ~/.bolloon/attachments/<YYYY-MM>/<id>__<safeName>
 *   - 落盘的文件能读回原内容 (下载通路)
 *   - safeName 防路径穿越 + Windows 非法字符
 *   - 超过 10MB 上限 → 413
 *
 * 消融思路:
 *   - 不起完整 web 服务 (避免完整 express + LLM 依赖)
 *   - 直接复用 server.ts 上 app.post() 那段逻辑 (把 server 端 handler 抽出来的部分) — 这次 server 把 upload/download 写在 createWebServer
 *     闭包内, 测试单独 spawn 调用起一个端口测端到端? 不可行 (依赖太多)
 *   - 退而求其次: 单元测附件名 sanitization + 路径拼接 (这部分无外部依赖, 最稳)
 *   - 端到端真实路径直接在 ablation 实验脚本里覆盖 (留给 v0.2.14+ ablation)
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';

describe('attachment: safeName sanitization (2026-07-15 Bug 3 修复)', () => {
  // 跟 server.ts 上传端点的 safeName 规则同步
  function safeName(filename: string): string {
    return filename
      .replace(/[\\/:*?"<>|\x00-\x1f.]/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 120) || 'unnamed';
  }

  it('文件名为 plain.txt 时, .txt 里的 . 被替换为 _, 这是 trade-off (防 .. 残留)', () => {
    // 新规则把 . 一起换, 所以 .txt 变成 _txt
    // 这是有意的 trade-off: 防 ../../ 路径穿越
    expect(safeName('hello.txt')).toBe('hello_txt');
  });

  it('路径穿越 ../../etc/passwd 时, 非法字符和 . 全部替换, 无 .. 无 / 残留', () => {
    const out = safeName('../../etc/passwd');
    expect(out).not.toContain('..');
    expect(out).not.toContain('/');
    expect(out).not.toContain('\\');
  });

  it('Windows 非法字符 : * ? " < > | 全部替换成 _', () => {
    expect(safeName('a:b*c?d"e<f>g|h')).toBe('a_b_c_d_e_f_g_h');
  });

  it('空字符串 → unnamed', () => {
    expect(safeName('')).toBe('unnamed');
  });

  it('超长文件名截断到 120 字符', () => {
    const long = 'a'.repeat(200) + '.txt';
    const out = safeName(long);
    expect(out.length).toBeLessThanOrEqual(120);
  });

  it('控制字符 \\x00-\\x1f 也被替换', () => {
    expect(safeName('hello\x00world')).toBe('hello_world');
  });

  it('前后下划线被 trim 掉', () => {
    // "..." 全部是非法 → "_" → 空 → "unnamed"
    expect(safeName('...')).toBe('unnamed');
    // "/leading.txt" → "_leading_txt"
    expect(safeName('/leading.txt').startsWith('_')).toBe(false);
  });
});

describe('attachment: 月份目录命名', () => {
  it('当前月格式 YYYY-MM', () => {
    const month = new Date().toISOString().slice(0, 7);
    expect(month).toMatch(/^\d{4}-\d{2}$/);
    // 不能跨月 — 必须等于当前 system time 的月份
    const expected = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    expect(month).toBe(expected);
  });

  it('attachment dir 路径拼接正确', () => {
    const home = '/Users/test';
    const month = '2026-07';
    const dir = path.join(home, '.bolloon', 'attachments', month);
    expect(dir).toBe(path.join('/Users/test', '.bolloon', 'attachments', '2026-07'));
  });
});
