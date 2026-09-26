#!/usr/bin/env python3
"""
verify-model-acceptance-mutations.py — P8 验收门 (`scripts/verify-model-acceptance.ts`) 是否**承重** (2026-09-26)

做两件事:

  A) **口径自洽门 (裸跑基线)** —— 不给任何环境变量、不改变异, 真跑一次验收门, 要求:
       1) exit 0;
       2) 输出里第 12 条的状态**明明白白**: `[12] … — PASS (…)` 一行 + 专门的一行 `第 12 条口径: PASS`;
       3) 那条"门内跑不到的臂"必须写出 **SKIP 理由 + 引证** (理由要说得出实测依据, 引证指变异脚本 M4)。
     这一条就是"把第 12 条的口径修正拿掉就必须红"的门 —— 见检查 B 的 **M6**。

  B) **变异验证 (门是否承重)** —— 把"16 条验收里点名的判决"分别改坏一条, 确认:
       1) 盘上这个文件的 sha256 **真的变了** (先证明变异落盘了, 否则后面的"红"毫无意义);
       2) 真跑验收门 **真的判红** (判绿 = 这条验收不承重, 直接报失败);
     然后从内存里的原文原样写回 (不依赖 git stash / 不碰 index)。

六条判决 (逐条对着验收清单):
  M1  CLI `/model` 切完**不重建运行时** (P0 那个"切了不生效"的缺陷原样复现)          → 第 1 条必须红
  M2  探测失败**不再拦** (错的 key/URL/model 一律当成功)                              → 第 4 条必须红
  M3  会话级切换**把全局也一起写了** (作用域被吞了)                                   → 第 7 条必须红
  M4  跨进程互斥那两条机制一起拿掉 (锁空转 + 配置签名恒等)                            → 第 12 条必须红
  M5  "不接受工具调用声明"不再归类为 tool_call_unsupported (当协议不符放行)            → 第 15 条必须红
  M6  第 12 条的口径修正被拿掉 (反事实臂退回"外部位"写法: 由环境变量填) → 裸跑必须红, 且红项含 **第 12 条**

注 1: 本脚本**不再**给被测门设任何开关 —— 第 12 条的反事实臂已口径自洽: 门内跑得到的臂真跑,
      门内跑不到的臂显式 SKIP + 引证 (详见验收门文件头"反事实的两种")。于是"裸跑 exit 0"这件事
      本身也成了被验对象 (检查 A)。
注 2: `--repeat N` 把选中的变异连跑 N 次, 用来如实刻画**稳定性** (哪一次红了几条 / 红在哪些条目)。
      例: `python3 scripts/verify-model-acceptance-mutations.py --only M4 --repeat 3`

用法: python3 scripts/verify-model-acceptance-mutations.py [--only M4|baseline] [--repeat N]
"""

import hashlib
import os
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
GATE = "scripts/verify-model-acceptance.ts"

# 每条: (id, 一句话, [(文件, 原文, 改后), ...], 必须出现在红项里的条目号)
MUTATIONS = [
    (
        "M1", "CLI `/model` 切完不重建运行时 (写盘成功但内存实例还是旧的)",
        [(
            "src/llm/model-selection.ts",
            "    const applied = await applyEffectiveToRuntime(req.sessionKey);",
            "    const applied = { ...(previous as any), ...target };   // 变异 M1: 不重建运行时",
        )],
        set(),
    ),
    (
        "M2", "探测失败不再拦 (错的 key / URL / model 一律当成功写盘)",
        [(
            "src/llm/model-selection.ts",
            "  if (r.ok) return { ok: true, unmapped: false, ...common };",
            "  if (true) return { ok: true, unmapped: false, ...common };   // 变异 M2: 探测失败也放行",
        )],
        set(),
    ),
    (
        "M3", "会话级切换把全局也一起写了 (作用域被吞)",
        [(
            "src/llm/model-selection.ts",
            "      await writeSessionSelection(req.sessionKey || currentSessionKey(), target);",
            "      await writeSessionSelection(req.sessionKey || currentSessionKey(), target);\n"
            "      await llmConfigStore.updateProvider(provider as ModelProvider, { enabled: true, model: target.model, baseUrl: target.baseUrl });   // 变异 M3: 顺手写全局",
        )],
        set(),
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
        {12},
    ),
    (
        "M5", "「不接受工具调用声明」不再归类为 tool_call_unsupported",
        [(
            "src/llm/connection-probe.ts",
            "  if (context === 'tool' && /tool|function/i.test(text)) {",
            "  if (false && context === 'tool' && /tool|function/i.test(text)) {   // 变异 M5: 不当工具调用不支持",
        )],
        set(),
    ),
    (
        "M6", "第 12 条的口径修正被拿掉 (反事实臂退回「外部位」写法: 由环境变量填) → 裸跑必须红",
        [(
            GATE,
            "  const mutualExclusionAbsent = t2Done < noLockT1;",
            "  const mutualExclusionAbsent = process.env.BOLLOON_ACCEPTANCE_M4_RED === '1';   // 变异 M6: 第 12 条口径退回「外部位」写法 (裸跑不设环境变量 ⇒ 必然红)",
        )],
        {12},
    ),
]


def sha(p: pathlib.Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()[:16]


def red_items_of(out: str) -> list:
    """从门输出里摘红项条目号 (末行 '  · [NN] …' 的形状)"""
    return sorted({int(x) for x in re.findall(r"^  · \[(\d+)\]", out, re.M)})


def run_gate(timeout: int = 1800) -> tuple:
    """裸跑验收门: **不带任何开关** (第 12 条口径自洽后, 门不需要外部 env)"""
    env = dict(os.environ)
    env.pop("BOLLOON_ACCEPTANCE_M4_RED", None)
    try:
        r = subprocess.run(
            ["npx", "tsx", GATE], cwd=ROOT, capture_output=True, text=True, timeout=timeout, env=env,
        )
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except subprocess.TimeoutExpired:
        return 124, "超时 (当判红处理, 但需人工确认)"


def baseline_check() -> list:
    """检查 A: 口径自洽门 —— 裸跑必须 exit 0 + 第 12 条状态明明白白 + SKIP 有理由有引证"""
    code, out = run_gate()
    fails = []
    reds = red_items_of(out)
    if code != 0:
        fails.append(f"裸跑 exit={code} (必须 0)" + (f" 红项条目={reds}" if reds else ""))
    if not re.search(r"^\[12\] .+ — PASS \(", out, re.M):
        fails.append("输出里没有 `[12] … — PASS (…)` 这一行 (第 12 条状态不明)")
    if "第 12 条口径: PASS" not in out:
        fails.append("没有 `第 12 条口径: PASS` 这一行 (口径自洽没装到输出上)")
    if "反事实 (SKIP·门内跑不到" not in out:
        fails.append("那条门内跑不到的反事实臂没有显式 SKIP 标记 (退出'外部位'写法了吗)")
    if "SKIP 理由:" not in out or "引证:" not in out:
        fails.append("SKIP 臂没有同时写出「理由」与「引证」")
    if not re.search(r"verify-model-acceptance: 条目 16/16", out):
        fails.append("没有 `条目 16/16` 汇总行")
    summary = [ln.strip() for ln in out.splitlines() if ln.startswith("verify-model-acceptance:")]
    detail = summary[-1] if summary else "(无汇总行)"
    print(f"[基线] {'✅ 裸跑 exit 0, 第 12 条口径明明白白' if not fails else '❌ 口径自洽门判红'}")
    print(f"        {detail}")
    return fails


def main() -> int:
    only = None
    repeat = 1
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--only" and i + 1 < len(args):
            only = args[i + 1].upper()
            i += 2
            continue
        if args[i] == "--repeat" and i + 1 < len(args):
            repeat = max(1, int(args[i + 1]))
            i += 2
            continue
        i += 1

    failures = []
    ran = 0
    mutation_runs = 0

    # ── A) 口径自洽门 (裸跑基线) ─────────────────────────────
    if only in (None, "BASELINE"):
        ran += 1
        failures += [f"baseline({f})" for f in baseline_check()]

    # ── B) 变异验证 ─────────────────────────────────────────
    for mid, desc, edits, expect_items in MUTATIONS:
        if only and mid != only:
            continue
        for round_no in range(1, repeat + 1):
            ran += 1
            mutation_runs += 1
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

            code, out = run_gate()
            red = code != 0
            red_items = red_items_of(out)
            summary = [ln.strip() for ln in out.splitlines() if ln.startswith("verify-model-acceptance:")]
            detail = summary[-1] if summary else "(无汇总行)"
            reds = [ln.strip() for ln in out.splitlines() if ln.strip().startswith("❌")][:6]

            files = " ".join(f"{rel} {b}→{a}" for rel, (b, a) in hashes.items())
            tag = f" 第 {round_no}/{repeat} 遍" if repeat > 1 else ""
            print(f"[{mid}]{tag} {'✅ 判红' if red else '❌ 判绿 (这条验收不承重)'}  {desc}")
            print(f"        {files}")
            print(f"        {detail}")
            if red_items:
                print(f"        红项条目: {red_items}")
            for rl in reds:
                print(f"        {rl[:160]}")
            if not red:
                failures.append(f"{mid}(判绿)")
            elif expect_items and not expect_items.issubset(set(red_items)):
                # 判红了, 但红在该红的条目上吗 (红在别处 = 这条判决其实不承重)
                missing = sorted(expect_items - set(red_items))
                print(f"        ❌ 红项里没有该红的条目 {missing} (红在别处 = 这条判决不承重)")
                failures.append(f"{mid}(红错条目 缺={missing})")

            for rel, src in originals.items():
                p = ROOT / rel
                p.write_text(src, encoding="utf-8")
                assert sha(p) == hashes[rel][0], f"{mid}: {rel} 恢复失败"

    print("=" * 64)
    print(f"P8 验收门验证: 口径门(裸跑) {'绿' if not [f for f in failures if f.startswith('baseline')] else '红'}"
          f" · 变异真跑 {mutation_runs} 次 (判红 {mutation_runs - len([f for f in failures if not f.startswith('baseline')])} 次)"
          f" · 不过 {len(failures)} 处")
    if failures:
        print("有问题: " + " | ".join(failures))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
