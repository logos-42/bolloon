#!/usr/bin/env python3
"""pty-run.py — 真 pty 驱动 (验收门用): 可控尺寸 + 定时按键注入 + 原始字节落盘。

为什么不用 `/usr/bin/script`: 它把当前终端的尺寸带进子进程, 而验收要**指定**尺寸
(60 列窄屏 / 24 与 50 行), 还要在打字过程中逐键注入 —— 只有真 pty (TIOCSWINSZ + 写 master fd)
才能做到这两件事。macOS 自带 python3, 不引入新依赖。

用法:
  python3 scripts/pty-run.py --rows 24 --cols 60 --secs 8 \\
      --out /tmp/panel.bin --keys-file /tmp/keys.json \\
      --env HOME=/tmp/h --env BOLLOON_SKIP_SETUP=1 --cwd <repo> -- node dist/cli-entry.js --cli

keys.json: [{"at": 4.0, "keys": "n"}, {"at": 4.3, "keys": "\\u6d4b"}, {"at": 6, "resize": [24, 80]},
            {"at": 1.0, "wait_for": "输入消息", "keys": "n"}]
  · `keys` 里的 `\\uXXXX` 转义按 UTF-8 落盘 (中文可打)
  · `resize` 触发 SIGWINCH (验动态尺寸)
  · `wait_for` = 正则; 命中前**不喂**这个事件 (等"画面上真出现了"再打字, 不赌启动速度)。
    `at` 仍是下限。等不到就一直等到 `--secs` 上限 —— 脚本侧断言会红, 不静默放行。
    ⚠ 标记必须**在字节里连续**: Ink 会给占位文案首字插反白光标码, 跨码串 (如 `输入消息`) 匹配不到。
  · `after` = 相对"上一个事件真喂出去"那一刻的间隔 (秒) —— 配合 `wait_for` 用:
    第一个按键等画面就绪, 后面几个按键按固定间隔一个接一个 (不会在就绪那一刻挤成一堆)。
  · 每个事件的 mark 里带 `bytes`/`frames` = 喂进去那一刻**已收到多少字节/多少帧**
    (验收脚本按它切"打字之后"的帧 —— 按字节切会踩 UTF-8 多字节 vs JS string 长度的坑)

输出 (stdout, 一行 JSON): {"bytes": N, "frames": N, "exit": E|null, "pre_bytes": N,
                          "lines_before_first_frame": N, "out": path, "watchdog": bool}
退出码: 0 = 跑完 (子进程死没死都算跑完, 状态在 JSON 里)。

纪律: 这个驱动**不许挂死** —— 收尾用有上界的 WNOHANG 轮询, 另有 SIGALRM 看门狗兜底
(踩过: 阻塞版 `waitpid` 把验收门拖到 90s 超时)。
"""

import os, pty, sys, time, select, signal, fcntl, termios, struct, re, json, argparse

STATE = {'chunks': [], 'out': None, 'status': None, 'pid': None, 'watchdog': False}


def _reap(pid: int, timeout: float = 2.0):
    """有上界的收尸 (WNOHANG 轮询)。不用阻塞的 waitpid: 万一子进程卡在某个不响 SIGKILL 的
    状态 (pty 前后台进程组信号), 阻塞版会把验收门一起拖死。"""
    end = time.time() + timeout
    while time.time() < end:
        try:
            wp, st = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return None
        if wp:
            return st
        time.sleep(0.05)
    return None


def _finish_and_exit(code: int = 0) -> None:
    """落盘 + 汇报 + 退出。正常路径与看门狗路径共用 (所以只依赖 STATE)。"""
    raw = b''.join(STATE['chunks'])
    out = STATE['out']
    try:
        with open(out, 'wb') as f:
            f.write(raw)
        text = raw.decode('utf-8', 'replace')
        first = text.find('\x1b[?2026h')
        pre = text[:first] if first >= 0 else text
        pre_clean = re.sub(r'\x1b\[[0-9;?]*[ -/]*[@-~]', '', pre).replace('\x1b', '')
        print(json.dumps({
            'bytes': len(raw),
            'frames': text.count('\x1b[?2026h'),
            'status': STATE['status'],
            'exit': os.waitstatus_to_exitcode(STATE['status']) if STATE['status'] is not None else None,
            'pre_bytes': len(pre),
            'lines_before_first_frame': len([l for l in pre_clean.split('\n') if l.strip()]),
            'out': out,
            'watchdog': STATE['watchdog'],
        }, ensure_ascii=False), flush=True)
    except Exception as e:                        # 落盘/解析失败也得给个话
        print(json.dumps({'error': str(e), 'watchdog': STATE['watchdog']}, ensure_ascii=False), flush=True)
        os._exit(2)
    os._exit(code)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--rows', type=int, default=24)
    ap.add_argument('--cols', type=int, default=100)
    ap.add_argument('--secs', type=float, default=8.0)
    ap.add_argument('--out', required=True)
    ap.add_argument('--keys-file', default=None)
    ap.add_argument('--env', action='append', default=[])
    ap.add_argument('--cwd', default=None)
    ap.add_argument('cmd', nargs='+')
    a = ap.parse_args()
    STATE['out'] = a.out

    # 看门狗: 无论卡在哪一步, secs+15 秒必须落盘退出
    def _watchdog(_sig, _frm):
        STATE['watchdog'] = True
        _finish_and_exit(0)
    signal.signal(signal.SIGALRM, _watchdog)
    try:
        signal.alarm(int(a.secs) + 15)
    except Exception:
        pass

    env = {}
    for kv in a.env:
        k, _, v = kv.partition('=')
        env[k] = v
    events = []
    if a.keys_file:
        with open(a.keys_file, 'r', encoding='utf-8') as f:
            events = sorted(json.load(f), key=lambda e: e.get('at', 0))
    marks = []

    # 自己开 pty 再 fork —— **先把尺寸设好**再让子进程出生。
    # (用 `pty.fork()` 时尺寸只能在 fork 之后设, 子进程有机会在 rows=0 时读到终端尺寸:
    #  现象是偶发"什么都没画就退出/只剩回显", 实测三次里有一次 —— 验收门不能建在这种竞态上。)
    master, slave = os.openpty()
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', a.rows, a.cols, 0, 0))
    pid = os.fork()
    if pid == 0:
        try:
            os.close(master)
            os.setsid()
            try:
                fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            except OSError:
                pass
            os.dup2(slave, 0)
            os.dup2(slave, 1)
            os.dup2(slave, 2)
            if slave > 2:
                os.close(slave)
            os.environ.update(env)
            if a.cwd:
                try:
                    os.chdir(a.cwd)
                except OSError:
                    pass
            os.execvp(a.cmd[0], a.cmd)
        finally:
            os._exit(127)
    os.close(slave)
    fd = master
    STATE['pid'] = pid
    # 尺寸再确认一次 (幂等; 有些实现会拿首次 ioctl 的值做缓存)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', a.rows, a.cols, 0, 0))

    t0, ei, status = time.time(), 0, None
    last_fire = t0
    while time.time() - t0 < a.secs:
        now = time.time() - t0
        while ei < len(events) and events[ei].get('at', 0) <= now:
            e = events[ei]
            # `wait_for` (2026-09-27): 等**画面上出现**某个标记再喂输入, 不用固定秒数赌启动速度。
            #   踩过: 固定 at=5.0s 打字, 机器忙时面板还没挂上 → 按键进了行缓冲 (屏幕上只剩回显 /c),
            #   于是"命令没执行"被误读成"功能坏了"。等不到就一直等 (到 --secs 上限为止),
            #   事件不消费 —— 断言在验收脚本那侧照旧会红, 不会静默放行。
            #   注意: 标记必须是**字节里连续**的一段 —— Ink/ink-text-input 会在占位文案的首字
            #   插反白光标码 (`\x1b[7m输\x1b[27m\x1b[90m入消息`), 所以 `输入消息` 这种跨码串匹配不到。
            wf = e.get('wait_for')
            if wf:
                text = b''.join(STATE['chunks']).decode('utf-8', 'replace')
                # 「画面上现在是」= **最后一帧**之后那一段: 旧帧的字节还在缓冲区里,
                #   按全量匹配会把"已经消失的行"算成"还在屏上" (踩过: 加载中那行明明已经换掉).
                screen = text.rsplit('\x1b[?2026h', 1)[-1]
                if not re.search(wf, screen):
                    break
            # `after`: 相对**上一个事件真喂出去**那一刻的间隔 (秒) —— 第一个事件等画面就绪之后,
            #   后面几个按键照样一个接一个 (用绝对 `at` 会在就绪那一刻挤成一堆同时打进去)。
            if e.get('after') is not None and time.time() < last_fire + float(e['after']):
                break
            ei += 1
            last_fire = time.time()
            nbytes = sum(len(c) for c in STATE['chunks'])
            nframes = sum(c.count(b'\x1b[?2026h') for c in STATE['chunks'])
            if e.get('keys'):
                payload = e['keys'].encode('utf-8').decode('unicode_escape').encode('utf-8')
                try:
                    os.write(fd, payload)
                except OSError:
                    pass
                marks.append({'kind': 'keys', 'at': round(now, 3), 'data': e['keys'], 'bytes': nbytes, 'frames': nframes})
            if e.get('resize'):
                r, c = e['resize']
                fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
                try:
                    os.kill(pid, signal.SIGWINCH)
                except ProcessLookupError:
                    pass
                marks.append({'kind': 'resize', 'at': round(now, 3), 'rows': r, 'cols': c, 'bytes': nbytes, 'frames': nframes})
        r, _, _ = select.select([fd], [], [], 0.05)
        if fd in r:
            try:
                d = os.read(fd, 1 << 20)
            except OSError:
                break
            if not d:
                break
            STATE['chunks'].append(d)
        try:
            wp, st = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            wp, st = pid, None
        if wp:
            status = st
            end = time.time() + 0.6            # 收尾巴
            while time.time() < end:
                r, _, _ = select.select([fd], [], [], 0.05)
                if fd in r:
                    try:
                        d = os.read(fd, 1 << 20)
                    except OSError:
                        break
                    if not d:
                        break
                    STATE['chunks'].append(d)
            break

    STATE['status'] = status
    if status is None:                         # 到点还活着 → 收尾 (Ctrl+C 然后 SIGKILL), 不留残留
        try:
            os.write(fd, b'\x03')
        except OSError:
            pass
        time.sleep(0.4)
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        _reap(pid, 2.0)

    with open(a.out + '.keys.json', 'w', encoding='utf-8') as f:
        json.dump(marks, f, ensure_ascii=False)
    _finish_and_exit(0)
    return 0                                   # 到不了 (上面 os._exit)


if __name__ == '__main__':
    sys.exit(main())
