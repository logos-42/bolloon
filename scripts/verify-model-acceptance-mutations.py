#!/usr/bin/env python3
"""
verify-model-acceptance-mutations.py — P8 验收门 (`scripts/verify-model-acceptance.ts`) 是否**承重** (2026-09-26)

做一件事: 把"16 条验收里点名的判决"分别改坏一条, 确认
  1) 盘上这个文件的 sha256 **真的变了** (先证明变异落盘了, 否则后面的"红"毫无意义);
  2) 真跑验收门 **真的判红** (判绿 = 这条验收不承重, 直接报失败);
然后从内存里的原文原样写回 (不依赖 git stash / 不碰 index)。

五条判决 (逐条对着验收清单):
  M1  CLI `/model` 切完**不重建运行时** (P0 那个"切了不生效"的缺陷原样复现)          → 第 1 条必须红
  M2  探测失败**不再拦** (错的 key/URL/model 一律当成功)                              → 第 4 条必须红
  M3  会话级切换**把全局也一起写了** (作用域被吞了)                                   → 第 7 条必须红
  M4  跨进程互斥那两条机制一起拿掉 (锁空转 + 配置签名恒等)                            → 第 12 条必须红
  M5  "不接受工具调用声明"不再归类为 tool_call_unsupported (当协议不符放行)            → 第 15 条必须红

注: 变异脚本给被测门设 `BOLLOON_ACCEPTANCE_M4_RED=1` —— 那是第 12 条反事实臂的
"外部证据位" (它的证据由本脚本的 M4 提供)。把它设为 1 是**故意让反事实那条断言通过**,
这样判红就一定来自真跑出来的红项, 不会是"反事实位没填"这种空红。

用法: python3 scripts/verify-model-acceptance-mutations.py
"""

import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
GATE = "scripts/verify-model-acceptance.ts"

# 每条: (id, 一句话, [(文件, 原文, 改后), ...])
MUTATIONS = [
    (
        "M1", "CLI `/model` 切完不重建运行时 (写盘成功但内存实例还是旧的)",
        [(
            "src/llm/model-selection.ts",
            "    const applied = await applyEffectiveToRuntime(req.sessionKey);",
            "    const applied = { ...(previous as any), ...target };   // 变异 M1: 不重建运行时",
        )],
    ),
    (
        "M2", "探测失败不再拦 (错的 key / URL / model 一律当成功写盘)",
        [(
            "src/llm/model-selection.ts",
            "  if (r.ok) return { ok: true, unmapped: false, ...common };",
            "  if (true) return { ok: true, unmapped: false, ...common };   // 变异 M2: 探测失败也放行",
        )],
    ),
    (
        "M3", "会话级切换把全局也一起写了 (作用域被吞)",
        [(
            "src/llm/model-selection.ts",
            "      await writeSessionSelection(req.sessionKey || currentSessionKey(), target);",
            "      await writeSessionSelection(req.sessionKey || currentSessionKey(), target);\n"
            "      await llmConfigStore.updateProvider(provider as ModelProvider, { enabled: true, model: target.model, baseUrl: target.baseUrl });   // 变异 M3: 顺手写全局",
        )],
    ),
    (
        "M4", "跨进程互斥两条机制一起拿掉 (锁空转 + 配置签名恒等)",
        [
            (
                "src/llm/model-selection.ts",
                "export async function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {\n"
                "  const lockPath = path.join(llmConfigStore.configDirPath(), CONFIG_LOCK_FILE);",
                "export async function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {\n"
                "  if (true) return await fn();   // 变异 M4a: 锁空转\n"
                "  const lockPath = path.join(llmConfigStore.configDirPath(), CONFIG_LOCK_FILE);",
            ),
            (
                "src/llm/config-store.ts",
                "      return `${st.mtimeMs}:${st.size}`;",
                "      return 'static-mutation';   // 变异 M4b: 签名恒等, 不再重读",
            ),
        ],
    ),
    (
        "M5", "「不接受工具调用声明」不再归类为 tool_call_unsupported",
        [(
            "src/llm/connection-probe.ts",
            "  if (context === 'tool' && /tool|function/i.test(text)) {",
            "  if (false && context === 'tool' && /tool|function/i.test(text)) {   // 变异 M5: 不当工具调用不支持",
        )],
    ),
]


def sha(p: pathlib.Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()[:16]


def main() -> int:
    only = None
    if len(sys.argv) > 2 and sys.argv[1] == "--only":
        only = sys.argv[2].upper()
    failures = []
    ran = 0
    for mid, desc, edits in MUTATIONS:
        if only and mid != only:
            continue
        ran += 1
        originals = {}
        hashes = {}
        applied = True
        for rel, old, new in edits:
            p = ROOT / rel
            src = p.read_text(encoding="utf-8")
            originals[rel] = src
            hashes[rel] = (sha(p), "")
            if old not in src:
                print(f"[{mid}] ❌ 锚点没找到, 变异没落盘: {rel}")
                failures.append(f"{mid}(锚点缺失)")
                applied = False
                break
            if src.count(old) != 1:
                print(f"[{mid}] ❌ 锚点不唯一 ({src.count(old)} 次), 拒绝改: {rel}")
                failures.append(f"{mid}(锚点不唯一)")
                applied = False
                break
            p.write_text(src.replace(old, new), encoding="utf-8")
            hashes[rel] = (hashes[rel][0], sha(p))

        if not applied:
            for rel, src in originals.items():
                (ROOT / rel).write_text(src, encoding="utf-8")
            continue

        unchanged = [rel for rel, (b, a) in hashes.items() if b == a]
        if unchanged:
            print(f"[{mid}] ❌ 盘上 hash 没变, 变异没落盘 — 后面的结果无效: {unchanged}")
            failures.append(f"{mid}(没落盘)")
            for rel, src in originals.items():
                (ROOT / rel).write_text(src, encoding="utf-8")
            continue

        env = dict(os.environ)
        env["BOLLOON_ACCEPTANCE_M4_RED"] = "1"
        try:
            r = subprocess.run(
                ["npx", "tsx", GATE],
                cwd=ROOT, capture_output=True, text=True, timeout=1800, env=env,
            )
            out = (r.stdout or "") + (r.stderr or "")
            red = r.returncode != 0
            red_items = re.findall(r"^  · \[(\d+)\]", out, re.M)
            summary = [ln.strip() for ln in out.splitlines() if ln.startswith("verify-model-acceptance:")]
            detail = summary[-1] if summary else "(无汇总行)"
            reds = [ln.strip() for ln in out.splitlines() if ln.strip().startswith("❌")][:6]
        except subprocess.TimeoutExpired:
            red, detail, red_items, reds = True, "超时 (当判红处理, 但需人工确认)", [], []

        files = " ".join(f"{rel} {b}→{a}" for rel, (b, a) in hashes.items())
        print(f"[{mid}] {'✅ 判红' if red else '❌ 判绿 (这条验收不承重)'}  {desc}")
        print(f"        {files}")
        print(f"        {detail}")
        if red_items:
            print(f"        红项条目: {sorted(set(int(x) for x in red_items))}")
        for rl in reds:
            print(f"        {rl[:160]}")
        if not red:
            failures.append(f"{mid}(判绿)")

        for rel, src in originals.items():
            p = ROOT / rel
            p.write_text(src, encoding="utf-8")
            assert sha(p) == hashes[rel][0], f"{mid}: {rel} 恢复失败"

    print("=" * 64)
    print(f"P8 验收门变异验证: {ran - len(failures)}/{ran} 判红")
    if failures:
        print("有问题: " + " | ".join(failures))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
