#!/usr/bin/env python3
"""CLI @ / # 弹出窗 pty 实测 (2026-08-05)

驱动 scripts/ink-popup-harness.tsx (真实 InkApp, 不启动 agent):
  1. 输入 @ → 弹出 '@ 智能体' 窗口, 命中本地+远端智能体
  2. 输入 智能体 → 过滤 (智能体小红/小米)
  3. Tab 选中 → 输入框出现 @智能体小红
  4. 逐键退格清空 (popup 重开也能删)
  5. 输入 / → 弹出 '/ 命令 · 技能 · 插件', 含 queue / 技能 / MCP 插件
  6. 输入 # → 弹出 '# 文件', 含项目文件 (src/...)
  7. Ctrl+C 退出

关键: 每一步都等 UI 反馈 ([INPUT]/[POPUP] 钩子) 再发下一个键 — 真实交互时序.
"""
import os, pty, sys, time, select, signal, re, fcntl, termios, struct

cmd = ["npx", "tsx", "scripts/ink-popup-harness.tsx"]
env = dict(os.environ, BOLLOON_SKIP_UPDATE="1")

pid, fd = pty.fork()
if pid == 0:
    os.chdir("/Users/apple/Downloads/bolloon")
    os.execvpe(cmd[0], cmd, env)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))

buf = b""
ansi_re = re.compile(rb"\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]")

def read_until(needle, timeout=10):
    """等屏幕输出包含 needle (去 ANSI)"""
    global buf
    deadline = time.time() + timeout
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            buf += data
            if needle.encode() in ansi_re.sub(b"", buf):
                return True
    return False

def wait_input(value, timeout=5):
    """等 [INPUT] "<value>" 钩子 — 只匹配本次调用之后出现的新数据 (防旧钩子误匹配)"""
    global buf, _search_from
    needle = '[INPUT] "%s"' % value
    deadline = time.time() + timeout
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            buf += data
            hit = buf.find(needle.encode(), _search_from)
            if hit >= 0:
                _search_from = hit + len(needle)
                return True
    return False

_search_from = 0

t0 = time.time()
def log(msg):
    print(f"[+{time.time()-t0:6.2f}s] {msg}")

ok = True
def check(cond, name):
    global ok
    log(("PASS: " if cond else "FAIL: ") + name)
    if not cond:
        ok = False

def send(ch):
    os.write(fd, ch.encode() if isinstance(ch, str) else ch)

try:
    # 0. 等 harness 起来
    if not read_until("输入消息... @智能体 /命令 #文件", 45):
        log("FAIL: harness 未启动 (placeholder 未出现)")
        ok = False
    else:
        log("PASS: harness 启动, placeholder 含 @智能体 /命令 #文件")

    if ok:
        # 1. 输入 @ → 弹出智能体窗口
        send("@")
        check(read_until("@ 智能体", 5), "@ 弹出 '@ 智能体' 窗口")

        # 2. 过滤: 输入 智能体
        send("智能体")
        check(wait_input("@智能体") and read_until("❯ 智能体小红", 3), "@智能体 命中 '智能体小红'")

        # 3. Tab 选中 → 输入框出现 @智能体小红
        send("\t")
        check(wait_input("@智能体小红 "), "Tab 选中 → 输入框 '@智能体小红 '")

        # 4. 退格清空: 先删空格让 popup 重开, 再 burst 全删 (真实连按场景)
        send(b"\x7f")
        step_ok = wait_input("@智能体小红", 3)
        send(b"\x7f" * 29)
        if not wait_input("", 5):
            step_ok = False
        check(step_ok, "退格清空 (弹出窗重开 + burst 连删)")
        time.sleep(0.3)

        # 5. 输入 / → 命令+技能+插件
        send("/")
        if wait_input("/") and read_until("/ 命令 · 技能 · 插件", 5):
            log("PASS: / 弹出 '/ 命令 · 技能 · 插件'")
        else:
            log("FAIL: / 未弹出命令窗口")
            ok = False
        check(read_until("queue", 3), "/ 窗口含内置命令 queue")
        check(read_until("技能", 3), "/ 窗口含技能候选")

        # 6. 清空 / 后输入 # → 文件
        send(b"\x7f")
        check(wait_input("", 3), "清空 /")
        time.sleep(0.3)
        send("#")
        if wait_input("#") and read_until("# 文件", 8):
            log("PASS: # 弹出 '# 文件' 窗口")
        else:
            log("FAIL: # 未弹出文件窗口 (屏幕尾部: " + ansi_re.sub(b"", buf).decode(errors="replace")[-300:] + ")")
            ok = False
        send("src/")
        # loadFiles 首次遍历 cwd 冷缓存可能 >5s, 放宽到 15s
        check(wait_input("#src/", 8) and read_until("src/agents/agent-identity.ts", 15), "#src/ 命中项目文件 (src/agents/... 可见首屏)")

        # 7. 历史输入: ↑/↓ 切换 (先清空 #src/)
        send(b"\x7f" * 5)
        step_ok = wait_input("", 3)
        send("hello")
        if wait_input("hello", 3): send("\r"); time.sleep(0.3)
        else: step_ok = False
        send("你好世界")
        if wait_input("你好世界", 3): send("\r"); time.sleep(0.3)
        else: step_ok = False
        send("\x1b[A")  # ↑ → 最近一条 你好世界
        if not wait_input("你好世界", 3): step_ok = False
        send("\x1b[A")  # ↑ → hello
        if not wait_input("hello", 3): step_ok = False
        send("\x1b[B")  # ↓ → 你好世界
        if not wait_input("你好世界", 3): step_ok = False
        send("\x1b[B")  # ↓ → 草稿
        if not wait_input("", 3): step_ok = False
        check(step_ok, "↑/↓ 切换历史输入 (最近→更早→草稿)")

        # 8. Tab 命令补齐
        send("que")
        if wait_input("que", 3):
            send("\t")
            check(wait_input("/queue ", 3), "Tab 补齐 que → /queue ")
        else:
            check(False, "输入 que 失败")
        send(b"\x7f" * 7)
        step_ok = wait_input("", 3)
        time.sleep(0.4)  # 等 burst 处理完 (避免 Tab 与退格 coalesce)
        send("\t")
        if not read_until("Tab 补齐", 3):
            step_ok = False
        check(step_ok, "空 token + Tab 弹出 'Tab 补齐' 窗")
        send("\x1b")  # Esc 关闭补齐窗
        time.sleep(0.3)

        # 9. Ctrl+C 退出
        send("\x03")
        deadline = time.time() + 5
        exited = False
        while time.time() < deadline:
            r, _, _ = select.select([fd], [], [], 0.15)
            if r:
                try:
                    data = os.read(fd, 65536)
                    if not data:
                        exited = True
                        break
                except OSError:
                    exited = True
                    break
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                exited = True
                break
        check(exited, "Ctrl+C 退出")
finally:
    try:
        os.kill(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        os.close(fd)
    except OSError:
        pass

sys.exit(0 if ok else 1)
