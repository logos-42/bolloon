export interface Env {
  KV_BINDING: KVNamespace;
}

const ACCOUNTS_KEY = 'accounts';
const VALID_PROVIDERS = ['github', 'google', 'email', 'phone'];

interface Account {
  provider: string;
  identifier: string;
  email: string;
  phone: string;
  username: string;
  token: string;
  ownerDid: string;
  loggedAt: string;
  skeleton: boolean;
}

async function loadAccounts(kv: KVNamespace): Promise<Account[]> {
  const raw = await kv.get(ACCOUNTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function cors(req: Request): Headers {
  const h = new Headers();
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  return h;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const headers = cors(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    const notFound = (msg: string) => new Response(JSON.stringify({ error: msg }), {
      status: 404, headers,
    });

    // GET /api/auth/status
    if (url.pathname === '/api/auth/status' && request.method === 'GET') {
      const accs = await loadAccounts(env.KV_BINDING);
      return new Response(JSON.stringify({
        ok: true,
        accounts: accs.map((a: Account) => ({
          provider: a.provider,
          identifier: a.identifier || a.email || a.username || '',
          loggedAt: a.loggedAt,
          skeleton: !!a.skeleton,
        })),
      }), { status: 200, headers });
    }

    // POST /api/auth/login
    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      let body: any = {};
      try { body = await request.json(); } catch { /* noop */ }
      const provider = String(body.provider || '').trim().toLowerCase();
      const identifier = String(body.identifier || '').trim();
      if (!VALID_PROVIDERS.includes(provider)) {
        return new Response(JSON.stringify({ error: `provider 必须是 ${VALID_PROVIDERS.join('/')}` }), {
          status: 400, headers,
        });
      }
      if ((provider === 'email' || provider === 'phone') && !identifier) {
        return new Response(JSON.stringify({ error: `${provider === 'email' ? '邮箱' : '手机号'}必填` }), {
          status: 400, headers,
        });
      }
      const ownerDid = String(body.ownerDid || '').trim();

      const accs = await loadAccounts(env.KV_BINDING);
      const now = new Date().toISOString();
      const existing = accs.find((a: Account) =>
        a.provider === provider && (!identifier || a.identifier === identifier || a.email === identifier));
      if (existing) {
        existing.ownerDid = ownerDid || existing.ownerDid;
        existing.loggedAt = now;
        existing.skeleton = true;
      } else {
        accs.push({
          provider,
          identifier,
          email: provider === 'email' ? identifier : '',
          phone: provider === 'phone' ? identifier : '',
          username: identifier,
          token: '',
          ownerDid,
          loggedAt: now,
          skeleton: true,
        });
      }
      await env.KV_BINDING.put(ACCOUNTS_KEY, JSON.stringify(accs));
      return new Response(JSON.stringify({
        ok: true, provider, identifier, ownerDid, skeleton: true,
        message: `${provider} 登录骨架已记录 (归属用户 DID), 真实 OAuth/验证码后续接入`,
      }), { status: 200, headers });
    }

    // POST /api/auth/logout
    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      let body: any = {};
      try { body = await request.json(); } catch { /* noop */ }
      const provider = String(body.provider || '').trim().toLowerCase();
      const accs = await loadAccounts(env.KV_BINDING);
      const remaining = accs.filter((a: Account) => a.provider !== provider);
      if (remaining.length === accs.length) return notFound(`未绑定 ${provider} 账号`);
      await env.KV_BINDING.put(ACCOUNTS_KEY, JSON.stringify(remaining));
      return new Response(JSON.stringify({ ok: true, provider }), { status: 200, headers });
    }

    return notFound('Not Found');
  },
};