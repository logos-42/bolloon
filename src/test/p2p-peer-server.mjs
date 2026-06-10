/**
 * p2p-peer-server.mjs — 单独进程中启动一个 Bolloon 服务器,
 *                     将其端口和 P2P publicKey 写入 stdout,
 *                     监听 SIGTERM 退出.
 *
 * 用法:
 *   node src/test/p2p-peer-server.mjs <port> <role>
 *
 * 输出 (JSON, 一行):
 *   { "port": 54189, "publicKey": "d92489..." }
 */
import { createWebServer } from '../web/server.js';

const port = parseInt(process.argv[2] || '54189', 10);
const role = process.argv[3] || 'testB';

process.env.BOLLOON_ROLE = role;

const s = await createWebServer(port, { selfImprove: false });

// 等待服务器就绪后获取 publicKey
const res = await fetch(`http://localhost:${s.port}/api/p2p-publickey`);
const { publicKey } = await res.json();

process.stdout.write(JSON.stringify({ port: s.port, publicKey }) + '\n');

process.on('SIGTERM', () => {
  s.server.close();
  process.exit(0);
});
