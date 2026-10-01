/**
 * 启动前言: 「只差连通性复测」不许在启动时跑 setup 向导 (2026-10-01, 用户报「启动时候的日志也没去掉」)。
 *
 * 用户实际遇到的状态 (原样抄进下面的夹具): 连通性实测结果 >24h 就"过期", 于是**每次启动**都命中
 * 未就绪 ⇒ 启动路径去跑整个向导 ⇒ 向导按"真跑了步骤就把前言放出来"的规矩刷约 30 行
 * (初始化框 / Onboard 模式 / 每步 ✓✗ / 就绪度报告)。这类不需要抢跑: 门禁照旧拦 agent, 按需跑 --test。
 * 判据必须**窄**: 首次使用 (缺 provider/key) 的 basic 原因不匹配 ⇒ 仍然照常跑向导。
 */
import { describe, it, expect } from 'vitest';
import { onlyConnectivityRetest, alertsFromSetup } from '../cli/startup-notice.js';
import fs from 'node:fs';
import path from 'node:path';

// 用户 paste_3 的真实形状 (只留判据要用到的字段)
const userEv = {
  gate: 'setup',
  reasons: ['连通性结果过期 (需重测)'],
  nextActions: ['跑真实连通性测试 (`bolloon setup --test`) — 用最终保存的 provider/key/baseUrl/model'],
  state: {
    readiness: { basic: false, agent: false, durable: false, network: false },
    readinessWhy: {
      basic: ['连通性结果过期 (需重测)'],
      agent: ['agent 层未就绪'],
      durable: ['durable 层未就绪'],
    },
  },
} as any;

describe('onlyConnectivityRetest', () => {
  it('用户那份真实状态 ⇒ true (启动时不跑向导)', () => {
    expect(onlyConnectivityRetest(userEv)).toBe(true);
  });

  it('首次使用 (缺 provider/key) ⇒ false (onboarding 绝不能被跳过)', () => {
    const ev = JSON.parse(JSON.stringify(userEv));
    ev.state.readinessWhy.basic = ['缺 (basic): provider/key 未配置'];
    expect(onlyConnectivityRetest(ev)).toBe(false);
  });

  it('连通性 + 别的原因混在一起 ⇒ false (不猜, 交给向导)', () => {
    const ev = JSON.parse(JSON.stringify(userEv));
    ev.state.readinessWhy.basic = ['连通性结果过期 (需重测)', '配置来源不可信'];
    expect(onlyConnectivityRetest(ev)).toBe(false);
  });

  it('已就绪 / 空输入 ⇒ false', () => {
    expect(onlyConnectivityRetest({ ...userEv, gate: 'ready' } as any)).toBe(false);
    expect(onlyConnectivityRetest(null)).toBe(false);
    expect(onlyConnectivityRetest({ gate: 'setup', state: { readiness: { basic: false } } } as any)).toBe(false);
  });

  it('源码侧: index.ts 的向导调用必须被这个判据挡住 (否则走了还得刷 30 行)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf-8');
    const i = src.indexOf('onlyConnectivityRetest(gateEv)');
    const j = src.indexOf('runSetupWizard({ interactive: true, quietStartup: true })');
    expect(i, 'index.ts 里没有 onlyConnectivityRetest(gateEv) 分支').toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i); // 向导调用必须排在判据分支之后 (else 分支里)
  });

  it('告警行仍然给出"下一步去哪" (不许只说未就绪)', () => {
    const lines = alertsFromSetup(userEv);
    expect(lines[0]).toContain('未就绪');
    expect(lines.join(' ')).toMatch(/setup/);
  });
});
