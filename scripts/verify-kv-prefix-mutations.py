#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify-kv-prefix-mutations.py — 「前缀 KV 可命中」门的**变异判红** (2026-09-28)

规矩 (与 scripts/verify-tool-names-mutations.py 同一套): 门说"这条机制是承重的", 就得能证明 ——
把那条机制**真拆掉**, 门必须**变红**; 拆掉后还绿 = 这条断言是假的/空转.

每条变异: 改一处 (锚点必须命中, 命中不了直接算失败) → 跑 `npx tsx scripts/verify-kv-prefix.ts`
→ **必须非 0 退出** → 恢复原文件 (finally).

用法: python3 scripts/verify-kv-prefix-mutations.py
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PI_AI = ROOT / "src" / "llm" / "pi-ai.ts"
PI_SDK = ROOT / "src" / "agents" / "pi-sdk.ts"
GATE = "scripts/verify-kv-prefix.ts"

# (名字, 文件, 原文, 变异后, 期望红在哪一条)
MUTATIONS = [
    (
        "M1 拿掉「chat() 回带最终 wire messages」→ 调用方拿不到注入后的当前轮",
        PI_AI,
        "        messages,                       // 回带最终 wire messages: 调用方据此把当前轮写回自己的 history",
        "        messages: undefined,            // 变异: 不回带",
        "[1] 第 2 轮前部逐字节 / writeBackCurrentTurnInto",
    ),
    (
        "M2 拿掉「调用方把回带的当前轮写回自己的 history」(pi-sdk 回写变 no-op)",
        PI_SDK,
        "export function writeBackCurrentTurnInto(\n  history: Array<{ role: string; content?: string }>,\n  wire: Array<{ role: string; content?: string }> | undefined\n): number {\n  try {",
        "export function writeBackCurrentTurnInto(\n  history: Array<{ role: string; content?: string }>,\n  wire: Array<{ role: string; content?: string }> | undefined\n): number {\n  return 0; // 变异: 不写回\n  try {",
        "[1] 第 2 轮前部逐字节 (U1 丢了 D1)",
    ),
    (
        "M3 system 里掺一个时间戳 (稳定段不再稳定)",
        PI_AI,
        "      const suffix = `\\n\\n## User Working Directory\\n${workingDir}\\n\\n## bolloon-runtime\\n${SYSTEM_PROMPT_VERSION} · layers: ${result.layerIds.join(',')}`;",
        "      const suffix = `\\n\\n## User Working Directory\\n${workingDir}\\n\\n## bolloon-runtime\\n${SYSTEM_PROMPT_VERSION} · layers: ${result.layerIds.join(',')} · t=${Date.now()}`;",
        "[2] system 跨轮逐字节相同",
    ),
    (
        "M4 拿掉 canonicalizeTools 并打乱工具顺序 (跨轮 tokens 前缀抖动)",
        PI_AI,
        "        openaiTools = canonicalizeTools(sanitizeToolsForApi(tools as any[]));",
        "        openaiTools = sanitizeToolsForApi(tools as any[]).slice().reverse(); // 变异: 不规范化 + 打乱",
        "[3] tools 跨轮 sha256 相同",
    ),
    (
        "M5 拿掉 sanitizeToolsForApi (工具名出网不再净化)",
        PI_AI,
        "        openaiTools = canonicalizeTools(sanitizeToolsForApi(tools as any[]));",
        "        openaiTools = canonicalizeTools(tools as any[]); // 变异: 去掉净化",
        "[4] 出网 function.name 全合法",
    ),
    (
        "M6 轻量分流失灵 (所有 purpose 都当主对话 → 探针也拖满前缀/工具)",
        PI_AI,
        "  return (purpose || 'chat') !== MAIN_AGENT_PURPOSE;",
        "  return false; // 变异: 全按主对话处理",
        "[8] 非主对话 purpose 轻量",
    ),
    (
        "M7 cache_prompt 不分流 (谁都带 true → 单 slot 上抢 KV)",
        PI_AI,
        "  if (env.BOLLOON_DISABLE_CACHE_PROMPT === '1') return false;\n  return (purpose || 'chat') === MAIN_AGENT_PURPOSE;",
        "  void env;\n  return true; // 变异: 不分流",
        "[6] 逐 purpose cache_prompt=false",
    ),
    (
        "M8 拿掉 stream_options.include_usage (SSE 末帧没有 usage → 命中率测不到)",
        PI_AI,
        "      requestBody.stream_options = { include_usage: true };",
        "      requestBody.stream_options = { include_usage: false }; // 变异: 不要 usage",
        "[10] stream_options.include_usage",
    ),
    (
        "M9 initPiAI 指纹恒不等 (每次都重建 + 清装配缓存)",
        PI_AI,
        "  _instanceFingerprint = fingerprint;",
        "  _instanceFingerprint = ''; // 变异: 指纹丢失",
        "[7] 指纹一致复用实例 / 缓存未清",
    ),
    (
        "M10 registry 动态层不再拆出 system (dynamic 又回到 system 里)",
        PI_AI,
        "          .filter((l) => l.source === 'function')",
        "          .filter((l) => false) // 变异: 不认动态层",
        "[2] 动态层不在 system 里",
    ),
]


def run_gate() -> tuple[int, str]:
    p = subprocess.run(
        ["npx", "tsx", GATE],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=900,
    )
    out = (p.stdout or "") + (p.stderr or "")
    return p.returncode, out


def main() -> int:
    print("== 先跑一遍基线 (应当全绿) ==")
    code, out = run_gate()
    tail = [l for l in out.splitlines() if l.startswith("KV 前缀门")]
    print(f"   基线: exit={code} {tail[-1] if tail else '(无汇总行)'}")
    if code != 0:
        print("   基线就是红的 → 变异判红无意义, 先修门.")
        return 2

    results = []
    for name, path, old, new, expect_red in MUTATIONS:
        src = path.read_text(encoding="utf-8")
        if old not in src:
            print(f"❌ {name}\n   锚点没命中 ({path.name}) → 变异未生效, 判红无效")
            results.append((name, False, "锚点没命中"))
            continue
        mutated = src.replace(old, new, 1)
        if mutated == src:
            print(f"❌ {name}\n   替换没生效")
            results.append((name, False, "替换没生效"))
            continue
        path.write_text(mutated, encoding="utf-8")
        try:
            code, out = run_gate()
            red = code != 0
            fails = [l.strip()[2:] for l in out.splitlines() if l.strip().startswith("❌")]
            detail = fails[0] if fails else (out.strip().splitlines() or ["(无输出)"])[-1]
            ok = red
            print(f"{'✅' if ok else '❌'} {name}\n   exit={code} 判红={'是' if red else '否'} · 期望红在: {expect_red}\n   首条失败: {detail[:160]}")
            results.append((name, ok, detail[:160]))
        finally:
            path.write_text(src, encoding="utf-8")   # 恢复
            back = path.read_text(encoding="utf-8")
            if back != src:
                print(f"   ⚠️ 恢复不干净: {path}")

    good = sum(1 for _, ok, _ in results if ok)
    print("\n" + "=" * 68)
    print(f"变异门: {good}/{len(results)} 判红 (要求: 全部判红, 至少 4 条)")
    if good != len(results):
        for name, ok, detail in results:
            if not ok:
                print(f"  - 没判红: {name} :: {detail}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
