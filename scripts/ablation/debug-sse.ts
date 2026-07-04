// @ts-nocheck
/**
 * ablation/debug-sse.ts — 调试 SSE 监听到底有没有事件
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..', '..');
const PORT = 54188;
const BASE = `http://127.0.0.1:${PORT}`;

async function main() {
  // 1) 拿 channel
  const channels = await fetch(`${BASE}/channels`).then(r => r.json());
  const channel = channels[0];
  console.log(`[debug] channel = ${channel.id} (${channel.name})`);

  // 2) 仿 v0.2.7 runner: 先 SSE, 再 POST, 再读
  const t0 = Date.now();
  const sseRes = await fetch(`${BASE}/events?channelId=${encodeURIComponent(channel.id)}`);
  console.log(`[debug] SSE status=${sseRes.status} ok=${sseRes.ok}`);
  if (!sseRes.body) {
    console.log('[debug] NO SSE BODY');
    return;
  }

  // 2s 后发 POST
  setTimeout(async () => {
    const postRes = await fetch(`${BASE}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelId: channel.id, text: '查一下"Bolloon agent"是什么?用一句话回答。' })
    });
    const data = await postRes.json().catch(() => null);
    console.log(`[debug] POST status=${postRes.status} data=${JSON.stringify(data)}`);
  }, 1000);

  // 3) 读 SSE 流
  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let aiText = '';
  let tokenText = '';
  let toolSeen = false;
  const eventTypes: string[] = [];
  const deadline = Date.now() + 30000;
  outer: while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<any>(r => setTimeout(() => r({ value: undefined, done: false }), 5000)),
    ]);
    if (done) break;
    if (value) {
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const ln of lines) {
        if (!ln.startsWith('data:')) continue;
        const payload = ln.substring(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const evt = JSON.parse(payload);
          const tag = evt.type + (evt.streamType ? ':' + evt.streamType : '');
          eventTypes.push(tag);
          console.log(`[sse:${Date.now()-t0}ms] ${tag} ${evt.content ? 'contentLen=' + evt.content.length : ''} ${evt.tool ? 'tool=' + evt.tool : ''}`);
          if (evt.type === 'ai' && typeof evt.content === 'string') aiText += evt.content;
          if (evt.type === 'stream' && evt.streamType === 'token' && typeof evt.content === 'string') tokenText += evt.content;
          if (evt.type === 'status' && evt.tool) toolSeen = true;
          if (evt.type === 'done' || evt.type === 'finish') break outer;
        } catch {}
      }
    }
  }
  try { await reader.cancel(); } catch {}

  console.log(`\n[debug] total: ${Date.now()-t0}ms, toolSeen=${toolSeen}, aiTextLen=${aiText.length}, tokenTextLen=${tokenText.length}`);
  console.log(`[debug] eventTypes (${eventTypes.length}):`, eventTypes.slice(0, 30).join(','));
}

main().catch(e => { console.error(e); process.exit(1); });