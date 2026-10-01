/**
 * 写路径护栏: 不许再一刀封死整个数据目录 (2026-10-01, 用户实测)。
 *
 * 症状: `patch` 写 `~/.bolloon/context-os/01-Me/xxx.md` 被拒 ("命中硬编码禁区 /(^|\/)\.bolloon\//"),
 *   而紧接着 `write_context_asset`(走 Node fs) 写**同一个目录**成功 ⇒ 同一个目录, 一个工具能写一个不能 ✗。
 * 根因: 禁区正则 `/(^|\/)\.bolloon\//` 把整个数据目录一刀封死, 没区分"凭证"与"agent 自己的工作区"。
 * 口径: 只封 凭证 / 身份密钥 / 会话数据 / 钱包; context-os · persona · memory · logs 等放行。
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { checkWritePath } from '../agents/shell-guard.js';

const H = os.homedir();
const p = (...seg: string[]) => path.join(H, '.bolloon', ...seg);

describe('写路径护栏: 工作区放行 / 敏感区仍封', () => {
  it('放行: agent 自己的工作区 (用户踩到的那条)', () => {
    for (const t of [
      p('context-os', '01-Me', '1790849107407-我的名字.md'),
      p('context-os', 'agent-x', '02-Projects', 'a.md'),
      p('persona', 'agent-233', 'soul.md'),
      p('memory', 'agent-233', 'engine', 'x.json'),
      p('logs', 'startup.log'),
      p('goals', 'g-1.json'),
      p('runs', 'r-1.json'),
    ]) {
      expect(checkWritePath(t).allowed, `应放行却被拒: ${t}`).toBe(true);
    }
  });

  it('仍封: 凭证 / 身份密钥 / 会话数据 / 钱包', () => {
    for (const t of [
      p('identity.json'),
      p('keypair.json'),
      p('llm-config.json'),
      p('chain.json'),
      p('agent-keys', 'agent-233.json'),
      p('wallets', 'mainnet.json'),
      p('sessions', 'channels.json'),
      p('bindings', 'x.json'),
    ]) {
      expect(checkWritePath(t).allowed, `应拒却放行: ${t}`).toBe(false);
    }
  });

  it('护栏自己仍然不可改 (原意保留)', () => {
    expect(checkWritePath(path.join(process.cwd(), 'src/agents/shell-guard.ts')).allowed).toBe(false);
    expect(checkWritePath(path.join(os.homedir(), '.env')).allowed).toBe(false);
  });
});
