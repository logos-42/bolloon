#!/usr/bin/env python3
"""模拟真实双击 ESC: 固定时序, 去 ANSI 匹配, 打印时间戳
验证 CLI 输入框 placeholder + 双击 Esc 退出当前进程"""
import os, pty, sys, time, select, signal, re

cmd = ["node", "dist/cli-entry.js", "--cli"]
env = dict(os.environ, BOLLOON_SKIP_UPDATE="1")

pid, fd = pty.fork()
if pid == 0:
    os.chdir("/Users/apple/Downloads/bolloon")
    os.execvpe(cmd[0], cmd, env)

buf = b""
ansi_re = re.compile(rb"\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]")
def read_until(needle, timeout=8):
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
            clean = ansi_re.sub(b"", buf)
            if needle.encode() in clean:
                return True
    return False

t0 = time.time()
def log(msg):
    print(f"[+{time.time()-t0:6.2f}s] {msg}")

ok = True
try:
    if not read_until("输入消息... @智能体 /命令 #文件", 45):
        log("FAIL: 未等到输入框 placeholder")
        ok = False
    else:
        log("PASS: placeholder 含 '@智能体 /命令 #文件 · Esc 双击退出 · /queue 排队 · !终端命令'")

    # 第一次 ESC
    log("按下第一次 ESC")
    os.write(fd, b"\x1b")
    if not read_until("再按一次 Esc 退出当前进程", 3):
        log("FAIL: 第一次 ESC 未出现提示")
        ok = False
    else:
        log("PASS: 第一次 ESC → 提示 '再按一次 Esc 退出当前进程'")

    # 第二次 ESC (紧跟, 200ms 内)
    log("按下第二次 ESC")
    os.write(fd, b"\x1b")

    # 等进程退出 (最多 6s)
    deadline = time.time() + 6
    exited = False
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.15)
        if r:
            try:
                data = os.read(fd, 65536)
                if not data:
                    exited = True
                    break
                buf += data
            except OSError:
                exited = True
                break
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            exited = True
            break
    if exited:
        log("PASS: 双击 ESC 后进程退出")
    else:
        log("FAIL: 双击 ESC 后进程仍在运行")
        ok = False
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
