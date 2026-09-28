#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify-efficode-mutations.py — Efficode 门的**变异判红** (2026-09-28)

规矩 (与 scripts/verify-kv-prefix-mutations.py / verify-tool-names-mutations.py 同一套):
门说"这条机制是承重的", 就得能证明 —— 把那条机制**真拆掉**, 门必须**变红**;
拆掉后还绿 = 这条断言是假的/空转。

每条变异: 改一处 (锚点必须命中, 命中不了直接算失败) → 跑
`npx tsx scripts/verify-efficode.ts --core-only` → **必须非 0 退出** → 恢复原文件 (finally)
→ 恢复后再跑一次确认**变回绿** (否则说明恢复没干净 / 门本身是红的).

用户点名的三条都在里面:
  M1 解码器对**未知指令宽容** (不再抛)  → 红
  M2 包尾 **CRC 校验拿掉**              → 红
  M3 **对端单方声明也切语言**           → 红
另加 M4: 对端声明**未知语言**时也进解码器 (硬解) → 红

用法: python3 scripts/verify-efficode-mutations.py
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKET = ROOT / "src" / "efficode" / "packet.ts"
NEGOTIATE = ROOT / "src" / "efficode" / "negotiate.ts"
GATE = "scripts/verify-efficode.ts"

# (名字, 文件, 原文锚点, 变异后, 期望红在哪一条)
MUTATIONS = [
    (
        "M1 解码器对未知指令宽容 (未知 opcode 不再抛, 一律当 !ACK 收下)",
        PACKET,
        "    const def = opByCode(code, pos); // 未知 opcode → 抛 (变异 M1 拆掉这里 → 门变红)",
        "    const def = { symbol: '!ACK' as const, code, hasPayload: false, prefix: '!ACK' }; // 变异: 未知 opcode 一律宽容当 !ACK",
        "[B] 未知操作码 → EFFICODE_UNKNOWN_OPCODE",
    ),
    (
        "M2 拿掉包尾 CRC 校验 (篡改的包照收)",
        PACKET,
        "  if (want !== got) {\n    throw new EfficodeError('EFFICODE_CRC_MISMATCH', `CRC32 不符: 包内 0x${want.toString(16)}, 实算 0x${got.toString(16)}`, expectCrcAt);\n  }",
        "  void want; void got; // 变异: 不查 CRC",
        "[B] 正文被改一字节 → EFFICODE_CRC_MISMATCH",
    ),
    (
        "M3 对端单方声明也切语言 (双方声明这条硬规则被拆)",
        NEGOTIATE,
        "  if (m === 'efficode' && t === 'efficode') {",
        "  if (m === 'efficode' || t === 'efficode') { // 变异: 单方声明也算",
        "[C] 单方声明 → 回落自然语言",
    ),
    (
        "M4 对端声明未知语言也进解码器 (硬解)",
        NEGOTIATE,
        "  if (declared !== 'efficode') {",
        "  if (false) { // 变异: 声明什么语言都当 efficode 解",
        "[C] 对端声明未知语言 → 不进解码器",
    ),
]


def run_gate() -> subprocess.CompletedProcess:
    return subprocess.run(
        ["npx", "tsx", GATE, "--core-only"],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )


def main() -> int:
    # R0 开工前自检: 变异锚点必须都在原位 (否则"没红"根本不能说明问题)
    print("== R0 变异锚点自检 ==")
    for name, path, anchor, _new, _where in MUTATIONS:
        text = path.read_text(encoding="utf-8")
        if anchor not in text:
            print(f"  ❌ 锚点没命中: {name} ({path.name})")
            return 2
        print(f"  ✅ 锚点在位: {name}")
    # 基线: 变异前门必须是绿的, 否则后面的"红"没有意义
    base = run_gate()
    if base.returncode != 0:
        print("  ❌ 变异前门就是红的 —— 先修门, 再谈变异")
        print((base.stdout or "")[-1500:])
        return 2
    print("  ✅ 基线: 变异前门 = 绿 (core-only)")

    print("\n== 逐条变异 (改一处 → 门必须红 → 还原 → 必须回绿) ==")
    all_ok = True
    restore_failed = ""
    for name, path, anchor, mutated, where in MUTATIONS:
        original = path.read_text(encoding="utf-8")
        res = None
        try:
            path.write_text(original.replace(anchor, mutated, 1), encoding="utf-8")
            changed = path.read_text(encoding="utf-8") != original
            if not changed:
                print(f"  ❌ {name}: 变异没写进去")
                all_ok = False
                continue
            res = run_gate()
        finally:
            path.write_text(original, encoding="utf-8")
            if path.read_text(encoding="utf-8") != original:
                restore_failed = path.name
        if restore_failed:
            print(f"  ❌ {path.name} 还原失败 —— 立刻停, 源码可能留在变异态")
            return 3
        assert res is not None
        red = res.returncode != 0
        detail = ""
        if red:
            for line in (res.stdout or "").splitlines():
                if line.strip().startswith("❌"):
                    detail = line.strip()[:110]
                    break
        print(
            f"  {'✅' if red else '❌'} {name} → {'红' if red else '绿 (变异没被判出!)'}"
            + (f" | {where}" if red else "")
            + (f" | {detail}" if detail else "")
        )
        if not red:
            all_ok = False

    # 全部还原后, 门必须回到绿 (证明"红"是变异引起的, 不是环境问题)
    back = run_gate()
    green_again = back.returncode == 0
    print(f"\n  {'✅' if green_again else '❌'} 全部还原后门回绿 (红是变异引起的, 不是环境)")
    if not green_again:
        all_ok = False
        print((back.stdout or "")[-1200:])

    print(f"\n结论: {'全部通过' if all_ok else '有变异没被判红'} · 源码已还原")
    if all_ok:
        print("  · 4/4 变异判红 · 还原后回绿 · 已还原")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
