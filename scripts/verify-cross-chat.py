#!/usr/bin/env python3
"""跨机「多轮交流」端到端验证 —— 走 iroh / DIAP / 去中心化 DHT 通道。

默认模式（**这才是跨机互联的真实通道**）:
    cd rust && cargo build -q -p bolloon-cli --features "diap-backend dht-backend" && cd ..
    python3 scripts/verify-cross-chat.py

  三个真进程: R = Kademlia DHT bootstrap（不参与交流）、A / B = 两个 bolloon 节点。
  A、B **互不登记对端 DIAP 地址**、**不用 node_connect**、**不用任何可达 HTTP 地址**
  （BOLLOON_PUBLIC_URL 与 directory_peers 里的 url 都是不可解析的假 host）。
  两端只凭手机号经 DHT 找到对方，随后所有对话都经 DIAP/iroh 隧道传输。
  一旦某处偷偷回退到 HTTP，请求就会因假 host 解析失败 ⇒ 验证立刻变红。

  验证项:
   1. DHT / DIAP 两端均 enabled，B 的 gossip 缓存为空（证明发现只可能来自 DHT）;
   2. 只输手机号 contacts/connect 连上，via = Kademlia DHT;
   3. 同一 session_id 恒定、turn 递增、对端模型收到的上下文条数递增（真多轮）;
   4. chat/history 回看双方消息、chat/auto 智能体自动接力并写入同一会话。

  --http 模式: 旧的「HTTP 直连 + node_connect」对照，仅用于快速冒烟，**不代表跨机通道**。

临时进程、BOLLOON_HOME 与日志在 finally 里清理。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(ROOT, 'rust', 'target', 'debug', 'bolloon')
MODE = ('http' if '--http' in sys.argv else
        'rendezvous' if '--rendezvous' in sys.argv else 'diap')
PORTS = {'R': 54943, 'A': 54941, 'B': 54942}
DHT_PORTS = {'R': 54953, 'A': 54951, 'B': 54952}
MOCK_PORT = 54947
TMP = tempfile.mkdtemp(prefix='bolloon-cross-chat-')
HOMES = {k: os.path.join(TMP, k) for k in PORTS}
BA = f'http://127.0.0.1:{PORTS["A"]}'
BB = f'http://127.0.0.1:{PORTS["B"]}'
BR = f'http://127.0.0.1:{PORTS["R"]}'
FAILS = []


def check(name, cond, detail=None):
    print(f'[{"PASS" if cond else "FAIL"}] {name}' + (f' :: {detail}' if detail else ''), flush=True)
    if not cond:
        FAILS.append(name)


def api(base, method, path, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return {'_http': e.code, 'body': e.read().decode()[:200]}
    except Exception as e:
        return {'_err': str(e)[:200]}


class MockLLM(BaseHTTPRequestHandler):
    """把「收到几条 messages」回显进回复，用来证明多轮上下文真的到了模型。"""

    def do_POST(self):
        n = int(self.headers.get('Content-Length', '0'))
        try:
            req = json.loads(self.rfile.read(n).decode() if n else '{}')
        except Exception:
            req = {}
        count = len(req.get('messages') or [])
        msg = {'role': 'assistant', 'content': f'CROSS_REPLY[msgs={count}]'}
        body = json.dumps({
            'id': 'mock', 'object': 'chat.completion', 'created': 0, 'model': 'mock',
            'choices': [{'index': 0, 'message': msg, 'finish_reason': 'stop'}],
            'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2},
        }).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def start(k, bootstrap=''):
    env = os.environ.copy()
    # 故意用不可解析的假 host: 任何 HTTP 回退都会当场失败
    public = (f'http://127.0.0.1:{PORTS[k]}' if MODE == 'http'
              else f'http://unreachable-{k.lower()}.invalid:54188')
    env.update({
        'BOLLOON_HOME': HOMES[k],
        'BOLLOON_HA_HOME': os.path.join(HOMES[k], 'kernel-ha'),
        'BOLLOON_PUBLIC_URL': public,
        'BOLLOON_API_KEY': 'test-key',
        'BOLLOON_BASE_URL': f'http://127.0.0.1:{MOCK_PORT}/v1',
        'BOLLOON_MODEL': 'mock',
    })
    if MODE in ('diap', 'rendezvous'):
        env.update({
            'BOLLOON_DIAP': '1',
            # 边缘目录模式刻意不启 DHT: 证明「初次寻找」不需要任何 bootstrap
            'BOLLOON_RENDEZVOUS': (f'http://127.0.0.1:{PORTS["R"]}'
                                   if MODE == 'rendezvous' else 'off'),
        })
        if MODE == 'diap':
            env.update({
                'BOLLOON_DHT': '1',
                'BOLLOON_DHT_PORT': str(DHT_PORTS[k]),
                'BOLLOON_DHT_BOOTSTRAP': bootstrap,
            })
    if k == 'R':
        env['BOLLOON_RENDEZVOUS'] = 'off'  # R 只是目录本身，不对外登记
    log = open(os.path.join(TMP, f'{k}.log'), 'w')
    return subprocess.Popen([BIN, 'web', '--port', str(PORTS[k])],
                            env=env, stdout=log, stderr=subprocess.STDOUT)


def wait_ready(base, path='/api/quic/addr', key='did', tries=70):
    for _ in range(tries):
        r = api(base, 'GET', path, timeout=5)
        if isinstance(r, dict) and r.get(key):
            return r
        time.sleep(1)
    return r


def msg_count(reply):
    try:
        return int(str(reply).split('msgs=')[1].split(']')[0])
    except Exception:
        return -1


def main():
    if not os.path.exists(BIN):
        feat = '--features "diap-backend dht-backend"' if MODE == 'diap' else ''
        print(f'缺少二进制: {BIN}\n先跑: cd rust && cargo build -q -p bolloon-cli {feat}',
              file=sys.stderr)
        return 2
    srv = ThreadingHTTPServer(('127.0.0.1', MOCK_PORT), MockLLM)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    procs = {}
    try:
        bootstrap = ''
        if MODE in ('diap', 'rendezvous'):
            os.makedirs(HOMES['R'], exist_ok=True)
            procs['R'] = start('R')
            if MODE == 'diap':
                sr = wait_ready(BR, '/api/dht/status', 'enabled')
                pid0 = sr.get('peer_id')
                check('Kademlia DHT bootstrap 启动', bool(pid0), f'peer_id={str(pid0)[:20]}')
                if not pid0:
                    return 1
                bootstrap = f'/ip4/127.0.0.1/tcp/{DHT_PORTS["R"]}/p2p/{pid0}'
            else:
                sr = wait_ready(BR, '/api/discovery/remote/find?topic=' + 'ab' * 32, 'ok')
                check('边缘目录节点启动（bolloon.cn 的本地替身）', sr.get('ok') is True)

        for k in ('A', 'B'):
            os.makedirs(HOMES[k], exist_ok=True)
            procs[k] = start(k, bootstrap)
        da = wait_ready(BA)
        db = wait_ready(BB)
        check('两节点启动且 DID 不同',
              bool(da.get('did')) and bool(db.get('did')) and da['did'] != db['did'],
              f"A={str(da.get('did'))[:18]}… B={str(db.get('did'))[:18]}…")

        if MODE == 'diap':
            dht_a = wait_ready(BA, '/api/dht/status', 'enabled')
            dht_b = wait_ready(BB, '/api/dht/status', 'enabled')
            dia_a = wait_ready(BA, '/api/diap/addr', 'enabled')
            dia_b = wait_ready(BB, '/api/diap/addr', 'enabled')
            check('两端 DHT 与 DIAP/iroh 均已启用',
                  all(x.get('enabled') for x in (dht_a, dht_b, dia_a, dia_b)),
                  f"A(conn={dht_a.get('connections')}) B(conn={dht_b.get('connections')})")
            time.sleep(2)
        elif MODE == 'rendezvous':
            dia_a = wait_ready(BA, '/api/diap/addr', 'enabled')
            dia_b = wait_ready(BB, '/api/diap/addr', 'enabled')
            rs = wait_ready(BA, '/api/rendezvous/status', 'enabled')
            check('DIAP/iroh 与边缘目录均已启用（DHT 未启动）',
                  all(x.get('enabled') for x in (dia_a, dia_b, rs)),
                  f'base={rs.get("base")}')

        sel = {'provider': 'env', 'model': 'mock', 'api_key': 'test-key',
               'base_url': f'http://127.0.0.1:{MOCK_PORT}/v1'}
        sa = api(BA, 'POST', '/api/models/select', sel)
        sb = api(BB, 'POST', '/api/models/select', sel)
        check('两端指向本地 mock LLM', sa.get('ok') is not False and sb.get('ok') is not False)

        phone_a, phone_b = '13115718038', '17681953616'
        bind_a = api(BA, 'POST', '/api/phone/bind', {'phone': phone_a, 'publish': True})
        bind_b = api(BB, 'POST', '/api/phone/bind', {'phone': phone_b, 'publish': True})
        check('两端绑定手机号并发布盲索引',
              bind_a.get('ok') is True and bind_b.get('ok') is True)
        if MODE == 'diap':
            check('手机号记录已写入 Kademlia DHT',
                  (bind_a.get('dht') or {}).get('ok') is True
                  and (bind_b.get('dht') or {}).get('ok') is True,
                  f"A={bind_a.get('dht')} B={bind_b.get('dht')}")
            gossip = api(BB, 'GET', f'/api/discovery/find?phone={phone_a}')
            check('B 的 gossip 缓存为空（发现只可能来自 DHT）',
                  gossip.get('found') is False, f"found={gossip.get('found')}")
        elif MODE == 'rendezvous':
            check('手机号记录已登记到边缘目录',
                  (bind_a.get('rendezvous') or {}).get('ok') is True
                  and (bind_b.get('rendezvous') or {}).get('ok') is True,
                  f"A={bind_a.get('rendezvous')} B={bind_b.get('rendezvous')}")
            gossip = api(BB, 'GET', f'/api/discovery/find?phone={phone_a}')
            check('B 的 gossip 缓存为空、DHT 未启动（发现只可能来自边缘目录）',
                  gossip.get('found') is False, f"found={gossip.get('found')}")

        if MODE in ('diap', 'rendezvous'):
            c1 = api(BA, 'POST', '/api/contacts/connect',
                     {'query': phone_b, 'kind': 'phone'}, timeout=90)
            c2 = api(BB, 'POST', '/api/contacts/connect',
                     {'query': phone_a, 'kind': 'phone'}, timeout=90)
            label = 'Kademlia DHT' if MODE == 'diap' else '边缘目录'
            check(f'只输手机号经{label}连上对方（零 bootstrap）',
                  c1.get('ok') is True and c2.get('ok') is True,
                  f"A→B via={c1.get('via')} / B→A via={c2.get('via')}")
            check(f'发现路径是 {label}',
                  c1.get('via') == label, f"via={c1.get('via')}")
        else:
            conn = api(BA, 'POST', '/api/node/connect', {'url': BB, 'name': 'A节点'})
            check('(对照) HTTP node_connect 互加好友',
                  conn.get('ok') is True and conn.get('mutual') is True)

        ag = api(BB, 'POST', '/api/agents', {'name': 'B端接待智能体'})
        aid = ag.get('id') or (ag.get('agent') or {}).get('id')
        check('B 创建智能体', bool(aid), f'id={aid}')
        grant = api(BB, 'POST', f'/api/agents/{aid}/grants',
                    {'did': da['did'], 'caps': ['chat']}) if aid else {}
        check('B 授权 A 的 chat 能力', grant.get('ok') is not False, str(grant)[:120])

        # ── 多轮: 假 host 下若回退 HTTP 必失败；能通就说明走的是 DIAP 隧道 ──
        sessions, turns, counts = [], [], []
        for i in range(1, 4):
            r = api(BA, 'POST', f'/api/friends/{db["did"]}/chat',
                    {'agent_id': aid, 'text': f'第{i}轮问题'}, timeout=60)
            sessions.append(r.get('session_id'))
            turns.append(r.get('turn'))
            counts.append(msg_count(r.get('reply')))
            check(f'第{i}轮跨机对话 ok（经 DIAP/iroh 通道）' if MODE in ('diap', 'rendezvous') else f'第{i}轮对话 ok',
                  r.get('ok') is True,
                  f'session={str(r.get("session_id"))[:12]} turn={r.get("turn")} '
                  f'reply={str(r.get("reply"))[:48]} err={r.get("error") or r.get("_err") or ""}')
        check('三次同一个 session_id', len(set(sessions)) == 1 and all(sessions), str(sessions))
        check('turn 严格递增', all(turns[i] < turns[i + 1] for i in range(len(turns) - 1)), str(turns))
        check('对端模型收到的上下文逐轮增加（多轮真的生效）',
              counts[0] > 0 and counts[0] < counts[1] < counts[2], str(counts))

        hist = api(BA, 'GET', f'/api/friends/{db["did"]}/chat/history?limit=50')
        hs = hist.get('turns') or []
        check('chat/history 回看双方消息',
              hist.get('count') == 6 and len(hs) == 6
              and any(t['direction'] == 'out' for t in hs)
              and any(t['direction'] == 'in' for t in hs),
              f'count={hist.get("count")} dirs={[t["direction"] for t in hs]}')

        auto = api(BA, 'POST', f'/api/friends/{db["did"]}/chat/auto',
                   {'agent_id': aid, 'max_turns': 2,
                    'intent': '确认对方在线并询问一个可回答的问题'}, timeout=90)
        rounds = auto.get('turns') or []
        check('chat/auto 智能体自动接力 2 轮',
              auto.get('completed') == 2
              and all(x.get('remote', {}).get('ok') is True for x in rounds if 'said' in x),
              f'completed={auto.get("completed")} rounds={len(rounds)} '
              f'error={auto.get("error") or auto.get("_err") or ""}')

        hist2 = api(BA, 'GET', f'/api/friends/{db["did"]}/chat/history?limit=50')
        check('自动接力的消息也进了同一会话历史',
              hist2.get('count', 0) > hist.get('count', 0),
              f'{hist.get("count")} -> {hist2.get("count")}')
    finally:
        for p in procs.values():
            try:
                p.terminate()
                p.wait(timeout=5)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass
        srv.shutdown()
        shutil.rmtree(TMP, ignore_errors=True)

    print(f'\n=== RESULT ({MODE} 通道) ===', 'ALL PASS' if not FAILS else f'FAILED: {FAILS}')
    return 0 if not FAILS else 1


if __name__ == '__main__':
    sys.exit(main())
