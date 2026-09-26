#!/usr/bin/env python3
"""
verify-model-selector-mutations.py — 「分步选择器 + 元数据 + 三条遗留」的门是否**承重**的变异验证 (2026-09-26)

做一件事: 把关键行为改坏 (词界改名/改动真逻辑), 确认
  1) 盘上这个文件的 sha256 **真的变了** (先证明变异落盘了, 否则后面的"绿"毫无意义);
  2) 聚焦测试**真的判红** (绿 = 门不承重, 直接报失败);
然后原样恢复 (从内存里的原文写回, 不依赖 git stash)。

用法: python3 scripts/verify-model-selector-mutations.py
"""

import hashlib
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
UNIT = "src/test/model-selector.test.ts"
P0_UNIT = "src/test/model-selection.test.ts"

# (编号, 一句话说明, 文件, 原文, 改成, 聚焦测试文件)
MUTATIONS = [
    (
        "M1", "在 runModelCommand 里偷偷加第二条写配置路径",
        "src/cli/setup-wizard.ts",
        "  const provider = parsed.provider!;\n  const r = await selectModel({\n    provider,\n    model: parsed.model,",
        "  const provider = parsed.provider!;\n  await llmConfigStore.updateProvider(provider as ModelProvider, {});\n  const r = await selectModel({\n    provider,\n    model: parsed.model,",
        UNIT,
    ),
    (
        "M2", "选择器不再走唯一入口 (词界改名 selectModel → selectModelOnce)",
        "src/cli/model-selector.ts",
        "  const r = await selectModel(req);",
        "  const r = await selectModelOnce(req);",
        UNIT,
    ),
    (
        "M3", "工具调用能力不再是 unknown 而是编造 yes",
        "src/llm/model-catalog.ts",
        "const toolCalling = facts.toolCalling ?? 'unknown';",
        "const toolCalling = facts.toolCalling ?? 'yes';",
        UNIT,
    ),
    (
        "M4", "渲染层把未知翻成\"支持\"",
        "src/llm/model-catalog.ts",
        "  return c === 'yes' ? '支持' : c === 'no' ? '不支持' : '未知';",
        "  return c === 'yes' ? '支持' : c === 'no' ? '不支持' : '支持';",
        UNIT,
    ),
    (
        "M5", "抽掉锁内 invalidate() (陈旧快照会吃掉别的进程的改动)",
        "src/llm/model-selection.ts",
        "        llmConfigStore.invalidate();\n        await llmConfigStore.initialize();\n\n        const patch: Partial<ProviderConfig> =",
        "        await llmConfigStore.initialize();\n\n        const patch: Partial<ProviderConfig> =",
        UNIT,
    ),
    (
        "M6", "configHash 反查永远说\"没漂移\"",
        "src/llm/model-selection.ts",
        "  return {\n    verified: true,\n    drifted: true,",
        "  return {\n    verified: true,\n    drifted: false,",
        UNIT,
    ),
    (
        "M7", "把用户输入的 key 明文打进日志",
        "src/cli/model-selector.ts",
        "push(`已收到 key (尾号 ****${k.slice(-4)})",
        "push(`已收到 key ${k}",
        UNIT,
    ),
    (
        "M8", "configHash 不再含 model (两个不同模型同一个 hash)",
        "src/llm/model-selection.ts",
        "  const parts = [\n    sel.provider,\n    sel.model,",
        "  const parts = [\n    sel.provider,",
        P0_UNIT,
    ),
    (
        "M9", "\"这家要不要 key\"改回以配置为准 (注册表冲突不再标出)",
        "src/llm/model-catalog.ts",
        "    const requiresApiKey = registryRequires;",
        "    const requiresApiKey = configRequires;",
        UNIT,
    ),
    (
        "M10", "第 4 步不再收窄列表 (模糊搜索形同虚设)",
        "src/cli/model-selector.ts",
        "  if (io.ask && entries.length > 3) {",
        "  if (false) {",
        UNIT,
    ),
]


def sha(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def main() -> int:
    failures = []
    for mid, desc, rel, old, new, test in MUTATIONS:
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
        r = subprocess.run(
            ["npx", "vitest", "run", test],
            cwd=ROOT, capture_output=True, text=True, timeout=900,
        )
        red = r.returncode != 0
        print(f"[{mid}] {'✅ 判红' if red else '❌ 判绿 (门不承重)'}  {desc}  ({rel} {before}→{after})")
        if not red:
            failures.append(f"{mid}(判绿)")
        # 原样恢复
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
