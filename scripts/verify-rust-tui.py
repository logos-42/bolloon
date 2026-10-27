#!/usr/bin/env python3
"""verify-rust-tui.py — Rust CLI 底部 composer 的**真终端**验收门 (2026-10-27)

为什么必须真 pty:
  这次报障是"打一个字多一条横线"。函数级单测只能证明"我这一帧有 5 行", 证明不了
  "上一帧没留在屏上" —— 那是**终端里发生的事**。所以本门起真 pty (指定尺寸), 逐键喂
  UTF-8 字节, 把子进程吐的原始字节按 VT 语义**回放成屏幕**, 直接数"屏上有几条横线 /
  几个 ❯ / 输入有没有残影"。

为什么不能只看原始字节:
  `\\x1b[2K` 擦整行、`\\x1b[5H` 绝对定位、`\\r` 回车 —— 只按 `\\n` 切行数"超宽行"会
  凭空造假证据 (本仓踩过)。必须回放。

判据 (T1..T8), 每一条都对应任务书里的一句话:
  T1  空输入: 屏上只有**一个** `❯` 输入框 (分隔线也只有固定几条)
  T2  连续 100 次按键: 框数/横线数/输入行行号**恒定**, 屏上无历史输入残影
  T3  逐字回显: 每次按键后, 屏上正好一份最新输入 (旧的不会留在别的行)
  T4  退格 / 左右移动 / 多行: 不产生额外横线, 输入行行号不变
  T5  发送消息: 输入区清空, 历史区**只多一条**完整用户消息 (不重复打印)
  T6  流式输出期间: 底栏行号与横线数不变 (帧高恒定), 完成后输入框回到同一行
  T7  429 重试: 日志文件里有 `llm retry after backoff` + status=429;
      屏上**一个字符**的日志都没有 (`WARN` / `bolloon_llm` 不得出现在屏幕上)
  T8  退出: 收尾打印出来后进程正常结束, 光标显示序列 `\\x1b[?25h` 出现过

用法:
  python3 scripts/verify-rust-tui.py                 # 全跑
  python3 scripts/verify-rust-tui.py --only T2,T7    # 定点
  python3 scripts/verify-rust-tui.py --bin rust/target/debug/bolloon
退出码: 0 = 全绿; 1 = 有判据红; 2 = 脚本/环境自身问题。
"""
import argparse
import errno
import fcntl
import json
import os
import pty
import re
import select
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time

COLS, ROWS = 100, 30
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]")

# ─────────────────────────── VT 回放 (只实现本仓真用到的那些序列) ───────────────────────────
CSI = re.compile(rb"\x1b\[([0-9;?]*)([a-zA-Z])")


class Screen:
    """把原始字节回放成 `ROWS × COLS` 的字符网格。

    支持: CUP(`H`/`f`) · CUU/CUD/CUF/CUB(`A/B/C/D`) · EL(`K`) · ED(`J`) ·
    `\\r` `\\n` 换行滚动 · SGR(忽略) · 宽字符占 2 列。
    """

    def __init__(self, cols=COLS, rows=ROWS):
        self.w, self.h = cols, rows
        self.grid = [[" "] * cols for _ in range(rows)]
        self.r = self.c = 0
        self.scrolled = []      # 被顶出屏幕的行 (scrollback)
        self.max_row = 0

    def _scroll(self):
        self.scrolled.append("".join(self.grid[0]).rstrip())
        self.grid.pop(0)
        self.grid.append([" "] * self.w)

    def _newline(self):
        self.c = 0
        if self.r + 1 >= self.h:
            self._scroll()
        else:
            self.r += 1
        self.max_row = max(self.max_row, self.r)

    def _put(self, ch, width):
        if ch == "\r":
            self.c = 0
            return
        if ch == "\n":
            self._newline()
            return
        if ch == "\x07":
            return
        if self.c + width > self.w:
            self._newline()
        if self.r >= self.h:
            self._scroll()
        self.grid[self.r][self.c] = ch
        for k in range(1, width):
            self.grid[self.r][self.c + k] = ""   # 宽字符的第二列: 占位, 不写字
        self.c += width
        self.max_row = max(self.max_row, self.r)

    def _erase_line(self, mode):
        if mode in (0, ""):
            for i in range(self.c, self.w):
                self.grid[self.r][i] = " "
        elif mode == 2:
            self.grid[self.r] = [" "] * self.w

    def _erase_down(self, mode):
        if mode in (0, ""):
            self._erase_line(0)
            for rr in range(self.r + 1, self.h):
                self.grid[rr] = [" "] * self.w
        elif mode == 2:
            self.grid = [[" "] * self.w for _ in range(self.h)]

    def feed(self, data: bytes):
        i = 0
        n = len(data)
        while i < n:
            b = data[i]
            if b == 0x1B:
                m = CSI.match(data, i)
                if m:
                    raw, fin = m.group(1).decode(), m.group(2).decode()
                    body = raw.replace("?", "")
                    nums = [int(x) if x else 0 for x in body.split(";")] if body else []
                    k = nums[0] if nums else 0
                    if fin in ("H", "f"):
                        row = (nums[0] - 1) if len(nums) > 0 and nums[0] else 0
                        col = (nums[1] - 1) if len(nums) > 1 and nums[1] else 0
                        self.r = max(0, min(self.h - 1, row))
                        self.c = max(0, min(self.w - 1, col))
                        self.max_row = max(self.max_row, self.r)
                    elif fin == "A":
                        self.r = max(0, self.r - (k or 1))
                    elif fin == "B":
                        self.r = min(self.h - 1, self.r + (k or 1))
                    elif fin == "C":
                        self.c = min(self.w - 1, self.c + (k or 1))
                    elif fin == "D":
                        self.c = max(0, self.c - (k or 1))
                    elif fin == "K":
                        self._erase_line(k)
                    elif fin == "J":
                        self._erase_down(k)
                    i = m.end()
                    continue
                i += 1
                continue
            # UTF-8 单字符 (从 lead byte 定长解, 不按 4 字节硬切)
            ln = 1
            if b >= 0xF0:
                ln = 4
            elif b >= 0xE0:
                ln = 3
            elif b >= 0xC0:
                ln = 2
            try:
                ch = data[i:i + ln].decode("utf-8")
                ln = len(ch.encode("utf-8"))
                ch = ch[0] if ln > 0 else "?"
            except Exception:
                ch, ln = "?", 1
            self._put(ch, 2 if is_wide(ch) else 1)
            i += ln

    def resize(self, cols, rows):
        """真终端缩放: 网格换尺寸, 已有内容按左上角对齐保留 (不做 reflow)。
        这样"缩放后输入行还在底部吗"问的是**那一刻的画面**, 不会把历史字节按新宽度重放。"""
        new = [[" "] * cols for _ in range(rows)]
        for r in range(min(rows, self.h)):
            for c in range(min(cols, self.w)):
                new[r][c] = self.grid[r][c]
        self.grid = new
        self.w, self.h = cols, rows
        self.r = min(self.r, rows - 1)
        self.c = min(self.c, cols - 1)

    def lines(self):
        return ["".join(row).rstrip() for row in self.grid]

    def text(self):
        return "\n".join(self.lines())


def is_wide(ch: str) -> bool:
    c = ord(ch)
    if c < 0x1100:
        return False
    return (c <= 0x115F or c in (0x2329, 0x232A)
            or 0x2E80 <= c <= 0xA4CF or 0xAC00 <= c <= 0xD7A3
            or 0xF900 <= c <= 0xFAFF or 0xFE30 <= c <= 0xFE4F
            or 0xFF00 <= c <= 0xFF60 or 0xFFE0 <= c <= 0xFFE6
            or 0x1F000 <= c <= 0x1FAFF)


# ─────────────────────────── pty 驱动 ───────────────────────────
class Term:
    def __init__(self, argv, env, cols=COLS, rows=ROWS):
        self.buf = bytearray()
        self.master, slave = pty.openpty()
        # 尺寸必须在 fork 之前设好 (事后设 winsize 会让子进程读到 rows=0)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        full_env = dict(os.environ)
        full_env.update({"TERM": "xterm-256color", "COLUMNS": str(cols), "LINES": str(rows)})
        full_env.update(env)
        self.proc = subprocess.Popen(
            argv, stdin=slave, stdout=slave, stderr=slave,
            env=full_env, close_fds=True, preexec_fn=os.setsid,
        )
        os.close(slave)
        self.cols, self.rows = cols, rows
        # **增量回放**: 只把新到的字节喂进同一个 Screen。
        # 每次都要"从零重放全部字节"的话, 缩放后的宽度会作用到缩放**之前**那些帧上
        # (100 列的面板按 72 列重放 ⇒ 折行 ⇒ 整屏错位), 量到的是夹具的错而不是产品的。
        self._scr = Screen(cols, rows)
        self._fed = 0

    def pump(self, secs):
        end = time.time() + secs
        while time.time() < end:
            try:
                r, _, _ = select.select([self.master], [], [], 0.05)
            except (OSError, ValueError):
                return
            if not r:
                continue
            try:
                d = os.read(self.master, 65536)
            except OSError as e:
                if e.errno in (errno.EIO, errno.EBADF):
                    return
                raise
            if not d:
                return
            self.buf.extend(d)

    def send(self, s: str, settle=0.12):
        os.write(self.master, s.encode("utf-8"))
        self.pump(settle)

    def resize(self, cols, rows):
        self.screen()                    # 先把**缩放前**的字节按旧尺寸回放完
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.killpg(os.getpgid(self.proc.pid), 28)  # SIGWINCH
        self.cols, self.rows = cols, rows
        self._scr.resize(cols, rows)      # 网格换尺寸 (内容按左上角保留)
        self.pump(0.6)
        self.screen()

    def screen(self):
        """当前画面 (增量回放; 同一个 Term 上反复调用是安全的)"""
        if self._fed < len(self.buf):
            self._scr.feed(bytes(self.buf[self._fed:]))
            self._fed = len(self.buf)
        return self._scr

    def wait_for(self, pred, timeout=15.0, what="画面"):
        """等"画面上真出现了"再断言 —— 固定 sleep 会在冷启动慢的那次上给出假红"""
        end = time.time() + timeout
        while time.time() < end:
            if pred(self.screen()):
                return True
            self.pump(0.15)
        return False

    def close(self, timeout=4.0, key=b"\x03"):
        """收尾: 默认发一次 Ctrl+C —— 空闲时一次就该退出 (raw 模式下 Ctrl+D 只是字节)"""
        try:
            os.write(self.master, key)
        except OSError:
            pass
        end = time.time() + timeout
        while time.time() < end and self.proc.poll() is None:
            self.pump(0.1)
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        code = self.proc.poll()
        try:
            os.close(self.master)
        except OSError:
            pass
        return code


# ─────────────────────────── 桩 LLM (429 → 429 → 200 SSE) ───────────────────────────
class StubLlm:
    """按请求次数返回: 第 1 次 429, 第 2 次 429, 第 3 次 200 + SSE 流。

    这样一次会话就把"429 退避重试 + 日志落盘 + 界面不被污染"三件事一起验到。
    """

    def __init__(self):
        self.hits = 0
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.port = self.sock.getsockname()[1]
        self.stop = False
        self.t = threading.Thread(target=self._serve, daemon=True)
        self.t.start()

    def _serve(self):
        while not self.stop:
            try:
                self.sock.settimeout(0.3)
                conn, _ = self.sock.accept()
            except (socket.timeout, OSError):
                continue
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn):
        try:
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = conn.recv(65536)
                if not chunk:
                    return
                data += chunk
            # 读完 body (按 Content-Length)
            head, _, body = data.partition(b"\r\n\r\n")
            clen = 0
            for line in head.split(b"\r\n")[1:]:
                if line.lower().startswith(b"content-length:"):
                    clen = int(line.split(b":")[1].strip())
            while len(body) < clen:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                body += chunk

            self.hits += 1
            if self.hits <= 2:
                payload = b'{"error":{"message":"rate limited","type":"rate_limit"}}'
                conn.sendall(
                    b"HTTP/1.1 429 Too Many Requests\r\n"
                    b"Content-Type: application/json\r\n"
                    b"Content-Length: " + str(len(payload)).encode() + b"\r\n"
                    b"Retry-After: 0\r\n\r\n" + payload
                )
                return
            # 第 3 次: 正常 SSE 流
            conn.sendall(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n"
                b"Cache-Control: no-cache\r\nConnection: close\r\n\r\n"
            )
            for piece in ["你好", "，", "我是桩模型。"]:
                ev = json.dumps({
                    "choices": [{"delta": {"content": piece}, "index": 0}],
                }, ensure_ascii=False)
                conn.sendall(b"data: " + ev.encode() + b"\n\n")
                time.sleep(0.08)
            done = json.dumps({
                "choices": [{"delta": {}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 30, "completion_tokens": 8, "total_tokens": 38},
            })
            conn.sendall(b"data: " + done.encode() + b"\n\ndata: [DONE]\n\n")
        except OSError:
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def close(self):
        self.stop = True
        try:
            self.sock.close()
        except OSError:
            pass


# ─────────────────────────── 判据 ───────────────────────────
class Result:
    def __init__(self):
        self.rows = []

    def check(self, name, ok, detail=""):
        self.rows.append({"name": name, "ok": bool(ok), "detail": detail})
        print(f"  {'✅' if ok else '❌'} {name}" + (f" — {detail}" if detail else ""))

    def failed(self):
        return [r for r in self.rows if not r["ok"]]


def count_input_rows(scr: Screen) -> int:
    """屏上 `❯` 开头的非空输入行数 (老 bug 会让它一路涨)"""
    return sum(1 for l in scr.lines() if l.lstrip().startswith("❯"))


def rule_rows(scr: Screen):
    """屏上"整行基本是横线"的行号"""
    out = []
    for i, l in enumerate(scr.lines()):
        t = l.strip()
        if len(t) >= 20 and set(t) <= {"─"}:
            out.append(i)
    return out


def status_line_rows(scr: Screen):
    """以 `──` 起头、且中间有文字的运行状态行 (Hermes 那种 `── Working… ────`)"""
    out = []
    for i, l in enumerate(scr.lines()):
        t = l.strip()
        if t.startswith("──") and any(ch not in "─ " for ch in t):
            out.append(i)
    return out


def input_row_rows(scr: Screen):
    return [i for i, l in enumerate(scr.lines()) if l.lstrip().startswith("❯")]


def booted(scr: Screen) -> bool:
    return bool(input_row_rows(scr)) and bool(rule_rows(scr)) and bool(status_line_rows(scr))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", default="rust/target/debug/bolloon")
    ap.add_argument("--only", default="")
    ap.add_argument("--keep-home", action="store_true")
    args = ap.parse_args()

    only = {s.strip().upper() for s in args.only.split(",") if s.strip()}
    want = lambda t: (not only) or (t in only)

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    bin_path = args.bin if os.path.isabs(args.bin) else os.path.join(root, args.bin)
    if not os.path.exists(bin_path):
        print(f"找不到被测二进制: {bin_path} (先 cargo build -p bolloon-cli)")
        return 2

    home = tempfile.mkdtemp(prefix="bolloon-tui-verify-")
    stub = StubLlm()
    env = {
        "BOLLOON_HOME": home,
        "BOLLOON_BASE_URL": f"http://127.0.0.1:{stub.port}/v1",
        "BOLLOON_API_KEY": "probe-not-a-real-key",
        "BOLLOON_MODEL": "stub-model",
        "NO_COLOR": "",
        "EDITOR": "true",
        "VISUAL": "true",
    }
    R = Result()
    t = None
    try:
        t = Term([bin_path, "chat"], env)
        got_boot = t.wait_for(booted, timeout=25.0)

        # ── T1 空输入: 只有一个输入框 ─────────────────────────
        if want("T1"):
            R.check("T1.0 首帧出现在 25s 内", got_boot,
                    "等到的是空屏 (冷启动慢/崩了?)")
            scr = t.screen()
            n_in = count_input_rows(scr)
            R.check("T1.1 空输入只有一个输入框", n_in == 1, f"❯ 行数={n_in}")
            first_rules = rule_rows(scr)
            R.check(
                "T1.2 分隔线只有一条 (输入行与模型行之间)",
                len(first_rules) == 1,
                f"纯横线行号={first_rules}",
            )
            sl = status_line_rows(scr)
            R.check("T1.3 运行状态行带起头线且只有一行", len(sl) == 1, f"行号={sl}")
            ins = input_row_rows(scr)
            R.check(
                "T1.4 底部区域完整且在屏幕内 (模型/指标行都还在)",
                bool(ins) and ins[0] + 3 <= ROWS,
                f"输入行={ins} (共 {ROWS} 行)",
            )

        # ── T2 连续 100 次按键 ───────────────────────────────
        if want("T2"):
            base = t.screen()
            base_rules = rule_rows(base)
            base_input_rows = input_row_rows(base)
            worst_rules, worst_inputs, drift = len(base_rules), count_input_rows(base), 0
            bad = ""
            text = ""
            for i in range(100):
                ch = "你可以看到 Rust 项目的 CLI 吗"[i % 15]
                text += ch
                t.send(ch, settle=0.03)
                if (i + 1) % 5 == 0:
                    s = t.screen()
                    rules = rule_rows(s)
                    ins = [j for j, l in enumerate(s.lines()) if l.lstrip().startswith("❯")]
                    if len(rules) > worst_rules:
                        worst_rules, bad = len(rules), f"第 {i+1} 键后横线涨到 {len(rules)} (行号 {rules})"
                    if len(ins) > worst_inputs:
                        worst_inputs, bad = len(ins), f"第 {i+1} 键后输入框涨到 {len(ins)} 个"
                    if ins != base_input_rows:
                        drift += 1
            s = t.screen()
            R.check("T2.1 100 键后横线条数不变", worst_rules <= len(base_rules),
                    bad or f"恒定 {worst_rules} 条")
            R.check("T2.2 100 键后输入框只有一个", worst_inputs == 1,
                    bad or "恒定 1 个")
            R.check("T2.3 输入行行号不漂移", drift == 0,
                    f"漂移帧数={drift}")
            # 残影判据: 输入行**以外**不许再出现刚打的字
            ins_rows = set(input_row_rows(s))
            other = "\n".join(l for i, l in enumerate(s.lines()) if i not in ins_rows)
            ghosts = other.count("可以看到 Rust")
            R.check("T2.4 输入行以外没有旧输入残影", ghosts == 0,
                    f"非输入行里命中 {ghosts} 次")
            R.check("T2.5 输入内容就是刚打的那些字",
                    text[:6] in s.text().replace("\n", ""),
                    f"期望包含 {text[:6]!r}")

        # ── T3 退格 / 左右 / 多行 ────────────────────────────
        if want("T3"):
            before = rule_rows(t.screen())
            for _ in range(6):
                t.send("\x7f", settle=0.05)     # Backspace
            after_bs = rule_rows(t.screen())
            R.check("T3.1 退格不增加横线", after_bs == before or len(after_bs) <= len(before),
                    f"{len(before)} → {len(after_bs)}")
            t.send("\x1b[D\x1b[D", settle=0.15)  # ← ←
            t.send("\x1b[D", settle=0.05)
            for _ in range(3):
                t.send("\x7f", settle=0.05)     # 在中间退格
            s = t.screen()
            R.check("T3.2 左右移动 + 中间退格不增加横线",
                    len(rule_rows(s)) == len(before), f"{len(rule_rows(s))} vs {len(before)}")
            t.send("\n", settle=0.25)           # Ctrl+J = 换行
            t.send("第二行", settle=0.25)
            s = t.screen()
            R.check("T3.3 多行输入仍是同一块底栏 (横线数不变)",
                    len(rule_rows(s)) == len(before), f"{len(rule_rows(s))} vs {len(before)}")
            R.check("T3.4 多行时如实标注上面还有几行",
                    "…1行" in s.text(), f"屏上找不到折叠标记: {s.lines()[input_row_rows(s)[0]] if input_row_rows(s) else '?'}")
            # 清理: 全选回来重打 (Ctrl+U 删到行首 x2 + 退格)
            t.send("\x15" * 4, settle=0.2)
            for _ in range(40):
                t.send("\x7f", settle=0.01)

        # ── T4 缩放 ─────────────────────────────────────────
        if want("T4"):
            t.send("测试缩放", settle=0.2)
            t.resize(72, 24)
            s = t.screen()
            ins = input_row_rows(s)
            R.check("T4.1 缩放后仍只有一个输入框", len(ins) == 1, f"{len(ins)} 个 (行号 {ins})")
            R.check("T4.2 缩放后底栏仍完整 (模型/指标行在屏幕内)",
                    bool(ins) and ins[0] + 3 <= 24, f"输入行={ins} (共 24 行)")
            widths = [len(l) for l in s.lines() if l.strip()]
            R.check("T4.3 缩放后没有行超过新宽度", max(widths or [0]) <= 72,
                    f"最宽行={max(widths or [0])}")
            t.resize(COLS, ROWS)
            for _ in range(10):
                t.send("\x7f", settle=0.02)

        # ── T5 发送消息: 输入清空 + 只加一条用户消息 ──────────
        if want("T5"):
            for _ in range(60):
                t.send("\x7f", settle=0.01)
            t.send("你好，给我一句话", settle=0.2)
            before_send = t.screen().text()
            t.send("\r", settle=1.5)
            t.pump(4.0)
            s = t.screen()
            R.check("T5.1 发送后输入区清空 (回到引导文案)",
                    "输入消息" in s.text(), s.lines()[input_row_rows(s)[0]] if input_row_rows(s) else "没有输入行")
            joined = s.text()
            # 只数**消息区** (底栏 5 行不算: 会话标题本来就取自首条用户消息, 会合法地重复)
            ins0 = input_row_rows(s)
            cut = (ins0[0] - 1) if ins0 else ROWS - 5
            history_text = "\n".join(s.lines()[:max(cut, 0)])
            n_user = history_text.count("你好，给我一句话")
            appears = [l for l in s.lines() if "你好，给我一句话" in l]
            R.check("T5.2 消息区里用户消息只出现一次", n_user == 1,
                    f"消息区命中 {n_user} 次; 含该串的行={len(appears)}")
            R.check("T5.3 助手回复进了历史区", "桩模型" in joined,
                    "屏上没看到回复正文; 画面=" + " | ".join(l for l in s.lines() if l.strip())[-300:])
            R.check("T5.4 发送后底部固定区形状不变 (1 分隔线 + 1 状态行)",
                    len(rule_rows(s)) == 1 and len(status_line_rows(s)) == 1,
                    f"分隔线={len(rule_rows(s))} 状态行={len(status_line_rows(s))}")

        # ── T6 流式期间底栏稳定 + 429 重试 ───────────────────
        if want("T6"):
            s = t.screen()
            ins = [i for i, l in enumerate(s.lines()) if l.lstrip().startswith("❯")]
            R.check("T6.1 流式结束后底栏完整可见", len(ins) == 1 and ins[0] + 3 <= ROWS,
                    f"输入行={ins}")
            R.check("T6.2 流式结束后只有一个输入框", len(ins) == 1, f"{len(ins)} 个")

        if want("T7"):
            log_path = os.path.join(home, "rust", "logs", "bolloon.log")
            log = ""
            if os.path.exists(log_path):
                log = open(log_path, encoding="utf-8", errors="replace").read()
            retry_lines = [l for l in log.splitlines() if "llm retry" in l]
            R.check("T7.1 429 重试被记进日志文件 (含 status/backoff/时间戳)",
                    any("status=429" in l and "backoff_ms=" in l for l in retry_lines),
                    f"命中 {len(retry_lines)} 行: {retry_lines[:2] if retry_lines else '无'}")
            R.check("T7.2 桩服务真收到了 429 重试 (>2 次请求)", stub.hits >= 3,
                    f"请求数={stub.hits}")
            scr = t.screen()
            screen_text = scr.text() + "\n" + "\n".join(scr.scrolled)
            # ① 不许出现 tracing 原始格式 (时间戳 + 级别 + `模块:` 的行)
            raw_fmt = re.findall(
                r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\S*\s+(?:INFO|WARN|ERROR|DEBUG)\s",
                screen_text,
            )
            # ② 若界面里确实展示了日志, 必须是**渲染成事件**的形态 (⚠/✗ + 模块), 不是原样倾倒
            rendered = [l for l in scr.lines() if l.strip().startswith(("⚠", "✗"))]
            R.check("T7.3 屏上没有原始 tracing 格式的日志行", not raw_fmt,
                    f"命中 {len(raw_fmt)} 行: {raw_fmt[:2]}")
            R.check("T7.4 界面里的告警只能以事件形态出现 (⚠/✗ 起头)",
                    all("bolloon_llm" not in l for l in scr.lines()
                        if l.strip() and not l.strip().startswith(("⚠", "✗"))),
                    f"渲染成事件的日志行 {len(rendered)} 条")

        # ── T8 退出: 空闲时**一次** Ctrl+C ───────────────────
        if want("T8"):
            for _ in range(20):
                t.send("\x7f", settle=0.02)
            pre_exit = bytes(t.buf)
            code = t.close()   # 发一次 Ctrl+C
            all_bytes = pre_exit + bytes(t.buf)
            R.check("T8.1 进程正常退出", code == 0, f"exit={code}")
            R.check("T8.2 退出时恢复了光标显示", b"\x1b[?25h" in all_bytes,
                    "没找到 ESC[?25h")
            scr = Screen(COLS, ROWS)
            scr.feed(all_bytes)
            R.check("T8.3 屏上留下会话已保存的收尾行",
                    "已退出会话" in scr.text(), scr.text().splitlines()[-3:])
            t = None

        # ── T9 非交互 / 重定向: 输出行为不变 ─────────────────
        if want("T9"):
            home2 = tempfile.mkdtemp(prefix="bolloon-tui-pipe-")
            env2 = dict(env)
            env2["BOLLOON_HOME"] = home2
            p = subprocess.run(
                [bin_path, "chat"], input="你好\n".encode(),
                env={**os.environ, **env2}, capture_output=True, timeout=120,
            )
            out = p.stdout.decode("utf-8", "replace")
            err = p.stderr.decode("utf-8", "replace")
            R.check("T9.1 非交互模式正常退出", p.returncode == 0, f"exit={p.returncode}")
            R.check("T9.2 非 TTY 的 stdout 里没有 ANSI 光标控制",
                    "\x1b[" not in out, f"stdout 里出现 {out.count(chr(27))} 个 ESC")
            R.check("T9.3 非交互也把用户消息回显成了普通文本",
                    "你好" in out, out[-200:])
            # 非交互时的日志**不许混进 stdout** (该进 stderr / 日志文件)
            leaked = [l for l in out.splitlines()
                      if re.match(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d.*\b(INFO|WARN|ERROR)\b", l)]
            R.check("T9.4 stdout 里没有日志行 (日志走 stderr/文件)", not leaked,
                    f"命中 {len(leaked)} 行: {leaked[:2]}; stderr 头={err[:100]!r}")
            shutil.rmtree(home2, ignore_errors=True)

        # ── 汇总 ────────────────────────────────────────────
        bad = R.failed()
        print()
        print(f"结果: {len(R.rows) - len(bad)}/{len(R.rows)} 通过")
        if bad:
            print("红的判据:")
            for r in bad:
                print(f"  · {r['name']} — {r['detail']}")
            print(f"\n原始字节已留在 {home} (--keep-home 可保留)")
            return 1
        return 0
    finally:
        if t is not None:
            try:
                t.close()
            except Exception:
                pass
        stub.close()
        if not args.keep_home:
            shutil.rmtree(home, ignore_errors=True)
        else:
            print(f"HOME 保留在 {home}")


if __name__ == "__main__":
    sys.exit(main())
