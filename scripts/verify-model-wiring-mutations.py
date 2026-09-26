#!/usr/bin/env python3
"""
verify-model-wiring-mutations.py — 「接线收口」这道门是否**承重**的变异验证 (2026-09-26)

做一件事: 把接线后**必须成立的四条判决**分别改坏一条, 确认
  1) 盘上这个文件的 sha256 **真的变了** (先证明变异落盘了, 否则后面的"绿"毫无意义);
  2) 真跑门 `scripts/verify-model-wiring.ts` **真的判红** (绿 = 门不承重, 直接报失败);
然后从内存里的原文原样写回 (不依赖 git stash / 不碰 index)。

四条判决 (对应任务里的四根线):
  M1 映射表**丢掉一个类** —— 探测 7 类里少一类 → 那类失败会被算成"未映射" (类目被静默吞掉)
  M2 未映射**退化成无信息文案** —— 报一句 "switch_failed", 原文类名与逐步事实全丢
  M3 **在跑 Run 被新默认改写** —— 串行点把"下一个 Run 的模型"盖到上一条 Run 的快照上
  M4 鉴权头**不看注册表** —— 自定义供应商声明的 authHeader 被忽略, 一律塞 Authorization: Bearer
  M5 往**已经收尾**的 Run 上追加切换事件 —— 历史记录被改写 (接线时真跑逼出来的那个缝)

用法: python3 scripts/verify-model-wiring-mutations.py
"""

import hashlib
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
GATE = "scripts/verify-model-wiring.ts"

# (编号, 一句话说明, 文件, 原文, 改成)
MUTATIONS = [
    (
        "M1", "映射表丢掉 tool_call_unsupported (探测 7 类里少一类, 该类被静默吞掉)",
        "src/llm/model-selection.ts",
        "  tool_call_unsupported: 'tool_call_unsupported',\n",
        "",
    ),
    (
        "M2", "未映射的探测类目退化成无信息文案 (原文类名与逐步事实全丢)",
        "src/llm/model-selection.ts",
        "  return { failureClass: UNMAPPED_PROBE_CLASS, raw, unmapped: true };",
        "  return { failureClass: 'switch_failed' as any, raw: '', unmapped: false };",
    ),
    (
        "M3", "在跑 Run 被新默认改写 (把下一个 Run 的模型盖到上一条 Run 的快照上)",
        "src/agents/execution-supervisor.ts",
        "    const nextModelConfig = modelResolution?.startRunModelConfig;",
        "    const nextModelConfig = modelResolution?.startRunModelConfig;\n"
        "    if (prevRunId && nextModelConfig) {\n"
        "      const rsM: any = await import('./run-store.js');\n"
        "      const fsM: any = await import('node:fs');\n"
        "      const pathM: any = await import('node:path');\n"
        "      const recM = await rsM.readRun(prevRunId);\n"
        "      if (recM) {\n"
        "        recM.modelConfig = nextModelConfig;\n"
        "        fsM.writeFileSync(pathM.join(rsM.runsDir(), `${prevRunId}.json`), JSON.stringify(recM, null, 2));\n"
        "      }\n"
        "    }",
    ),
    (
        "M4", "鉴权头不看注册表 (自定义供应商声明的 authHeader 被忽略)",
        "src/llm/pi-ai.ts",
        "    if (!declared) return null;",
        "    if (!declared) return null;\n    return null;",
    ),
    (
        "M5", "往**已经收尾**的 Run 上追加切换事件 (历史被改写: 飞轮规则 ⑦ / P7「不回头改老 Run」)",
        "src/agents/execution-supervisor.ts",
        "        ...(prevIsHistory ? {} : { prevRunId: prevRunId || undefined }),",
        "        prevRunId: prevRunId || undefined,",
    ),
]


def sha(p: pathlib.Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()[:16]


def main() -> int:
    failures = []
    for mid, desc, rel, old, new in MUTATIONS:
        p = ROOT / rel
        before = sha(p)
        src = p.read_text(encoding="utf-8")
        if old not in src:
            print(f"[{mid}] ❌ 锚点没找到, 变异没落盘: {rel}")
            failures.append(f"{mid}(锚点缺失)")
            continue
        if src.count(old) != 1:
            print(f"[{mid}] ❌ 锚点不唯一 ({src.count(old)} 次), 拒绝改: {rel}")
            failures.append(f"{mid}(锚点不唯一)")
            continue
        p.write_text(src.replace(old, new), encoding="utf-8")
        after = sha(p)
        if before == after:
            print(f"[{mid}] ❌ 盘上 hash 没变, 变异没落盘 — 后面的结果无效")
            failures.append(f"{mid}(没落盘)")
            p.write_text(src, encoding="utf-8")
            continue
        try:
            r = subprocess.run(
                ["npx", "tsx", GATE],
                cwd=ROOT, capture_output=True, text=True, timeout=900,
            )
            out = (r.stdout or "") + (r.stderr or "")
            red = r.returncode != 0
            tail = [ln for ln in out.splitlines() if "passed /" in ln]
            detail = tail[-1].strip() if tail else out.strip().splitlines()[-1][:120] if out.strip() else "(无输出)"
        except subprocess.TimeoutExpired:
            red, detail = True, "超时 (当判红处理, 但需人工确认)"
        print(f"[{mid}] {'✅ 判红' if red else '❌ 判绿 (门不承重)'}  {desc}  ({rel} {before}→{after})")
        print(f"        {detail}")
        if not red:
            failures.append(f"{mid}(判绿)")
        p.write_text(src, encoding="utf-8")
        assert sha(p) == before, f"{mid}: 恢复失败"

    print("=" * 64)
    print(f"变异验证: {len(MUTATIONS) - len(failures)}/{len(MUTATIONS)} 判红")
    if failures:
        print("有问题: " + " | ".join(failures))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
