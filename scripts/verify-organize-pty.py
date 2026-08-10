#!/usr/bin/env python3
"""verify-organize-pty.py — 验证 CLI 自动整理心跳:
   1. 启动即跑一轮 (每次打开后固定看一下 skills view) → 🧹 遗留提示 + 🧠 知识整理汇总
   2. transient 颜文字行结束后清空 (无残留 '(｀・ω・´)' 整理行)
"""
import os, pty, time, select, re, json, tempfile

TMP = tempfile.mkdtemp(prefix='bolloon-organize-')
os.makedirs(os.path.join(TMP, '.bolloon', 'sessions'), exist_ok=True)
os.makedirs(os.path.join(TMP, '.bolloon', 'skills', 'apple-leftover'), exist_ok=True)
os.makedirs(os.path.join(TMP, '.bolloon', 'context-os', '01-Me'), exist_ok=True)
channels = [{"id": "ch-1", "name": "测试频道", "agentId": "agent-1", "persona": {"name": "TestAgent", "description": "测试"}}]
with open(os.path.join(TMP, '.bolloon', 'sessions', 'channels.json'), 'w') as f:
    json.dump(channels, f)
# 一个迁移遗留 skill (触发 🧹 提示)
with open(os.path.join(TMP, '.bolloon', 'skills', 'apple-leftover', 'SKILL.md'), 'w') as f:
    f.write("---\nname: apple-leftover\ndescription: 迁移来的遗留\n---\n## 流程\n# x\n" * 30)
# 一个 01-Me 资产 (触发知识整理)
with open(os.path.join(TMP, '.bolloon', 'context-os', '01-Me', '个人档案.md'), 'w') as f:
    f.write("# 档案\n刘元杰, 杭州" * 30)

ENV = {**os.environ, 'HOME': TMP,
       'BOLLOON_SKIP_UPDATE': '1', 'BOLLOON_AGENT_HEARTBEAT_SOCIAL': '0',
       'BOLLOON_ORGANIZE_HEARTBEAT_MS': '60000'}  # 60s: drain 期间只有启动 runOnce 一轮
ansi_re = re.compile(rb"\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]")

pid, fd = pty.fork()
if pid == 0:
    os.chdir('/Users/apple/Downloads/bolloon')
    os.execve('/usr/bin/env', ['env'] + [f'{k}={v}' for k, v in ENV.items()] + ['npx', 'tsx', 'src/index.ts'], ENV)

buf = b''
def read_until(needle, timeout):
    global buf
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
            if n in buf:
                return True
    return False

def drain(seconds):
    """持续读 fd, 把 sleep 期间的输出收进 buf (否则 pty 缓冲区内容丢失)"""
    global buf
    deadline = time.time() + seconds
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

def get_screen():
    return ansi_re.sub(b'', buf).decode('utf-8', 'replace')

fails = []
print('[1] 等待 CLI 启动...')
ok = read_until("Esc 双击退出", 120)
print('[1] 启动完成:', ok)
# 启动 runOnce 在 CLI 内部 startInk 后 3s 触发, 扫描 ~1-2s → drain 10s 足够
drain(10)

screen = get_screen()
print('[2] 检查 🧹 遗留 skills 提示...')
if '发现 1 个遗留 skills' in screen:
    print('  ✓ 遗留提示出现')
else:
    fails.append('遗留提示未出现')
    print('  ✗ 未找到; 屏幕尾部:', screen[-500:])

print('[3] 检查 🧠 知识整理汇总...')
if '知识整理:' in screen:
    print('  ✓ 知识整理汇总出现')
else:
    fails.append('知识整理汇总未出现')
    print('  ✗ 未找到; 屏幕尾部:', screen[-500:])

print('[4] 检查 transient 行已清空 (当前屏幕无整理行残留)...')
# Ink 增量渲染: 历史帧文本留在 buf, 只检查当前屏幕 (buf 尾部) 是否干净
tail = screen[-1500:]
if '自动整理经验中' in tail:
    fails.append('transient 行残留 (当前屏幕)')
    print('  ✗ transient 残留:', [l for l in tail.splitlines() if '自动整理经验中' in l][:3])
else:
    print('  ✓ transient 行已清空 (显示为空)')

# 清理
try:
    os.kill(pid, 15)
except Exception:
    pass
time.sleep(1)
os.system(f'rm -rf "{TMP}"')

if fails:
    print('\nFAIL:', fails)
    raise SystemExit(1)
print('\nPASS: 自动整理心跳 CLI 端到端验证通过')
