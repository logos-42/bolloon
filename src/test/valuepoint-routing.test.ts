import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  extractValuePoints,
  routeValuePointsToJudgeness,
} from '../bootstrap/memory-compressor.js';

const tmpHome = path.join(os.tmpdir(), `bolloon-valuepoint-test-${Date.now()}`);
const tmpBolloon = path.join(tmpHome, '.bolloon');
let oldHome = '';
let oldBolloonHome = '';

describe('value-point 路由 (Context OS §6 对话收尾 → judgeness)', () => {
  beforeAll(async () => {
    oldHome = process.env.HOME || '';
    oldBolloonHome = process.env.BOLLOON_HOME || '';
    process.env.HOME = tmpHome;
    process.env.BOLLOON_HOME = tmpBolloon;
    await fs.mkdir(tmpBolloon, { recursive: true });
  });

  afterAll(async () => {
    process.env.HOME = oldHome;
    process.env.BOLLOON_HOME = oldBolloonHome;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('extractValuePoints 解析 3 种行格式', () => {
    const body = `## 关键发现
- 摘要内容

## 价值点
- (decision) 决定用指数退避重试
- lesson: 不要在 P2P 心跳里不传文本
- knowledge 修正了对端判活机制的理解

## 待办
- 明天验证`;
    const pts = extractValuePoints(body);
    expect(pts).toHaveLength(3);
    expect(pts[0]).toEqual({ type: 'decision', content: '决定用指数退避重试' });
    expect(pts[1].type).toBe('lesson');
    expect(pts[2].type).toBe('knowledge');
  });

  it('extractValuePoints 无价值点 / (无) / 未知类型 → 空数组', () => {
    expect(extractValuePoints('## 关键发现\n- x')).toEqual([]);
    expect(extractValuePoints('## 价值点\n- (无)')).toEqual([]);
    expect(extractValuePoints('## 价值点\n- (foo) 未知类型内容')).toEqual([]);
    expect(extractValuePoints('')).toEqual([]);
  });

  it('routeValuePointsToJudgeness 写入 human-values + judgeness descriptions', async () => {
    const body = `## 关键发现
- 摘要

## 价值点
- (decision) 决定采用服务端镜像替代 localStorage
- (lesson) P2P 心跳必须显式传文本否则判 defect`;
    const written = await routeValuePointsToJudgeness({
      agentId: 'agent_value_test',
      channelId: 'ch_test_1',
      summaryBody: body,
    });
    expect(written).toBe(2);

    // human-values 落盘: 一条 approve (decision), 一条 reject (lesson)
    const hvPath = path.join(tmpBolloon, 'human-values', 'judgments.json');
    const judgments = JSON.parse(await fs.readFile(hvPath, 'utf-8'));
    const decisionJ = judgments.find((j: any) => j.decision.includes('服务端镜像'));
    const lessonJ = judgments.find((j: any) => j.decision.includes('P2P 心跳'));
    expect(decisionJ).toBeTruthy();
    expect(decisionJ.decision_type).toBe('approve');
    expect(lessonJ).toBeTruthy();
    expect(lessonJ.decision_type).toBe('reject');

    // judgeness descriptions 落盘 (阶段0: locked + private)
    const jdDir = path.join(tmpBolloon, 'judgeness', 'descriptions');
    const files = await fs.readdir(jdDir);
    expect(files.length).toBeGreaterThanOrEqual(2);
    const jdRaw = await fs.readFile(path.join(jdDir, files[0]), 'utf-8');
    expect(jdRaw).toContain('openState: locked');
    expect(jdRaw).toContain('visibility: private');
  });

  it('幂等: 相同 decision 文本再次路由 → 跳过 (不重复入库)', async () => {
    const body = `## 价值点
- (decision) 幂等测试决策条目唯一`;
    const first = await routeValuePointsToJudgeness({
      agentId: 'agent_value_test',
      channelId: 'ch_test_1',
      summaryBody: body,
    });
    const second = await routeValuePointsToJudgeness({
      agentId: 'agent_value_test',
      channelId: 'ch_test_1',
      summaryBody: body,
    });
    expect(first).toBe(1);
    expect(second).toBe(0); // 幂等命中

    const hvPath = path.join(tmpBolloon, 'human-values', 'judgments.json');
    const judgments = JSON.parse(await fs.readFile(hvPath, 'utf-8'));
    const dup = judgments.filter((j: any) => j.decision.includes('幂等测试决策条目唯一'));
    expect(dup).toHaveLength(1);
  });
});
