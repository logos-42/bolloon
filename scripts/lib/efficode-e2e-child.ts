/**
 * efficode-e2e-child.ts — 「两个进程互发一条 Efficode 消息」的子进程脚本 (2026-09-28)
 *
 * 只做两件事, 供 scripts/verify-efficode.ts 起**两个真进程**用:
 *   sender   : 按"双方声明"裁决 → 编一条消息, 把帧写到 stdout (单独一行)
 *   receiver : 从 stdin 读那一行 → 严格按**对端声明**分派 → 把结果打成 RESULT {json}
 *
 * 两个进程走的是真管道 (stdout → stdin), 用的是真 src/agents/agent-lang.ts + 真 src/efficode/*,
 * 不是同一个进程里"假装两个 agent"。
 */

import {
  buildAgentMessage,
  readAgentMessage,
  type ReceivedAgentMessage,
} from '../../src/agents/agent-lang.js';

function arg(name: string, def = ''): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

const role = arg('role');
const mine = arg('mine');
const peerLangs = arg('peer-langs');

function parseLangs(v: string): unknown {
  if (!v) return undefined;
  if (v.includes(',')) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return v;
}

async function main(): Promise<void> {
  if (role === 'sender') {
    const built = buildAgentMessage({
      text: arg('text'),
      from: arg('from', 'did:bolloon:efficode-a'),
      to: arg('to', 'did:bolloon:efficode-b'),
      mine: parseLangs(mine),
      theirs: parseLangs(peerLangs),
      op: '#REQ:',
    });
    // 帧单独一行, 供父进程转给 receiver
    process.stdout.write(built.frame + '\n');
    // 诊断信息走 stderr (不污染管道里的帧)
    process.stderr.write(`SENDER lang=${built.lang} encoded=${built.encoded} bytes=${built.bytes}\n`);
    return;
  }

  if (role === 'receiver') {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(Buffer.from(c));
    const frame = Buffer.concat(chunks).toString('utf-8').trim().split('\n').filter(Boolean).pop() ?? '';
    let got: ReceivedAgentMessage | null = null;
    let error = '';
    try {
      got = readAgentMessage(frame, { mine: parseLangs(mine) });
    } catch (e) {
      error = String((e as Error)?.message ?? e);
    }
    process.stdout.write(
      'RESULT ' +
        JSON.stringify({
          got: got
            ? {
                text: got.text,
                decoded: got.decoded,
                declaredLang: got.declaredLang,
                declaredRaw: got.declaredRaw,
                fromDid: got.fromDid,
                note: got.note,
                bytes: got.bytes,
                decisionLang: got.decision.lang,
                fallback: got.decision.fallback,
              }
            : null,
          error,
        }) +
        '\n'
    );
    return;
  }

  process.stderr.write(`未知 role: ${role}\n`);
  process.exit(2);
}

void main();
