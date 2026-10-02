/**
 * K6 门: ModelRuntime 台账 —— 旧写口棘轮 + 能力清单 + "声明未实现 ⇒ 文件不许存在"。
 *
 * 为什么先落门再写运行时: K2 的实操证明"新层出现后旧写口调用点数只许不变或减少"这条判据
 * 真能拦回实现 (它拦回过一次 assistant 的写法)。K6 要动的是多供应商并发 —— 一旦新层顺手改了
 * provider 配置 / API key / 全局 model, 就会变成"两个地方都能改状态", 那是回归而不是新能力。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  K6_PROGRESS,
  MODEL_RUNTIME_ACQUIRE_RULE,
  MODEL_RUNTIME_CAPABILITIES,
  MODEL_RUNTIME_OUT_OF_SCOPE,
  MODEL_WRITE_PORTS,
  MODEL_WRITE_PORTS_FROZEN_AT,
} from '../kernel/plan-modelruntime.js';
import { countModelWritePortCalls, scanModelRuntimeLedger, type SourceTextFile } from '../kernel/gate-scan.js';

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

/** 与判据同口径的扫描面: 全仓 .ts, **排除 test/ 与 kernel/** (内核里不写业务状态) */
function scanFiles(): SourceTextFile[] {
  const out: SourceTextFile[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (['node_modules', 'constraint-runtime', 'test', 'kernel'].includes(e.name)) continue;
        walk(p);
      } else if (e.name.endsWith('.ts')) {
        out.push({ path: path.relative(SRC, p), text: fs.readFileSync(p, 'utf-8') });
      }
    }
  };
  walk(SRC);
  return out;
}

const FILES = scanFiles();
const RUNTIME_EXISTS = fs.existsSync(path.join(SRC, K6_PROGRESS.runtimePath));

const LEDGER = {
  writePorts: MODEL_WRITE_PORTS,
  writePortsFrozenAt: MODEL_WRITE_PORTS_FROZEN_AT,
  acquireRule: MODEL_RUNTIME_ACQUIRE_RULE,
  capabilities: MODEL_RUNTIME_CAPABILITIES,
  outOfScope: MODEL_RUNTIME_OUT_OF_SCOPE,
  progress: K6_PROGRESS,
};

describe('K6 门: ModelRuntime 台账', () => {
  it('扫描面非空 (门不许空转)', () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES.every((f) => !f.path.startsWith('test/') && !f.path.startsWith('kernel/'))).toBe(true);
  });

  it('★ 盘上台账一致: 旧写口棘轮 + 合计自洽 + 能力清单 + 越界清单 + 只读要求', () => {
    expect(scanModelRuntimeLedger(LEDGER as any, FILES, { runtimeExists: RUNTIME_EXISTS })).toEqual([]);
  });

  it('★ 口径核: 每个写口的调用点数都能从盘上重算出来 (抽查三个)', () => {
    for (const name of ['setCustomProviderSnapshot', 'clearSessionSelection', 'resetModelSelection']) {
      const entry = MODEL_WRITE_PORTS.find((p) => p.name === name)!;
      expect(countModelWritePortCalls(FILES, name), name).toBe(entry.callSites);
    }
    // 声明行不算调用点: 拿自己的名字当反例 (定义文件里那句 `export function x(` 必须没被算)
    const fake: SourceTextFile[] = [{ path: 'x.ts', text: 'export function addCustomProvider() {}\n' }];
    expect(countModelWritePortCalls(fake, 'addCustomProvider')).toBe(0);
  });

  it('★ 判别力: 六种坏形状都必须判红', () => {
    const bump = (name: string, delta: number) =>
      LEDGER.writePorts.map((p) => (p.name === name ? { ...p, callSites: p.callSites + delta } : p));
    // ① 回退: **盘上多一处调用** (模拟新层顺手改了旧状态) ⇒ 必须报"回退"
    const extraCall: SourceTextFile[] = [...FILES, { path: 'llm/new-layer.ts', text: 'clearSessionSelection(1);' }];
    expect(scanModelRuntimeLedger(LEDGER as any, extraCall, { runtimeExists: RUNTIME_EXISTS }).some((f) => f.what.includes('回退'))).toBe(true);
    // ② 账没跟上: **盘上少了调用** (拿空扫描面模拟) ⇒ 必须报"盘上变了账没跟上"
    expect(scanModelRuntimeLedger(LEDGER as any, [{ path: 'empty.ts', text: '' }], { runtimeExists: RUNTIME_EXISTS }).some((f) => f.what.includes('账没跟上'))).toBe(true);
    // ③ 合计不自洽
    expect(scanModelRuntimeLedger({ ...LEDGER, writePortsFrozenAt: MODEL_WRITE_PORTS_FROZEN_AT - 1 } as any, FILES, { runtimeExists: RUNTIME_EXISTS }).some((f) => f.what.includes('≠ 冻结值'))).toBe(true);
    // ④ 越界清单被缩减
    expect(scanModelRuntimeLedger({ ...LEDGER, outOfScope: MODEL_RUNTIME_OUT_OF_SCOPE.slice(0, 3) } as any, FILES, { runtimeExists: RUNTIME_EXISTS }).some((f) => f.what.includes('明确不做'))).toBe(true);
    // ⑤ 假进度: 标 not-started 却说文件在 / 标 runtime-built 却说文件不在
    expect(scanModelRuntimeLedger(LEDGER as any, FILES, { runtimeExists: true }).some((f) => f.what.includes('台账该改'))).toBe(true);
    expect(scanModelRuntimeLedger({ ...LEDGER, progress: { ...K6_PROGRESS, stage: 'runtime-built' } } as any, FILES, { runtimeExists: false }).some((f) => f.what.includes('假进度'))).toBe(true);
    // ⑥ 只读要求被拿掉
    expect(scanModelRuntimeLedger({ ...LEDGER, acquireRule: { ...MODEL_RUNTIME_ACQUIRE_RULE, readOnly: false } } as any, FILES, { runtimeExists: RUNTIME_EXISTS }).some((f) => f.what.includes('只读要求'))).toBe(true);
  });

  it('能力清单与越界清单都不是空壳', () => {
    expect(MODEL_RUNTIME_CAPABILITIES).toHaveLength(9);
    for (const c of MODEL_RUNTIME_CAPABILITIES) expect(c.why.length).toBeGreaterThan(3);
    expect(MODEL_RUNTIME_OUT_OF_SCOPE).toHaveLength(5);
  });
});
