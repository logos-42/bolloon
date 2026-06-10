/**
 * p2p-peer-server.ts — 单独进程中启动一个 Bolloon 服务器,
 *                     将其端口和 P2P publicKey 写入 stdout,
 *                     监听 SIGTERM 退出.
 *
 * 用法: npx tsx src/test/p2p-peer-server.ts <port> <role>
 *
 * stdout 输出一行 JSON: { "port": 54189, "publicKey": "d92489..." }
 * 其他日志走 stdout, 由测试端跳过非 JSON 行.
 */
import { createWebServer } from '../web/server.js';

const port = parseInt(process.argv[2] || '54189', 10);
const role = process.argv[3] || 'testB';

process.env.BOLLOON_ROLE = role;

const s = await createWebServer(port, { selfImprove: false });

let publicKey = '';
for (let i = 0; i < 10; i++) {
  try {
    const res = await fetch(`http://localhost:${s.port}/api/p2p-publickey`);
    const data = await res.json();
    if (data.publicKey) { publicKey = data.publicKey; break; }
  } catch {}
  await new Promise(r => setTimeout(r, 1000));
}
process.stdout.write(JSON.stringify({ port: s.port, publicKey }) + '\n');

process.on('SIGTERM', () => {
  s.server.close();
  process.exit(0);
});
