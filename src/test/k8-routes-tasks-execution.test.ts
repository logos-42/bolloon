/**
 * k8-routes-tasks-execution.test.ts — K8 "待真跑核验"项: `routes-tasks` 的**显式 channelId** 差量 (2026-10-02)
 *
 * 背景: K8 第二步把 `routes-tasks.ts` 的 chat 分支从 `prompt(desc)` (隐式 actor 绑定)
 * 改成 `runExecution({ input: desc, channelId })` (**显式**绑定)。台账里如实记为"**有差量、待真跑核验**"
 * —— 不当作"零行为改变"。
 *
 * 这一跑要证三件事 (真 express + 真 HTTP + 真任务队列, 只把 agent 换成假的):
 *   ① 活路径**就是** runExecution —— agent 只给 `runExecution`、**不给 `prompt`**;
 *      若代码里还有一处直呼 prompt, 会当场 TypeError (响亮), 用例判红。
 *   ② **显式绑定的 id == 解析 agent 用的 id** —— 这是"零差量"这个断言的**自检不变量**:
 *      同一个 channelId 既解析 agent、又绑 run; 将来谁把两半改成不同的 id, 这条立刻红。
 *   ③ 拿不到唯一执行入口时**响亮失败**: 绝不静默回落直呼 prompt (prompt 调用次数必须 **0**)。
 *
 * ⚠️ 隔离纪律 (踩过的坑, 2026-10-02): `server-types.ts` 的 `HOME` / `TASK_QUEUE_PATH` 是**模块导入时**
 *    捕获的常量 ⇒ (a) 必须**先设 HOME 再动态 import 路由**; (b) 整文件只用**一个** tmp 目录
 *    (一次导入对应一个路径), **不许每个用例换 HOME** —— 否则第二个用例会写到已被删除的目录, POST 直接 500。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import express from 'express';

let tmp: string;
let prevHome: string | undefined;

beforeAll(() => {
  prevHome = process.env.HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-k8-tasks-'));
  process.env.HOME = tmp;
  // 夹具跟上契约: `saveTaskQueue` 只 writeFile 不 mkdir ⇒ 目录得由使用者备好
  fs.mkdirSync(path.join(tmp, '.bolloon', 'sessions'), { recursive: true });
});
afterAll(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

/** 真 express + 真 HTTP: 请求真的从 TCP 进来, 不是直接调函数 */
async function startApp(agent: any) {
  const { registerTaskRoutes } = await import('../web/routes-tasks.js');
  const app = express();
  app.use(express.json());
  const broadcasts: any[] = [];
  const getAgentCalls: string[] = [];
  registerTaskRoutes(app, {
    broadcast: (e: any) => { broadcasts.push(e); },
    getAgentForChannel: async (channelId: string) => { getAgentCalls.push(channelId); return agent; },
  });
  const srv = await new Promise<http.Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return {
    base: `http://127.0.0.1:${(srv.address() as any).port}`,
    broadcasts, getAgentCalls,
    close: () => { srv.close(); (srv as any).closeAllConnections?.(); },
  };
}

async function post(base: string, p: string, body: any): Promise<{ status: number; json: any }> {
  const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

/** 轮询等副作用 (路由是"认领后异步执行、立即返回") */
async function waitFor(fn: () => boolean, ms = 5000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

const CH = 'ch-k8-verify';
const queueFile = () => path.join(tmp, '.bolloon', 'sessions', 'task-queue.json');
const readTask = (id: string) => {
  const d = JSON.parse(fs.readFileSync(queueFile(), 'utf8'));
  const arr = Array.isArray(d) ? d : d.tasks;
  return arr.find((t: any) => t.id === id);
};

describe('K8 真跑核验: routes-tasks chat 任务经唯一执行入口 (显式 channelId)', () => {
  it('① 活路径就是 runExecution (agent 无 prompt 也不报错) + ② 两半 id 一致 + 结果真回填', async () => {
    const seen: any[] = [];
    // ⚠️ 故意**不给 prompt**: 若代码里还有一处直呼 prompt, 这里会 TypeError
    const app = await startApp({ runExecution: async (req: any) => { seen.push(req); return '真回复 ✅'; } });
    try {
      const mk = await post(app.base, '/api/tasks', { type: 'chat', title: 'K8 核验-主证据', description: '说一句话' });
      expect(mk.status).toBe(200);
      const taskId = mk.json.id;

      const ex = await post(app.base, `/api/tasks/${taskId}/execute`, { channelId: CH });
      expect({ status: ex.status, ok: ex.json?.ok }).toEqual({ status: 200, ok: true });

      expect(await waitFor(() => seen.length === 1)).toBe(true);
      // ② 两半 id 一致 (解析 agent 用的 id == 绑 run 用的 id) —— "零差量"的自检不变量
      expect(app.getAgentCalls).toEqual([CH]);
      expect(seen[0].channelId).toBe(CH);
      expect(seen[0].channelId).toBe(app.getAgentCalls[0]);
      expect(seen[0].input).toBe('说一句话');   // 输入没被换掉

      // 真回复回填 (不是"看起来跑了"): 等**真实形状** —— 带 result 的那条 task_status 广播
      const sawStatus = await waitFor(() => app.broadcasts.some((b) => b.type === 'task_status' && b.result === '真回复 ✅'));
      expect({ sawStatus, 广播: app.broadcasts.map((b) => `${b.type}:${b.status ?? ''}`) }).toEqual({ sawStatus: true, 广播: expect.anything() });
      expect(app.broadcasts.some((b) => b.type === 'ai' && b.content === '真回复 ✅')).toBe(true);
      const t = readTask(taskId);
      expect(t.result).toBe('真回复 ✅');
      expect(['review', 'completed']).toContain(t.status);   // 终态由审批配置决定, 两态都算"真回填"
    } finally { app.close(); }
  });

  it('③ 拿不到唯一执行入口 ⇒ 响亮失败, 且 prompt 调用次数为 0 (绝不静默回落)', async () => {
    const promptCalls: string[] = [];
    const app = await startApp({ prompt: async (t: string) => { promptCalls.push(t); return '直呼 prompt 的回复'; } });
    try {
      const mk = await post(app.base, '/api/tasks', { type: 'chat', title: 'K8 核验-无门', description: '不该直呼' });
      expect(mk.status).toBe(200);
      const taskId = mk.json.id;

      const ex = await post(app.base, `/api/tasks/${taskId}/execute`, { channelId: CH });
      expect({ status: ex.status, ok: ex.json?.ok }).toEqual({ status: 200, ok: true });

      const sawErr = await waitFor(() => app.broadcasts.some((b) => b.type === 'error'));
      expect({ sawErr, 广播: app.broadcasts.map((b) => `${b.type}:${b.status ?? ''}`) }).toEqual({ sawErr: true, 广播: expect.anything() });
      // 响亮: 报出的错误必须点名"拒绝直呼 prompt"
      expect(app.broadcasts.some((b) => /拒绝直呼 prompt|runExecution/.test(String(b.content ?? b.error ?? '')))).toBe(true);
      // 承重: 一次 prompt 都没发生 (门坏了也不许静默回落)
      expect(promptCalls).toEqual([]);
    } finally { app.close(); }
  });
});
