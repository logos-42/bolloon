/**
 * routes-tasks.ts — 任务队列 CRUD 路由 (2026-07-06 抽出)
 *
 * 从 src/web/server.ts 抽出 (~160 行).
 * 包含 /api/tasks/* (GET, POST, PATCH, DELETE, execute, execute-next)
 */

import type { Express } from 'express';
import { type Task } from './server-types.js';
import { loadTaskQueue, saveTaskQueue, isTaskExecuting } from './server-storage.js';
import { documentReader } from '../documents/reader.js';
import { applyCancelRequest, shouldFinalizeAsCancelled } from './task-cancel.js';
import { applyReviewRequest, applyReviewApprove, applyReviewReject } from './task-review.js';

type BroadcastFn = (event: any, channelId?: string) => void;
type GetAgentFn = (channelId: string) => Promise<{ prompt: (text: string) => Promise<string> }>;

export function registerTaskRoutes(
  app: Express,
  opts: {
    broadcast: BroadcastFn;
    getAgentForChannel: GetAgentFn;
  }
): void {
  const { broadcast, getAgentForChannel } = opts;

  // 获取所有任务
  app.get('/api/tasks', async (req, res) => {
    try {
      const tasks = await loadTaskQueue();
      res.json(tasks);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 创建新任务
  app.post('/api/tasks', async (req, res) => {
    try {
      const { type, title, description, steps } = req.body;
      if (!type || !title) {
        return res.status(400).json({ error: 'type and title required' });
      }

      const tasks = await loadTaskQueue();
      const task: Task = {
        id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        type,
        title,
        description,
        status: 'pending',
        progress: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: steps?.map((s: string, i: number) => ({
          id: `step_${i}`,
          name: s,
          status: 'pending'
        }))
      };

      tasks.push(task);
      await saveTaskQueue(tasks);

      res.json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 获取单个任务
  app.get('/api/tasks/:taskId', async (req, res) => {
    try {
      const { taskId } = req.params;
      const tasks = await loadTaskQueue();
      const task = tasks.find(t => t.id === taskId);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
      res.json(task);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 更新任务
  app.patch('/api/tasks/:taskId', async (req, res) => {
    try {
      const { taskId } = req.params;
      const { status, currentStep } = req.body;
      const tasks = await loadTaskQueue();
      const taskIndex = tasks.findIndex(t => t.id === taskId);
      if (taskIndex === -1) {
        return res.status(404).json({ error: 'Task not found' });
      }

      if (status) {
        tasks[taskIndex].status = status;
      }
      if (currentStep !== undefined) {
        tasks[taskIndex].currentStep = currentStep;
      }
      tasks[taskIndex].updatedAt = new Date().toISOString();

      await saveTaskQueue(tasks);
      res.json(tasks[taskIndex]);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 删除任务
  app.delete('/api/tasks/:taskId', async (req, res) => {
    try {
      const { taskId } = req.params;
      const tasks = await loadTaskQueue();
      const filtered = tasks.filter(t => t.id !== taskId);
      await saveTaskQueue(filtered);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 执行任务（自动执行下一步）
  app.post('/api/tasks/:taskId/execute', async (req, res) => {
    try {
      const { taskId } = req.params;
      const { channelId } = req.body;
      if (!channelId) {
        return res.status(400).json({ error: 'channelId required' });
      }

      // 2026-08-11: CAS 认领 — 只有 pending 能认领成功, 输家不重试
      const { claimTaskForExecution } = await import('./server-storage.js');
      const claim = await claimTaskForExecution(taskId);
      if (claim === 'busy') {
        return res.status(409).json({ error: 'Another task is currently executing' });
      }
      if (claim === 'not-pending') {
        const tasks = await loadTaskQueue();
        const task = tasks.find(t => t.id === taskId);
        return res.status(409).json({ error: `Task not claimable (status=${task?.status ?? 'missing'})` });
      }

      const tasks = await loadTaskQueue();
      const task = tasks.find(t => t.id === taskId);

      // 异步执行任务
      executeTask(task!, channelId, getAgentForChannel, broadcast);

      res.json({ ok: true, taskId: task!.id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 执行下一个待处理任务
  app.post('/api/tasks/execute-next', async (req, res) => {
    try {
      const { channelId } = req.body;
      if (!channelId) {
        return res.status(400).json({ error: 'channelId required' });
      }

      // 2026-08-11: CAS 认领下一个 pending — 输家 (无任务/已被认领/忙) 返回, 不重试
      const { claimNextPendingTask } = await import('./server-storage.js');
      const nextTask = await claimNextPendingTask();

      if (!nextTask) {
        return res.json({ ok: false, message: 'No pending tasks or another task is executing' });
      }

      // 异步执行任务
      executeTask(nextTask, channelId, getAgentForChannel, broadcast);

      res.json({ ok: true, taskId: nextTask.id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 取消任务 (2026-08-11, Hermes 两段式: cancel-requested → cancelled)
  //   - pending 任务: 从未开始, 直接终态 cancelled (请求即完成, 不会卡在中间态)
  //   - running 任务: 先置 cancel-requested (第一段: 请求已受理), executor 观测到后置 cancelled (第二段: 实际停止)
  app.post('/api/tasks/:taskId/cancel', async (req, res) => {
    try {
      const { taskId } = req.params;
      const { channelId } = req.body || {};
      const tasks = await loadTaskQueue();
      const task = tasks.find(t => t.id === taskId);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }

      switch (task.status) {
        case 'pending': {
          const t = applyCancelRequest(task.status);
          task.status = t.status;
          task.updatedAt = new Date().toISOString();
          await saveTaskQueue(tasks);
          broadcast({ type: 'task_status', taskId: task.id, status: t.status, progress: task.progress }, channelId);
          return res.json({ ok: true, taskId: task.id, status: t.status, phase: t.phase });
        }
        case 'running': {
          const t = applyCancelRequest(task.status);
          task.status = t.status;
          task.updatedAt = new Date().toISOString();
          await saveTaskQueue(tasks);
          broadcast({ type: 'task_status', taskId: task.id, status: t.status }, channelId);
          return res.json({ ok: true, taskId: task.id, status: t.status, phase: t.phase });
        }
        case 'cancel-requested':
          return res.json({ ok: true, taskId: task.id, status: 'cancel-requested', phase: 'already-requested' });
        default:
          return res.status(409).json({ error: `Task already terminal (${task.status})` });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== review 审批通道 (2026-08-11, Hermes request_review 模式) ====================
  // running/pending → review (挂起等人工/审查者) → approve (review→completed) / reject (review→pending 退回队列)

  // 请求审批
  app.post('/api/tasks/:taskId/review', async (req, res) => {
    try {
      const { taskId } = req.params;
      const { channelId } = req.body || {};
      const tasks = await loadTaskQueue();
      const task = tasks.find(t => t.id === taskId);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
      const t = applyReviewRequest(task.status);
      if (t.phase === 'not-reviewable') {
        return res.status(409).json({ error: `Task not reviewable (status=${task.status})` });
      }
      task.status = t.status;
      task.updatedAt = new Date().toISOString();
      await saveTaskQueue(tasks);
      broadcast({ type: 'task_status', taskId: task.id, status: t.status }, channelId);
      return res.json({ ok: true, taskId: task.id, status: t.status, phase: t.phase });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 审批通过 (放行完成)
  app.post('/api/tasks/:taskId/approve', async (req, res) => {
    try {
      const { taskId } = req.params;
      const { channelId } = req.body || {};
      const tasks = await loadTaskQueue();
      const task = tasks.find(t => t.id === taskId);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
      const t = applyReviewApprove(task.status);
      if (t.phase === 'not-reviewable') {
        return res.status(409).json({ error: `Task not in review (status=${task.status})` });
      }
      task.status = t.status;
      task.progress = 100;
      task.updatedAt = new Date().toISOString();
      await saveTaskQueue(tasks);
      broadcast({ type: 'task_status', taskId: task.id, status: t.status, progress: 100 }, channelId);
      broadcast({ type: 'status', content: `任务审批通过: ${task.title}` }, channelId);
      return res.json({ ok: true, taskId: task.id, status: t.status, phase: t.phase });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 审批驳回 (退回队列)
  app.post('/api/tasks/:taskId/reject', async (req, res) => {
    try {
      const { taskId } = req.params;
      const { channelId } = req.body || {};
      const tasks = await loadTaskQueue();
      const task = tasks.find(t => t.id === taskId);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
      const t = applyReviewReject(task.status);
      if (t.phase === 'not-reviewable') {
        return res.status(409).json({ error: `Task not in review (status=${task.status})` });
      }
      task.status = t.status;
      task.progress = 0;
      task.result = undefined;
      task.updatedAt = new Date().toISOString();
      await saveTaskQueue(tasks);
      broadcast({ type: 'task_status', taskId: task.id, status: t.status, progress: 0 }, channelId);
      broadcast({ type: 'status', content: `任务审批驳回, 退回队列: ${task.title}` }, channelId);
      return res.json({ ok: true, taskId: task.id, status: t.status, phase: t.phase });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}

// ==================== Task Execution ====================

async function executeTask(
  task: Task,
  channelId: string,
  getAgentForChannel: GetAgentFn,
  broadcast: BroadcastFn
): Promise<void> {
  // 2026-08-11: 认领已由 claimTaskForExecution/claimNextPendingTask (CAS) 完成并持锁,
  //   这里不再重复 startTaskExecution (会因 isExecutingTask=true 返回 false 导致提前 return).
  const { endTaskExecution } = await import('./server-storage.js');

  const agent = await getAgentForChannel(channelId);
  const tasks = await loadTaskQueue();
  const taskIndex = tasks.findIndex(t => t.id === task.id);
  if (taskIndex >= 0) {
    tasks[taskIndex].status = 'running';
    tasks[taskIndex].updatedAt = new Date().toISOString();
    await saveTaskQueue(tasks);
  }

  broadcast({ type: 'task_status', taskId: task.id, status: 'running', progress: 0 }, channelId);

  try {
    let result = '';

    switch (task.type) {
      case 'chat':
        if (task.description) {
          broadcast({ type: 'status', content: `执行任务: ${task.title}` }, channelId);
          result = await agent.prompt(task.description);
        }
        break;

      case 'read':
        if (task.description) {
          broadcast({ type: 'status', content: `读取文档: ${task.description}` }, channelId);
          const content = await documentReader.read(task.description);
          result = `📄 文档读取完成\n\n${content.text.substring(0, 500)}${content.text.length > 500 ? '...' : ''}`;
        }
        break;

      case 'summarize':
        if (task.description) {
          broadcast({ type: 'status', content: `总结文档: ${task.description}` }, channelId);
          const content = await documentReader.read(task.description);
          const { getMinimax } = await import('../constraints/index.js');
          const llm = getMinimax();
          const summary = await llm.summarize(content.text);
          result = `📝 文档总结:\n\n${summary.summary}`;
        }
        break;

      default:
        result = '未知任务类型';
    }

    // 2026-08-11 (Hermes 两段式): executor 观测到 cancel-requested → 落终态 cancelled (第二段)
    // 运行中被请求取消 → 不执行正常完成路径, 直接标记取消
    const tasksAfter = await loadTaskQueue();
    const idxAfter = tasksAfter.findIndex(t => t.id === task.id);
    if (idxAfter >= 0 && shouldFinalizeAsCancelled(tasksAfter[idxAfter].status)) {
      tasksAfter[idxAfter].status = 'cancelled';
      tasksAfter[idxAfter].result = '任务已取消';
      tasksAfter[idxAfter].updatedAt = new Date().toISOString();
      await saveTaskQueue(tasksAfter);
      broadcast({ type: 'task_status', taskId: task.id, status: 'cancelled', progress: tasksAfter[idxAfter].progress }, channelId);
      broadcast({ type: 'status', content: `任务已取消: ${task.title}` }, channelId);
      return;
    }

    // 2026-08-11 (Hermes request_review 模式): 执行完成但任务已挂入 review 审批通道 →
    //   只落结果, 不覆盖成 completed; 等 approve 路由放行 (review → completed)
    if (idxAfter >= 0 && tasksAfter[idxAfter].status === 'review') {
      tasksAfter[idxAfter].result = result;
      tasksAfter[idxAfter].updatedAt = new Date().toISOString();
      await saveTaskQueue(tasksAfter);
      broadcast({ type: 'task_status', taskId: task.id, status: 'review', progress: tasksAfter[idxAfter].progress }, channelId);
      broadcast({ type: 'status', content: `任务执行完成, 待审批: ${task.title}` }, channelId);
      return;
    }

    // 更新任务状态
    const tasks = await loadTaskQueue();
    const idx = tasks.findIndex(t => t.id === task.id);
    if (idx >= 0) {
      tasks[idx].status = 'completed';
      tasks[idx].progress = 100;
      tasks[idx].result = result;
      tasks[idx].updatedAt = new Date().toISOString();
      await saveTaskQueue(tasks);
    }

    broadcast({ type: 'task_status', taskId: task.id, status: 'completed', progress: 100, result }, channelId);
    broadcast({ type: 'ai', content: result }, channelId);

  } catch (error: any) {
    const tasks = await loadTaskQueue();
    const idx = tasks.findIndex(t => t.id === task.id);
    if (idx >= 0) {
      // 取消请求在先 → 异常属于取消副作用, 落 cancelled 而非 failed (Hermes 两段式)
      tasks[idx].status = tasks[idx].status === 'cancel-requested' ? 'cancelled' : 'failed';
      tasks[idx].error = error.message;
      tasks[idx].updatedAt = new Date().toISOString();
      await saveTaskQueue(tasks);
    }

    broadcast({ type: 'task_status', taskId: task.id, status: 'failed', error: error.message }, channelId);
    broadcast({ type: 'error', content: `任务执行失败: ${error.message}` }, channelId);
  }

  endTaskExecution();
}
