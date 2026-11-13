/**
 * Bolloon 边缘目录 (Cloudflare Workers + KV)
 *
 * 解决「初次寻找」: 两台从没见过面的机器，只凭手机号找到彼此。
 * gossip 要先有已连对端、Kademlia DHT 要先有 bootstrap —— 第一次两者都没有。
 * 这个 Worker 充当**电话簿**，只存按 `discovery_topic(phone)` 索引的 DID 签名记录。
 *
 * 契约与 Rust 端 `bolloon-web/src/rendezvous.rs` / `discovery.rs::remote_*` 完全一致：
 *   POST /api/discovery/remote/announce   body = v2 记录
 *   GET  /api/discovery/remote/find?topic=<64hex>  → {ok, found, record}
 *   GET  /health
 *
 * 隐私 / 信任边界（重要）:
 *  - 上行只有 topic(加盐哈希) + 签名记录；**手机号明文永不到达这里**。
 *  - 本 Worker **不验 ED25519 签名**（Rust 的 signed_message_v2 把 JSON 序列化顺序
 *    纳入签名，JS 侧重算容易因键序不一致误拒）。验签由客户端 `verify_record` 完成，
 *    所以即使 KV 被投毒 / Worker 被替换，也冒充不了别人、换不了 DIAP 地址。
 *  - 这里只做形状、v2、时效与去重校验，把这层当作不可信的公开公告板。
 *  - 记录 30 天自动过期，不长期留存。
 */

export interface Env {
  RECORDS: KVNamespace;
}

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const TTL_SECONDS = 30 * 24 * 60 * 60;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
      'cache-control': 'no-store',
    },
  });

const isTopic = (t: unknown): t is string =>
  typeof t === 'string' && t.length === 64 && /^[0-9a-f]+$/.test(t);

function validRecord(r: any): boolean {
  if (!r || typeof r !== 'object') return false;
  if (Number(r.v ?? 1) < 2) return false;               // 只收签名覆盖地址的 v2
  if (!isTopic(r.topic)) return false;
  if (typeof r.did !== 'string' || !r.did.startsWith('did:pi:')) return false;
  if (typeof r.sig !== 'string' || r.sig.length !== 128) return false;
  if (typeof r.ts_ms !== 'number' || !Number.isFinite(r.ts_ms)) return false;
  if (Math.abs(Date.now() - r.ts_ms) > MAX_AGE_MS) return false; // 防重放
  if (r.diap == null) return false;                     // 没有 DIAP 地址的记录没用
  return true;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return json({ ok: true });
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'bolloon-rendezvous', ts: Date.now() });
    }

    if (url.pathname === '/api/discovery/remote/announce' && request.method === 'POST') {
      let rec: unknown;
      try {
        rec = await request.json();
      } catch {
        return json({ ok: false, error: 'body 不是 JSON' }, 400);
      }
      // 兼容 Rust 端两种形状: 直接 record 或 {record: ...}
      const r = (rec as any)?.record ?? rec;
      if (!validRecord(r)) {
        return json({ ok: false, error: '记录形状不对 / 非 v2 / 时间戳过期' }, 400);
      }
      const prev = await env.RECORDS.get(r.topic, 'json') as any | null;
      if (prev?.ts_ms && prev.ts_ms >= r.ts_ms) {
        return json({ ok: true, topic: r.topic, fresh: false });
      }
      await env.RECORDS.put(r.topic, JSON.stringify(r), { expirationTtl: TTL_SECONDS });
      return json({ ok: true, topic: r.topic, fresh: true });
    }

    if (url.pathname === '/api/discovery/remote/find' && request.method === 'GET') {
      const topic = url.searchParams.get('topic');
      if (!isTopic(topic)) return json({ ok: false, error: 'topic 必须是 64 位 hex' }, 400);
      const raw = await env.RECORDS.get(topic);
      if (!raw) return json({ ok: true, found: false });
      try {
        return json({ ok: true, found: true, record: JSON.parse(raw) });
      } catch {
        return json({ ok: true, found: false });
      }
    }

    return json({ ok: false, error: 'not found' }, 404);
  },
};
