#!/usr/bin/env python3
"""verify-channel-pty.py — CLI /channel 端到端 pty 实测 (2026-08-06)

Case 1: /channel <name> → 状态栏与确认行更新
Case 2: /channel <number> → 索引解析
Case 3: /channel <id> → id 解析
Case 4: 重启后恢复上次 active channel
跑法: python3 scripts/verify-channel-pty.py
"""
import os, pty, time, select, re, json, sys

# --- 临时 HOME (隔离, 不碰真实 ~/.bolloon) ---
import tempfile, shutil
TMP = tempfile.mkdtemp(prefix='bolloon-channel-test-')
os.makedirs(os.path.join(TMP, '.bolloon', 'sessions'), exist_ok=True)
channels = [
    {"id": "ch-research", "name": "research-channel", "agentId": "agent-research", "persona": {"name": "ResearchAgent", "description": "研究助手"}},
    {"id": "ch-trade", "name": "trade-channel", "agentId": "agent-trade", "persona": {"name": "TradeAgent", "personality": "交易"}},
    {"id": "ch-meta", "name": "meta-channel", "agentId": "agent-meta"},
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
passed, failed = 0, 0
_search_pos = 0  # fresh 窗口: 只匹配本次调用之后的新数据 (防旧输出误匹配)

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

def send(s):
    os.write(fd, s if isinstance(s, bytes) else s.encode())

def send_cmd(text):
    """模拟真实打字: 发文本 → 等输入框显示 → 再发 Enter。
    (Ink 把整 chunk 当一次 keypress, 混入的回车不被识别为 return;
    pty 会把连续 write 合并, 必须等 UI 反馈后再发 \r — 2026-08-06 实测)"""
    os.write(fd, text.encode())
    read_until("❯ " + text, 8)
    time.sleep(0.3)
    os.write(fd, b"\r")

def check(name, ok, extra=''):
    global passed, failed
    if ok:
        passed += 1
        print(f"  ✅ {name}")
    else:
        failed += 1
        print(f"  ❌ {name} {extra}")
        if not extra:
            tail = ansi_re.sub(b'', buf)[-500:]
            print(f"     screen tail: {tail[-300:]!r}")

def status_contains(text):
    """状态栏行含 text (剥色后最后 6 行里找)"""
    clean = ansi_re.sub(b'', buf).decode('utf-8', 'replace')
    for line in clean.splitlines()[-6:]:
        if text in line:
            return True
    return False

print('[启动] 临时 HOME:', TMP)
ok = read_until("Esc 双击退出", 90, 'placeholder')
check("CLI 启动, 输入框就绪", ok)
if not ok:
    print("FAIL: CLI 未启动")
    sys.exit(1)

# Case 4 前置: 无 active-channel.json → 默认第一个 (ResearchAgent)
time.sleep(1.5)
check("状态栏显示默认 agent (ResearchAgent)", status_contains("ResearchAgent"))

# Case 1: /channel <name>
send_cmd("/channel research")
ok = read_until("当前智能体: ResearchAgent", 20, 'case1')
check("Case1: /channel research → 确认行", ok)
time.sleep(0.5)
check("Case1: 状态栏 = ResearchAgent", status_contains("ResearchAgent"))

# Case 2: /channel <number>
send_cmd("/channel 2")
ok = read_until("当前智能体: TradeAgent", 20, 'case2')
check("Case2: /channel 2 → TradeAgent (索引解析)", ok)
time.sleep(0.5)
check("Case2: 状态栏 = TradeAgent", status_contains("TradeAgent"))
check("Case2: 状态栏含 ch 标识", status_contains("ch-trade") or status_contains("ch:"))

# Case 3: /channel <id>
send_cmd("/channel ch-research")
ok = read_until("当前智能体: ResearchAgent", 20, 'case3')
check("Case3: /channel ch-research → ResearchAgent (id 解析)", ok)

# 无参列表 — 不能用 read_until("❯ /channel") (消息行 "❯ /channel xxx" 会污染),
# 直接 sleep 等输入渲染后发 Enter
os.write(fd, b"/channel")
time.sleep(0.6)
os.write(fd, b"\r")
ok = read_until("智能体列表", 20, 'list')
check("Case3.5: /channel 无参 → 列表", ok)
ok = read_until("ResearchAgent", 5, 'list-name')
check("Case3.5: 列表含 ResearchAgent", ok)

# 退出 → 检查 active-channel.json
send("\x1b\x1b")  # 双击 Esc 退出
time.sleep(3)
try:
    with open(os.path.join(TMP, '.bolloon', 'active-channel.json')) as f:
        act = json.load(f)
    check("退出后 active-channel.json = ch-research", act.get('channelId') == 'ch-research', str(act))
except Exception as e:
    check("active-channel.json 已写入", False, str(e))

# Case 4: 重启 → 恢复 ch-research
try:
    os.kill(pid, 9)
except Exception:
    pass
try:
    os.close(fd)
except Exception:
    pass
time.sleep(1)
pid2, fd2 = pty.fork()
if pid2 == 0:
    os.chdir('/Users/apple/Downloads/bolloon')
    os.execve('/usr/bin/env', ['env', 'HOME=' + TMP, 'npx', 'tsx', 'src/index.ts'], ENV)
buf2 = b''
def read_until2(needle, timeout, label=''):
    global buf2
    n = needle.encode() if isinstance(needle, str) else needle
    deadline = time.time() + timeout
    while time.time() < deadline:
        r, _, _ = select.select([fd2], [], [], 0.15)
        if r:
            try:
                data = os.read(fd2, 65536)
            except OSError:
                return False
            if not data:
                return False
            buf2 += data
            if n in buf2:
                return True
    return False
ok = read_until2("Esc 双击退出", 90, 'restart')
check("Case4: 重启后输入框就绪", ok)
time.sleep(1.5)
clean2 = ansi_re.sub(b'', buf2).decode('utf-8', 'replace')
restored = any('ResearchAgent' in l for l in clean2.splitlines()[-6:])
check("Case4: 重启后状态栏恢复 ResearchAgent (上次 channel)", restored)
try:
    os.kill(pid2, 9)
    os.close(fd2)
except Exception:
    pass

# 调试: dump pty buf 里的 DBG 行 (setActive 是否被调)
import re as _re
for m in _re.finditer(rb'\[DBG-[A-Z]+\][^\n]*', buf):
    print('DBG:', m.group(0).decode('utf-8', 'replace').strip())

print(f"\n结果: {passed} 通过, {failed} 失败")
shutil.rmtree(TMP, ignore_errors=True)
sys.exit(0 if failed == 0 else 1)
