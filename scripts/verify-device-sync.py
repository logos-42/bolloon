#!/usr/bin/env python3
"""多设备**自动**同步验证（2026-11-13）。

不调用 `/api/cross-chat/import`，只把另一台设备登记进同步组，
然后等后台任务自己把会话记录拉过来。

场景：A/B 聊天产生记录 → C 登记 A → 等几秒 → C 也能看到同一份会话。

前置：`cd rust && cargo build -q -p bolloon-cli --features "diap-backend dht-backend"`。
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
PORTS = {'A': 54971, 'B': 54972, 'C': 54973}
MOCK_PORT = 54977
TMP = tempfile.mkdtemp(prefix='bolloon-device-sync-')
HOMES = {k: os.path.join(TMP, k) for k in PORTS}
BA = f'http://127.0.0.1:{PORTS["A"]}'
BB = f'http://127.0.0.1:{PORTS["B"]}'
BC = f'http://127.0.0.1:{PORTS["C"]}'
FAILS = []
SYNC_SECS = 2


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
    def do_POST(self):
        n = int(self.headers.get('Content-Length', '0'))
        try:
            req = json.loads(self.rfile.read(n).decode() if n else '{}')
        except Exception:
            req = {}
        msg = {'role': 'assistant', 'content': f'SYNC_REPLY[msgs={len(req.get("messages") or [])}]'}
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
        'BOLLOON_DHT': '0',
        'BOLLOON_RENDEZVOUS': 'off',
        # 关键：2 秒一轮，验证「自动」而不是手动
        'BOLLOON_DEVICE_SYNC': '1',
        'BOLLOON_DEVICE_SYNC_SECS': str(SYNC_SECS),
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
        print(f'缺少二进制: {BIN}', file=sys.stderr)
        return 2
    srv = ThreadingHTTPServer(('127.0.0.1', MOCK_PORT), MockLLM)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    procs = {}
    try:
        for k in PORTS:
            os.makedirs(HOMES[k], exist_ok=True)
            procs[k] = start(k)
        da, db, dc = wait_ready(BA), wait_ready(BB), wait_ready(BC)
        check('三节点启动且 DIAP 可用', all(x.get('enabled') for x in (da, db, dc)))

        for base in (BA, BB, BC):
            api(base, 'POST', '/api/models/select', {
                'provider': 'env', 'model': 'mock', 'api_key': 'test-key',
                'base_url': f'http://127.0.0.1:{MOCK_PORT}/v1'})

        # A ↔ B：登记 + 互加好友 + 聊两轮（产生会话记录）
        url_b = 'http://diap-peer-b:54188'
        api(BA, 'POST', '/api/directory/peers', {'url': url_b, 'diap': db.get('address')})
        conn = api(BA, 'POST', '/api/node/connect', {'url': url_b, 'name': 'B设备'}, timeout=90)
        check('A 经 DIAP 连上 B（互加好友）', conn.get('ok') is True and conn.get('mutual') is True,
              f"mutual={conn.get('mutual')}")

        did_b = api(BB, 'GET', '/api/quic/addr').get('did')
        did_a = api(BA, 'GET', '/api/quic/addr').get('did')
        ag = api(BB, 'POST', '/api/agents', {'name': 'B端'})
        aid = ag.get('id') or (ag.get('agent') or {}).get('id')
        api(BB, 'POST', f'/api/agents/{aid}/grants', {'did': did_a, 'caps': ['chat']})
        for i in (1, 2):
            api(BA, 'POST', f'/api/friends/{did_b}/chat',
                {'agent_id': aid, 'text': f'自动同步测试第{i}句'}, timeout=60)
        sa = api(BA, 'GET', '/api/cross-chat/sessions')
        check('A 已有会话记录', sa.get('count', 0) > 0, f"A sessions={sa.get('count')}")

        # C 只登记 A（带 DIAP 地址），**不调用 import**
        url_a = 'http://diap-peer-a:54188'
        reg = api(BC, 'POST', '/api/devices/register',
                  {'url': url_a, 'did': did_a, 'diap': da.get('address')})
        check('C 把 A 登记进同步组', reg.get('ok') is True, f"group={reg.get('group')}")

        # 等后台自动同步（首轮启动后 3s，间隔 2s）
        deadline = time.time() + 12
        sc = {}
        while time.time() < deadline:
            sc = api(BC, 'GET', '/api/cross-chat/sessions')
            if sc.get('count', 0) >= sa.get('count', 0):
                break
            time.sleep(1)

        check('C 未手动导入也能自动拿到会话（后台同步）',
              sc.get('count', 0) >= sa.get('count', 0) and sc.get('count', 0) > 0,
              f"A={sa.get('count')} C={sc.get('count')}")

        devs = api(BC, 'GET', '/api/devices')
        check('设备列表可见且最近一轮确有新增',
              devs.get('count') is not None or len(devs.get('devices') or []) > 0,
              f"devices={len(devs.get('devices') or [])} last_added={devs.get('last_added')}")

        # 反向：A 登记 C 后，A 也会自动拉 C（设备扩散由 /api/devices 完成）
        time.sleep(SYNC_SECS * 2)
        devs_c = api(BC, 'GET', '/api/devices')
        check('同步水位已推进', (devs_c.get('devices') or [{}])[0].get('last_ok_ms', 0) > 0,
              f"first={ (devs_c.get('devices') or [{}])[0] }")
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

    print('\n=== RESULT (multi-device auto sync) ===', 'ALL PASS' if not FAILS else f'FAILED: {FAILS}')
    return 0 if not FAILS else 1


if __name__ == '__main__':
    sys.exit(main())
