#!/usr/bin/env python3
"""verify-cli-msg5-pty.py — tsx 源码模式 + 项目 send_cmd 时序, 测普通消息提交"""
import os, pty, time, select, re, json, tempfile

TMP = tempfile.mkdtemp(prefix='bolloon-msg5-')
os.makedirs(os.path.join(TMP, '.bolloon', 'sessions'), exist_ok=True)
channels = [
    {"id": "ch-1", "name": "测试频道", "agentId": "agent-1",
     "persona": {"name": "TestAgent", "description": "测试"}},
]
with open(os.path.join(TMP, '.bolloon', 'sessions', 'channels.json'), 'w') as f:
    json.dump(channels, f)

ENV = {**os.environ, 'HOME': TMP}
ansi_re = re.compile(rb"\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]")

pid, fd = pty.fork()
if pid == 0:
    os.chdir('/Users/apple/Downloads/bolloon')
    os.execve('/usr/bin/env', ['env', 'HOME=' + TMP, 'npx', 'tsx', 'src/index.ts'], ENV)

buf = b''
_search_pos = 0
def read_until(needle, timeout, label=''):
    global buf, _search_pos
    n = needle.encode() if isinstance(needle, str) else needle
    deadline = time.time() + timeout
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.15)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            buf += data
            idx = buf.find(n, _search_pos)
            if idx >= 0:
                _search_pos = idx + len(n)
                return True
    return False

def send(text):
    os.write(fd, text if isinstance(text, bytes) else text.encode())

def send_cmd(text):
    # 2026-08-07: chunk 模式 ("text\r" 一次发送) — pty 下单独 \r 会被 cooked 行规程消费而丢失,
    #   chunk 里 \r 以 \n 到达 Ink → 应用层 \n/\r 兜底分支提交 (兼容 raw/cooked)
    send(text + "\r")
    read_until("❯ " + text, 8)
    time.sleep(1.2)

def get_screen():
    return ansi_re.sub(b'', buf).decode('utf-8', 'replace')

print('[启动] 等待 CLI...')
ok = read_until("Esc 双击退出", 90, 'ready')
print('[启动]', ok)
time.sleep(1.5)

print('[测1] 发送 hi...')
send_cmd('hi')
time.sleep(2)
s = get_screen()
print('  已发送框:', '已发送' in s)
print('  思考动画:', '思考' in s)
print('  弹窗误开:', '命令 · 技能' in s)

print('[等待 60s LLM...]')
time.sleep(60)
s = get_screen()
print('  ◉ Bolloon Agent 回复框:', '◉ Bolloon Agent' in s)
m = re.search(r'(\d+(?:\.\d+)?[kM]?/1M\s*│\s*\[[^\]]*\]\s*[\d.]+%)', s)
print('  状态栏:', m.group(1) if m else '?')
print('=== 尾部 1500 ===')
print(s[-1500:])
