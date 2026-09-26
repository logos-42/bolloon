#!/usr/bin/env python3
"""
verify-provider-registry-mutations.py — 「供应商注册表 + 兼容协议」这道门是否**承重**的变异验证 (2026-09-26)

做一件事: 把关键行为改坏 (词界改名/改真逻辑), 确认
  1) 盘上这个文件的 sha256 **真的变了** (先证明变异落盘了, 否则后面的"绿"毫无意义);
  2) 聚焦测试**真的判红** (绿 = 门不承重, 直接报失败);
然后原样恢复 (从内存里的原文写回, 不依赖 git stash)。

用法: python3 scripts/verify-provider-registry-mutations.py
"""

import hashlib
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
UNIT = "src/test/provider-registry.test.ts"
MIG = "src/test/provider-registry-migration.test.ts"

# (编号, 一句话说明, 文件, 原文, 改成)
MUTATIONS = [
    (
        "M1", "注册表谎称 gemini 发得出原生工具调用 (路由表里它没有)",
        "src/llm/provider-registry.ts",
        "  'openai', 'minimax', 'deepseek', 'kimi', 'glm', 'qwen', 'mimo', 'grok',\n];",
        "  'openai', 'minimax', 'deepseek', 'kimi', 'glm', 'qwen', 'mimo', 'grok', 'gemini',\n];",
    ),
    (
        "M2", "自定义供应商只看声明就放行, 不再看协议分支发不发得出 tools",
        "src/llm/provider-registry.ts",
        "  if (toolCalling === 'yes' && openaiCompatible) {",
        "  if (toolCalling === 'yes') {",
    ),
    (
        "M3", "填充点把**供应商级**工具调用能力当成**模型级**事实填下去",
        "src/llm/provider-registry.ts",
        "      const facts: ModelCapabilityFacts = { requiresApiKey: entry.requiresApiKey };",
        "      const facts: ModelCapabilityFacts = { requiresApiKey: entry.requiresApiKey, toolCalling: entry.toolCalling };",
    ),
    (
        "M4", "activeProvider 又只认内置表 (旧配置里的自定义默认被静默改成 ollama)",
        "src/llm/config-store.ts",
        "    if (DEFAULT_PROVIDER_CONFIGS[id as ModelProvider]) return true;\n"
        "    if (cfg.customProviders && cfg.customProviders[id]) return true;\n"
        "    const own = (cfg.providers as Record<string, ProviderConfig | undefined>)[id];\n"
        "    return !!own && (String(own.baseUrl || '').trim().length > 0 || String(own.model || '').trim().length > 0);",
        "    return !!DEFAULT_PROVIDER_CONFIGS[id as ModelProvider];",
    ),
    (
        "M5", "协议推断不再看 11434 (本地 ollama 端口) —— 全推成 openai-compatible",
        "src/llm/provider-registry.ts",
        "  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' || host.endsWith('.local')) {",
        "  if (false) {",
    ),
    (
        "M6", "把用户 key 明文打进展示行 (只留尾 4 位的规矩被拆掉)",
        "src/llm/custom-provider-store.ts",
        "`key=已配(尾号 ${String(spec.apiKey).slice(-4)})`",
        "`key=已配(${String(spec.apiKey)})`",
    ),
    (
        "M7", "自定义 authHeader 被忽略 (一律塞进 Authorization)",
        "src/llm/provider-registry.ts",
        "    case 'custom':\n      if (auth.header) headers[auth.header] = auth.scheme ? `${auth.scheme} ${key}` : key;\n      break;",
        "    case 'custom':\n      if (auth.header) headers['Authorization'] = key;\n      break;",
    ),
    (
        "M8", "自定义供应商不再拒绝与内置撞名 (优先保障清单可以被自定义覆盖)",
        "src/llm/provider-registry.ts",
        "  if (isBuiltinProvider(v)) return false;\n  return /^[a-z0-9][a-z0-9._-]*$/i.test(v);",
        "  return /^[a-z0-9][a-z0-9._-]*$/i.test(v);",
    ),
]


def sha(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


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
        r = subprocess.run(
            ["npx", "vitest", "run", UNIT, MIG],
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
