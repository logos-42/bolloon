import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const catalog = JSON.parse(readFileSync(path.join(ROOT, 'manifests', 'mcp-catalog.json'), 'utf-8'));

describe('MCP 目录 (Hermes optional-mcps 模式)', () => {
  it('manifest_version + entries 结构完整', () => {
    expect(catalog.manifest_version).toBe(1);
    expect(Array.isArray(catalog.entries)).toBe(true);
    expect(catalog.entries.length).toBeGreaterThan(0);
  });

  it('每条 entry 必备字段: name/description/transport/auth', () => {
    for (const e of catalog.entries) {
      expect(e.name).toBeTruthy();
      expect(e.description).toBeTruthy();
      expect(['stdio', 'http', 'in-process']).toContain(e.transport?.type);
      expect(e.auth?.type).toBeTruthy();
    }
  });

  it('http transport 带 url, auth 类型合法', () => {
    for (const e of catalog.entries) {
      if (e.transport?.type === 'http') {
        expect(e.transport.url).toMatch(/^https?:\/\//);
        expect(['none', 'bearer', 'oauth']).toContain(e.auth?.type);
      }
    }
  });

  it('默认禁用纪律: 目录条目 ≠ 已接入 (~/.mcp.json 是运行时事实)', () => {
    // 目录是"可选安装"清单 — 已接入的 MCP 看 ~/.mcp.json, 两者解耦
    expect(catalog.policy).toContain('默认禁用');
  });
});
