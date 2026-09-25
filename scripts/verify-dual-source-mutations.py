#!/usr/bin/env python3
"""
变异验证 (mutation verification) —— 双源更新 (update-protocol §12)

规矩: **改坏新加的关键判据 → 聚焦测试必须判红 → 恢复 → 全绿**。
按**词界**替换 (re.sub + \\b), 不用子串替换 —— 子串替换会撞到注释/别的字面量, 产出假绿。

每一项只动一处, 跑完立刻恢复原文; 最后再跑一次确认全绿。
"""
import re
import subprocess
import sys
from pathlib import Path

REPO = Path('/Users/apple/Downloads/bolloon')
FOCUS = 'src/test/update-dual-source.test.ts'
OTHER = 'src/test/update-system.test.ts'

# (名字, 文件, 正则, 替换, 聚焦测试文件, 期望: 该测试文件必须变红)
MUTATIONS = [
    (
        "M1 REFUSED_STATUSES 漏掉 github_unavailable",
        'src/utils/update-manager.ts',
        r"'(?P<w>github_unavailable)', 'cross_check_mismatch'\];",
        "'github_unavailable_dropped', 'cross_check_mismatch'];",
        FOCUS,
    ),
    (
        "M2 crossCheckStable: 两源不一致 → 说成 agree (不再阻塞)",
        'src/utils/dual-source.ts',
        r"kind: 'mismatch', hasTag, hasRelease, blocking: true,",
        "kind: 'agree', hasTag, hasRelease, blocking: false,",
        FOCUS,
    ),
    (
        "M3 channelKindOf: dev 的比较语义 → 说成 semver",
        'src/utils/version-info.ts',
        r"return channel === 'dev' \? 'git-ref' : 'semver';",
        "return 'semver';",
        FOCUS,
    ),
    (
        "M4 dev 源不可达 → 改报 up_to_date (就是「假装没事」的那种改坏)",
        'src/utils/update-manager.ts',
        r"status: 'github_unavailable', latestVersion: null, dev: null, targetIdentity: null,\n        reason: `github_unavailable\(\$\{reason\}\)",
        "status: 'up_to_date', latestVersion: null, dev: null, targetIdentity: null,\n        reason: `github_unavailable(${reason})",
        FOCUS,
    ),
    (
        "M5 装完 dev 却把来源记成 stable (切不回 / 说假话)",
        'src/utils/update-manager.ts',
        r"installedChannel: 'dev',",
        "installedChannel: 'stable',",
        FOCUS,
    ),
    (
        "M6 dev 身份反解 sha 失效 (状态层就认不出 dev 安装)",
        'src/utils/version-info.ts',
        r"export function devShaFromIdentity\(v: string \| null \| undefined\): string \| null \{",
        "export function devShaFromIdentity(s: string): string | null {\n  if (s) return null;   // MUTATION",
        FOCUS,
    ),
]

ASSERT_RED = re.compile(r'Tests\s+(\d+) failed')
ASSERT_GREEN = re.compile(r'Tests\s+(\d+) passed')


def run_focus(target: str) -> tuple[bool, str]:
    r = subprocess.run(
        ['npx', 'vitest', 'run', target],
        cwd=REPO, capture_output=True, text=True, timeout=900,
    )
    out = r.stdout + r.stderr
    red = ASSERT_RED.search(out)
    green = ASSERT_GREEN.search(out)
    if red:
        return False, f"{red.group(1)} 个用例失败"
    if green:
        return True, f"{green.group(1)} 个用例通过"
    return None, out.strip().split('\n')[-1][:160]


def main() -> int:
    print("变异验证: 改坏关键判据 → 聚焦测试必须判红 → 恢复 → 全绿\n")
    results = []
    for name, rel, pat, rep, focus in MUTATIONS:
        p = REPO / rel
        orig = p.read_text()
        new, n = re.subn(pat, rep, orig)
        if n != 1:
            print(f"  [跳过] {name}: 正则命中 {n} 处 (应为 1) —— 说明源码变了, 请修脚本")
            results.append((name, 'PATTERN-MISS', f'命中 {n} 处'))
            continue
        p.write_text(new)
        try:
            ok, detail = run_focus(focus)
        finally:
            p.write_text(orig)
        verdict = 'RED (符合预期)' if ok is False else ('GREEN (假绿!)' if ok is True else 'UNKNOWN')
        mark = '\x1b[32m✓\x1b[0m' if ok is False else '\x1b[31m✗\x1b[0m'
        print(f"  {mark} {name}\n       → 聚焦测试 {verdict} — {detail} [{rel}]")
        results.append((name, verdict, detail))

    print("\n恢复后复跑 (必须全绿):")
    ok_focus, d1 = run_focus(FOCUS)
    ok_other, d2 = run_focus(OTHER)
    print(f"  {'✓' if ok_focus else '✗'} {FOCUS}: {d1}")
    print(f"  {'✓' if ok_other else '✗'} {OTHER}: {d2}")

    bad = [r for r in results if r[1] != 'RED (符合预期)']
    print(f"\n判红: {len(results) - len(bad)}/{len(results)} 项按预期判红")
    if bad:
        print("异常项:")
        for n, v, d in bad:
            print(f"  - {n}: {v} ({d})")
    if not (ok_focus and ok_other):
        print("恢复后没有全绿 —— 有残留问题!")
        return 2
    return 0 if not bad else 1


if __name__ == '__main__':
    sys.exit(main())
