#!/usr/bin/env python3
"""
verify-tool-names-mutations.py — 「工具名出网净化 + 回程派发」的门是否**承重**的变异验证 (2026-09-26)

做一件事: 把净化 / 还原 / 拒发的关键行为逐条改坏, 确认
  1) 盘上这个文件的 sha256 **真的变了** (先证明变异落盘, 否则后面的"绿"毫无意义);
  2) 门**真的判红** (绿 = 门不承重, 直接报失败);
然后原样从内存写回 (不依赖 git stash), 并复核恢复后的 sha 与改前一致.

两条门都算数 (按变异落在哪一层选):
  - `npx tsx scripts/verify-tool-names.ts`  → 出网完整性门 (真注册表 180 工具 + 源码级唯一路径断言)
  - `npx vitest run src/test/tool-name.test.ts` → 聚焦单测 (纯函数级: 截断/碰撞/无名拒发)

用法: python3 scripts/verify-tool-names-mutations.py
"""

import hashlib
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
GATE = ("tsx", "scripts/verify-tool-names.ts")
UNIT = ("vitest", "src/test/tool-name.test.ts")

# (编号, 一句话说明, 文件, 原文, 改成, 用哪道门判)
MUTATIONS = [
    (
        "M1", "把 pi-ai.ts 的净化边界调用摘掉 (tools 原样出网)", "src/llm/pi-ai.ts",
        "        openaiTools = sanitizeToolsForApi(tools as any[]);",
        "        openaiTools = tools as any[];",
        GATE,
    ),
    (
        "M2", "净化放行 '.' (等于没净化 contact.* 那一族)", "src/llm/tool-name.ts",
        "  let s = raw.replace(new RegExp(`[^${TOOL_NAME_CHAR_CLASS}]`, 'g'), '_');",
        "  let s = raw.replace(new RegExp(`[^${TOOL_NAME_CHAR_CLASS}.]`, 'g'), '_');",
        GATE,
    ),
    (
        "M3", "超长不再截断 + hash 后缀 (65+ 的名字直接出网)", "src/llm/tool-name.ts",
        "  if (s.length > TOOL_NAME_MAX_LENGTH) {\n    s = `${s.slice(0, TRUNCATE_KEEP)}_${toolNameFingerprint(raw)}`;\n  }",
        "  // MUTATED: 超长不处理",
        UNIT,
    ),
    (
        "M4", "碰撞静默覆盖 (两个不同原名共用一个 API 名)", "src/llm/tool-name.ts",
        "    const holder = this.byApi.get(api);\n    if (holder !== undefined && holder !== orig) {\n      throw new ToolNameCollisionError(api, [holder, orig]);\n    }\n    this.byApi.set(api, orig);\n    this.byOriginal.set(orig, api);\n    return api;\n  }\n\n  /** 批量登记 */",
        "    this.byApi.set(api, orig);\n    this.byOriginal.set(orig, api);\n    return api;\n  }\n\n  /** 批量登记 */",
        UNIT,
    ),
    (
        "M5", "回程不还原 (resolveToOriginal 原样返回, LLM 调工具必未知)", "src/llm/tool-name.ts",
        "    const hit = this.byApi.get(String(apiName ?? ''));\n    return hit !== undefined ? hit : String(apiName ?? '');",
        "    return String(apiName ?? '');",
        UNIT,
    ),
    (
        "M6", "pi-sdk 派发侧的还原行被删 (只留出网净化, 回程没有还原)", "src/agents/pi-sdk.ts",
        "        if (typeof tc.name === 'string' && tc.name) tc.name = resolveApiToolName(tc.name);",
        "        // MUTATED: 回程不还原",
        GATE,
    ),
    (
        "M7", "无名/空名工具不再拒绝 (静默放过坏形状)", "src/llm/tool-name.ts",
        "    if (typeof original !== 'string' || original.length === 0) {",
        "    if (false) {",
        UNIT,
    ),
]


def sha(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def run_gate(kind: str, target: str) -> bool:
    """返回 True = 判红 (门承重). 子进程超时 (240s) 也当判红 —— 门自己挂住同样不算绿."""
    if kind == "tsx":
        cmd = ["npx", "tsx", target]
    else:
        cmd = ["npx", "vitest", "run", target]
    try:
        r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=240)
    except subprocess.TimeoutExpired:
        return True
    return r.returncode != 0


def main() -> int:
    only = {a for a in sys.argv[1:] if a.startswith("M")}
    plans = [m for m in MUTATIONS if not only or m[0] in only]
    # 预检: 盘上若有上次被中断留下的变异, 直接拒跑 (别在脏源码上判红/判绿)
    dirty = [m[2] for m in MUTATIONS if "MUTATED" in (ROOT / m[2]).read_text(encoding="utf-8")]
    if dirty:
        print("❌ 盘上有上次未恢复的变异, 先恢复再跑: " + ", ".join(sorted(set(dirty))))
        return 2
    failures = []
    for mid, desc, rel, old, new, gate in plans:
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
            red = run_gate(*gate)
        finally:
            p.write_text(src, encoding="utf-8")
        assert sha(p) == before, f"{mid}: 恢复失败"
        label = "出网门" if gate[0] == "tsx" else "聚焦单测"
        print(f"[{mid}] {'✅ 判红' if red else '❌ 判绿 (门不承重)'}  {desc}  ({rel} {before}→{after} via {label})")
        if not red:
            failures.append(f"{mid}(判绿)")

    print("=" * 64)
    print(f"变异验证: {len(plans) - len(failures)}/{len(plans)} 判红")
    if failures:
        print("有问题: " + " | ".join(failures))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
