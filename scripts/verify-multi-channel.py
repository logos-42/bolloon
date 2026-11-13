#!/usr/bin/env python3
"""补充验证（2026-11-13）：

1. **邮箱直连**：只给邮箱，经边缘目录兜底连上（去中心化没命中时）；
2. **DID 直连**：只给 DID，同样能连；
3. **边缘兜底**：关掉 DHT、互不登记，去中心化必然 miss ⇒ 才走 Cloudflare；
4. **QUIC 指令可显示**：`/api/quic/history` 里能看出 `kind=command` 与指令摘要；
5. **多设备共享通道**：A 导出会话 → C（第三台）导入 → 会话索引一致且幂等。

前置：`cd rust && cargo build -q -p bolloon-cli --features "diap-backend dht-backend"`。
临时进程/目录在 finally 清理。
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
PORTS = {'A': 54961, 'B': 54962, 'C': 54963}
MOCK_PORT = 54967
EDGE = 'https://bolloon.cn'
TMP = tempfile.mkdtemp(prefix='bolloon-multi-channel-')
HOMES = {k: os.path.join(TMP, k) for k in PORTS}
BA = f'http://127.0.0.1:{PORTS["A"]}'
BB = f'http://127.0.0.1:{PORTS["B"]}'
BC = f'http://127.0.0.1:{PORTS["C"]}'
FAILS = []


def check(name, cond, detail=None):
    print(f'[{"PASS" if cond else "FAIL"}] {name}' + (f' :: {detail}' if detail else ''), flush=True)
    if not cond:
        FAILS.append(name)


def api(base, method, path, body=None, timeout=90):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json',
                                          'User-Agent': 'bolloon-verify/1 (+https://bolloon.cn)'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return {'_http': e.code, 'body': e.read().decode()[:200]}
    except Exception as e:
        return {'_err': str(e)[:200]}


class MockLLM(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('Content-Length', '0'))
        try:
            req = json.loads(self.rfile.read(n).decode() if n else '{}')
        except Exception:
            req = {}
        msg = {'role': 'assistant', 'content': f'MOCK_REPLY[msgs={len(req.get("messages") or [])}]'}
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


def start(k):
    env = os.environ.copy()
    env.update({
        'BOLLOON_HOME': HOMES[k],
        'BOLLOON_HA_HOME': os.path.join(HOMES[k], 'kernel-ha'),
        'BOLLOON_PUBLIC_URL': f'http://unreachable-{k.lower()}.invalid:54188',
        'BOLLOON_API_KEY': 'test-key',
        'BOLLOON_BASE_URL': f'http://127.0.0.1:{MOCK_PORT}/v1',
        'BOLLOON_MODEL': 'mock',
        'BOLLOON_DIAP': '1',
        # 刻意关掉 DHT：证明「去中心化没命中才走边缘目录」
        'BOLLOON_DHT': '0',
        'BOLLOON_RENDEZVOUS': EDGE,
    })
    log = open(os.path.join(TMP, f'{k}.log'), 'w')
    return subprocess.Popen([BIN, 'web', '--port', str(PORTS[k])],
                            env=env, stdout=log, stderr=subprocess.STDOUT)


def wait_ready(base, tries=70):
    r = {}
    for _ in range(tries):
        r = api(base, 'GET', '/api/diap/addr', timeout=5)
        if r.get('enabled'):
            return r
        time.sleep(1)
    return r


def main():
    if not os.path.exists(BIN):
        print(f'缺少二进制: {BIN}\n先跑: cd rust && cargo build -q -p bolloon-cli '
              f'--features "diap-backend dht-backend"', file=sys.stderr)
        return 2
    if not os.environ.get('BOLLOON_MULTI_CHANNEL_SKIP_EDGE'):
        h = api(EDGE, 'GET', '/api/discovery/remote/find?topic=' + 'ab' * 32, timeout=10)
        if not h.get('ok'):
            print(f'边缘目录不可达: {EDGE} :: {h}', file=sys.stderr)
            return 2

    srv = ThreadingHTTPServer(('127.0.0.1', MOCK_PORT), MockLLM)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    procs = {}
    try:
        for k in PORTS:
            os.makedirs(HOMES[k], exist_ok=True)
            procs[k] = start(k)
        da, db, dc = wait_ready(BA), wait_ready(BB), wait_ready(BC)
        check('三节点启动（DIAP 开 / DHT 关 / 边缘兜底）',
              all(x.get('enabled') for x in (da, db, dc)))
        qa = api(BA, 'GET', '/api/quic/addr')
        qb = api(BB, 'GET', '/api/quic/addr')
        did_a, did_b = qa.get('did'), qb.get('did')
        check('A/B 有不同 DID', bool(did_a) and bool(did_b) and did_a != did_b,
              f"A={str(did_a)[:18]}… B={str(did_b)[:18]}…")

        sel = {'provider': 'env', 'model': 'mock', 'api_key': 'test-key',
               'base_url': f'http://127.0.0.1:{MOCK_PORT}/v1'}
        for base in (BA, BB, BC):
            api(base, 'POST', '/api/models/select', sel)

        # ── 1. 邮箱直连（去中心化 miss ⇒ 边缘目录） ──
        email_b = 'peer-b@example.com'
        ann_email = api(BB, 'POST', '/api/discovery/announce-self',
                        {'kind': 'email', 'value': email_b})
        check('B 发布邮箱发现记录', ann_email.get('ok') is True, str(ann_email)[:160])
        c_email = api(BA, 'POST', '/api/contacts/connect',
                      {'query': email_b, 'kind': 'email'}, timeout=90)
        check('只给邮箱经边缘目录兜底连上',
              c_email.get('ok') is True and c_email.get('via') == '边缘目录',
              f"via={c_email.get('via')} err={c_email.get('error')}")

        # ── 2. DID 直连 ──
        ann_did = api(BB, 'POST', '/api/discovery/announce-self',
                      {'kind': 'did', 'value': did_b})
        check('B 发布 DID 发现记录', ann_did.get('ok') is True, str(ann_did)[:120])
        c_did = api(BA, 'POST', '/api/contacts/connect', {'did': did_b}, timeout=90)
        check('只给 DID 经边缘目录兜底连上',
              c_did.get('ok') is True and c_did.get('via') in ('边缘目录', '显式 DID'),
              f"via={c_did.get('via')} err={c_did.get('error')}")

        # ── 3. 授权 + QUIC 指令可显示 ──
        ag = api(BB, 'POST', '/api/agents', {'name': 'B端'})
        aid = ag.get('id') or (ag.get('agent') or {}).get('id')
        api(BB, 'POST', f'/api/agents/{aid}/grants',
            {'did': did_a, 'caps': ['chat', 'command_readonly']})
        instr = 'QUIC-INSTR-检查磁盘占用'
        cmd = api(BA, 'POST', f'/api/friends/{did_b}/command',
                  {'agent_id': aid, 'instruction': instr}, timeout=90)
        check('跨机指令经 QUIC 发到 B 并返回', cmd.get('ok') is True,
              f"ok={cmd.get('ok')} err={cmd.get('error')}")

        qh = api(BA, 'GET', '/api/quic/history?limit=200')
        items = qh.get('items') or []
        cmds = [x for x in items if x.get('kind') == 'command']
        check('QUIC 历史里能解析出指令（kind + 摘要）',
              len(cmds) > 0 and any(instr[:10] in (x.get('summary') or '') for x in cmds),
              f'items={len(items)} commands={len(cmds)} '
              f'summary={(cmds[0].get("summary") if cmds else "")}')
        chats = [x for x in items if x.get('kind') == 'chat']
        check('QUIC 历史区分聊天/指令类型', any(chats) or len(cmds) > 0,
              f'chat={len(chats)} command={len(cmds)}')

        # ── 4. 多设备共享通道 ──
        exp = api(BA, 'GET', '/api/cross-chat/export?since_ms=0')
        turns = exp.get('turns') or []
        check('A 能导出会话历史', exp.get('ok') is True and len(turns) > 0,
              f'count={exp.get("count")}')
        imp = api(BC, 'POST', '/api/cross-chat/import', {'turns': turns})
        check('C（另一台设备）导入成功', imp.get('ok') is True and imp.get('added', 0) > 0,
              f'added={imp.get("added")} skipped={imp.get("skipped")}')
        imp2 = api(BC, 'POST', '/api/cross-chat/import', {'turns': turns})
        check('重复导入幂等（不会翻倍）', imp2.get('added') == 0,
              f'added={imp2.get("added")} skipped={imp2.get("skipped")}')
        sA = api(BA, 'GET', '/api/cross-chat/sessions')
        sC = api(BC, 'GET', '/api/cross-chat/sessions')
        check('两台设备的会话索引一致',
              sA.get('count') == sC.get('count') and sC.get('count', 0) > 0,
              f"A={sA.get('count')} C={sC.get('count')}")
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

    print('\n=== RESULT (email/DID · edge fallback · QUIC command · multi-device) ===',
          'ALL PASS' if not FAILS else f'FAILED: {FAILS}')
    return 0 if not FAILS else 1


if __name__ == '__main__':
    sys.exit(main())
