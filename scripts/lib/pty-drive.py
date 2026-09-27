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
    "steps": [
      {"name": "第一屏", "expect": "步骤 1/7 供应商", "send": "deepseek\\n", "timeout_s": 60},
      {"name": "取消",   "expect": "已取消", "send": "<eof>", "timeout_s": 30}
    ]
  }
  · `send` 支持 `<eof>` (= Ctrl-D, 关掉 stdin), `<c-c>` (= SIGINT 字节 0x03), `<wait>` (只等不喂)。
  · `expect` 是 Python 正则, 在**到目前为止的全部输出**上匹配 (pty 里有 ANSI/\\r, 匹配前会先去掉 ANSI 再归一化 \\r\\n)。

输出:
  · `--out`: 子进程的**原始**输出 (含 ANSI/进度帧, 供人眼复核与报告引用)。
  · `--json`: 机器可读结论, 形如
      {"ok": true, "exit": 0, "killed": false, "steps": [{"name":..., "matched": true, "waited_ms": 1234, "sent": "deepseek\\n"}]}
    **`ok` 只取决于 expect 是否都命中 + 子进程是否自然退出** —— 不掺别的判断。

退出码: 0 = ok; 1 = 有 expect 没等到 (或超时被强杀); 2 = 脚本自身参数/环境问题。
始终**持续 read** 主 fd (不读会让对端写满缓冲后卡住, 量到的是缓冲假象, 不是真渲染)。
"""

import argparse
import json
import os
import pty
import re
import select
import signal
import subprocess
import sys
import time

ANSI = re.compile(r'\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]')


def strip_ansi(b: bytes) -> str:
    s = b.decode('utf-8', 'replace')
    s = ANSI.sub('', s)
    s = s.replace('\r\n', '\n').replace('\r', '\n')
    # 进度帧 (Braille/块状 spinner) 会碎片化同一行: 汇总时把连续空格压掉, 便于正则
    return s


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
    env = dict(os.environ)
    env['TERM'] = env.get('TERM', 'xterm-256color')
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
        step_t0 = time.time()
        limit = float(st.get('timeout_s', 60))
        matched = pat is None
        while pat is not None:
            if time.time() - t0 > total_budget:
                break
            if time.time() - step_t0 > limit:
                break
            drain(min(time.time() + 0.15, step_t0 + limit))
            if pat.search(strip_ansi(bytes(raw))):
                matched = True
                break
            if p.poll() is not None:
                drain(time.time() + 0.3)
                if pat.search(strip_ansi(bytes(raw))):
                    matched = True
                break
        entry = {'name': st.get('name', ''), 'expect': st.get('expect'),
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
                    os.write(master, send.encode())
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
