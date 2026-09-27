#!/usr/bin/env python3
"""
pty-drive.py — 真终端 (pty) 驱动: 按"等出现 → 再喂输入"的顺序跑一条命令, 抓**原始渲染**。
2026-09-27 (bolloon `bolloon model` 交互改造)

为什么不是 `printf ... | cmd`:
  · 管道不是终端 —— 被测代码里的 `process.stdin.isTTY` 是 false, 测不到"真终端才走的那条路";
  · 管道喂完就 EOF, 没法"等上一步渲染出来再答下一步"。
为什么不是"定时喂一串回车":
  · 定时是墙钟赌博: 机器一忙就喂早了/喂晚了, 测出来的是调度而不是被测行为。
  本脚本用 `expect` 正则**等渲染真的出现了**再喂 —— 等待本身就是对"这行印出来了"的断言。

用法:
  python3 scripts/lib/pty-drive.py --plan plan.json --out raw.txt --json result.json -- <cmd> [args...]

plan.json:
  {
    "timeout_s": 240,           # 整轮墙钟上限
    "settle_ms": 500,           # 最后一步答完后再收多久输出
    "cols": 100,                # 伪终端的列数 (可选; 不给就不设 winsize, 由被测方自己兜底)
    "rows": 30,                 # 伪终端的行数 (可选; 与 cols 一起设置才生效)
    "env": {"NO_COLOR": "1"},   # 追加/覆盖子进程环境变量 (值为 null = 删掉这个变量)
    "steps": [
      {"name": "第一屏", "expect": "步骤 1/7 供应商", "send": "deepseek\\n", "timeout_s": 60},
      {"name": "取消",   "expect": "已取消", "send": "<eof>", "timeout_s": 30}
    ]
  }
  · `send` 支持 `<eof>` (= Ctrl-D, 关掉 stdin), `<c-c>` (= SIGINT 字节 0x03), `<wait>` (只等不喂)。
    `send` 里的转义按 **Python 字符串** 解 (所以箭头键写成 `"\\x1b[B"`, 反斜杠 `\\n` = 回车)。
  · `expect` 是 Python 正则, 在**到目前为止的全部输出**上匹配 (pty 里有 ANSI/\\r, 匹配前会先去掉 ANSI 再归一化 \\r\\n)。
  · `expect_raw` (可选): 同样的正则, 但在**原始字节 (含 ANSI)** 上匹配 —— 用来断言"真有颜色/真有光标序列"
    这种东西; 去 ANSI 之后才匹配的话, 颜色是不是真存在就检不出来了。
  · `until` (可选): 断言"到这一步为止原始输出里某个正则**没有**命中" (例如明文 key 不许出现)。
    写法: `{"name": "...", "until_absent": "sk-PROBE-…"}`

输出:
  · `--out`: 子进程的**原始**输出 (含 ANSI/进度帧, 供人眼复核与报告引用)。
  · `--json`: 机器可读结论, 形如
      {"ok": true, "exit": 0, "killed": false, "steps": [{"name":..., "matched": true, "waited_ms": 1234, "sent": "deepseek\\n"}]}
    **`ok` 只取决于 expect/expect_raw/until_absent 是否都成立 + 子进程是否自然退出** —— 不掺别的判断。

退出码: 0 = ok; 1 = 有 expect 没等到 (或超时被强杀); 2 = 脚本自身参数/环境问题。
始终**持续 read** 主 fd (不读会让对端写满缓冲后卡住, 量到的是缓冲假象, 不是真渲染)。
"""

import argparse
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

ANSI = re.compile(r'\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]')


def strip_ansi(b: bytes) -> str:
    s = b.decode('utf-8', 'replace')
    s = ANSI.sub('', s)
    s = s.replace('\r\n', '\n').replace('\r', '\n')
    # 进度帧 (Braille/块状 spinner) 会碎片化同一行: 汇总时把连续空格压掉, 便于正则
    return s


# `send` 里的转义: 两种写法都收 (JSON 的 `\u001b` 交给 json 解; 人写的 `\x1b` 在这里解)。
# 只替换这几种已知转义, 其余字符 (含中文) 原样保留 —— 不用 unicode_escape 全量解码。
_ESCAPES = {'\\x1b': '\x1b', '\\u001b': '\x1b', '\\n': '\n', '\\r': '\r',
            '\\t': '\t', '\\\\': '\\', '\\x04': '\x04', '\\x03': '\x03'}
_HEXNN = re.compile(r'\\x([0-9a-fA-F]{2})')


def decode_send(s: str) -> str:
    out, i = [], 0
    while i < len(s):
        if s[i] == '\\':
            for ln in (6, 4, 2):
                key = s[i:i + ln]
                if key in _ESCAPES:
                    out.append(_ESCAPES[key])
                    i += ln
                    break
            else:
                # 通用 `\xNN`: 表里没列的控制字节 (Ctrl-U = `\x15` 等) 也必须真解成那个字节。
                # 不解的话会当**字面量**喂进去 —— 量到的是"用户打了 \ x 1 5", 不是 Ctrl-U,
                # 于是筛选/清空这类按键的断言会用假红或假绿收场。
                m = _HEXNN.match(s, i)
                if m:
                    out.append(chr(int(m.group(1), 16)))
                    i += 4
                else:
                    out.append(s[i])
                    i += 1
            continue
        out.append(s[i])
        i += 1
    return ''.join(out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--plan', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--json', required=True)
    ap.add_argument('--cwd', default=None)
    ap.add_argument('cmd', nargs=argparse.REMAINDER)
    a = ap.parse_args()

    cmd = a.cmd[1:] if a.cmd and a.cmd[0] == '--' else a.cmd
    if not cmd:
        print('pty-drive: 没给命令', file=sys.stderr)
        return 2

    plan = json.load(open(a.plan))
    total_budget = float(plan.get('timeout_s', 240))
    settle = float(plan.get('settle_ms', 500)) / 1000.0
    steps = plan.get('steps', [])

    master, slave = pty.openpty()
    # 伪终端尺寸: 不给就**不动** winsize (由被测方自己兜底 —— 免得把默认行为偷偷改掉);
    # 给了就必须真的设上, 否则"窄终端不撑破"验的还是别的尺寸。
    cols, rows = plan.get('cols'), plan.get('rows')
    if cols and rows:
        try:
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', int(rows), int(cols), 0, 0))
        except OSError as e:
            print(f'pty-drive: 设 winsize 失败: {e}', file=sys.stderr)
            return 2
    env = dict(os.environ)
    env['TERM'] = env.get('TERM', 'xterm-256color')
    for k, v in (plan.get('env') or {}).items():
        if v is None:
            env.pop(str(k), None)
        else:
            env[str(k)] = str(v)
    p = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave,
                         env=env, cwd=a.cwd, close_fds=True, start_new_session=True)
    os.close(slave)

    raw = bytearray()
    result = {'ok': True, 'exit': None, 'killed': False, 'cmd': cmd,
              'steps': [], 'timeout_s': total_budget}
    t0 = time.time()
    eof_sent = False

    def drain(deadline: float) -> None:
        """持续读, 直到 deadline (保证对端不会写阻塞)"""
        while time.time() < deadline:
            r, _, _ = select.select([master], [], [], 0.05)
            if not r:
                if p.poll() is not None:
                    break
                continue
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            raw.extend(chunk)

    for st in steps:
        pat = re.compile(st['expect']) if st.get('expect') else None
        raw_pat = re.compile(st['expect_raw']) if st.get('expect_raw') else None
        absent_raw = re.compile(st['until_absent']) if st.get('until_absent') else None
        step_t0 = time.time()
        limit = float(st.get('timeout_s', 60))

        def step_ok() -> bool:
            if pat and not pat.search(strip_ansi(bytes(raw))):
                return False
            if raw_pat and not raw_pat.search(bytes(raw).decode('utf-8', 'replace')):
                return False
            if absent_raw and absent_raw.search(bytes(raw).decode('utf-8', 'replace')):
                return False
            return True

        matched = (pat is None and raw_pat is None)
        while (pat is not None) or (raw_pat is not None):
            if time.time() - t0 > total_budget:
                break
            if time.time() - step_t0 > limit:
                break
            drain(min(time.time() + 0.15, step_t0 + limit))
            if step_ok():
                matched = True
                break
            if p.poll() is not None:
                drain(time.time() + 0.3)
                if step_ok():
                    matched = True
                break
        if absent_raw is not None:
            entry_absent = not absent_raw.search(bytes(raw).decode('utf-8', 'replace'))
            if not entry_absent:
                matched = False
        else:
            entry_absent = None
        entry = {'name': st.get('name', ''), 'expect': st.get('expect'),
                 'expect_raw': st.get('expect_raw'),
                 'until_absent': st.get('until_absent'),
                 'absent_ok': entry_absent,
                 'matched': bool(matched), 'waited_ms': int((time.time() - step_t0) * 1000)}
        send = st.get('send')
        if matched:
            if send == '<eof>':
                try:
                    os.write(master, b'\x04')
                except OSError:
                    pass
                eof_sent = True
            elif send == '<c-c>':
                try:
                    os.write(master, b'\x03')
                except OSError:
                    pass
            elif send == '<wait>':
                pass
            elif send is not None:
                try:
                    os.write(master, decode_send(send).encode())
                except OSError:
                    pass
            entry['sent'] = send
        else:
            result['ok'] = False
        result['steps'].append(entry)
        if not matched:
            break  # 这一步的期待没出现 → 后面的输入没有意义, 直接收尾

    # 收尾: 让进程**自然退出** (不 kill —— kill 会丢缓冲输出, 那是量不准的根因)
    if not eof_sent:
        try:
            os.write(master, b'\x04')
        except OSError:
            pass
    exit_deadline = time.time() + max(settle, 5.0)
    while p.poll() is None and time.time() < exit_deadline:
        drain(min(time.time() + 0.2, exit_deadline))
    if p.poll() is None:
        result['killed'] = True
        result['ok'] = False
        try:
            os.killpg(os.getpgid(p.pid), signal.SIGKILL)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass
    drain(time.time() + 0.5)
    try:
        while True:
            r, _, _ = select.select([master], [], [], 0.2)
            if not r:
                break
            d = os.read(master, 65536)
            if not d:
                break
            raw.extend(d)
    except OSError:
        pass
    try:
        os.close(master)
    except OSError:
        pass

    # 顺序: 先 wait 再读退出码 (killed 时 rc 会是负信号号, 如实记)
    try:
        rc = p.wait(timeout=10)
    except subprocess.TimeoutExpired:
        rc = None
    result['exit'] = rc
    result['elapsed_s'] = round(time.time() - t0, 2)

    with open(a.out, 'wb') as f:
        f.write(bytes(raw))
    with open(a.json, 'w') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    if result['killed']:
        result['ok'] = False
    print(json.dumps({k: result[k] for k in ('ok', 'exit', 'killed', 'elapsed_s')}, ensure_ascii=False))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
