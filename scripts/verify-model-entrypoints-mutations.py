#!/usr/bin/env python3
"""
verify-model-entrypoints-mutations.py — 「入口收敛」这道门是否**承重**的变异验证 (2026-09-26, P6)

做一件事: 把收敛后**必须成立**的判决分别改坏一条, 确认
  1) 盘上这个文件的 sha256 **真的变了** (先证明变异落盘了, 否则后面的"绿"毫无意义);
  2) 真跑门 `scripts/verify-model-entrypoints.ts` **真的判红** (绿 = 门不承重, 直接报失败);
然后从内存里的原文原样写回 (不依赖 git stash / 不碰 index)。

三条判决 (对应用户点名的两个缺口 + 一条命令面能力):
  M1 旧接口**绕过**新入口 —— `/api/llm-provider` 自己写 activeProvider, 不转发给统一入口
  M2 自定义 provider **仍进不了入口** —— 校验退回"只认内置表" (缺口㈡ 原样复现)
  M3 命令面的 `/model refresh` **空转** —— 不调 P5 的 refreshModelDiscovery, 假装刷新成功

用法: python3 scripts/verify-model-entrypoints-mutations.py
"""

import hashlib
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
GATE = "scripts/verify-model-entrypoints.ts"

MUTATIONS = [
    (
        "M1", "旧接口绕过新入口 (/api/llm-provider 自己写 activeProvider, 不转发统一入口)",
        "src/web/routes-llm-config.ts",
        "    return runModelSelect({ ...req.body, provider }, res, { legacy: 'llm-provider' });",
        "    await llmConfigStore.setActiveProvider(provider as ModelProvider);\n"
        "    return res.json({ ok: true, provider });",
    ),
    (
        "M2", "自定义 provider 仍进不了入口 (校验退回只认内置表)",
        "src/llm/model-selection.ts",
        "  const base = baseDefaultsOf(provider, ctx.providerConfig);\n  if (!base) {",
        "  if (!DEFAULT_PROVIDER_CONFIGS[provider as ModelProvider]) {\n"
        "    return { ok: false, failureClass: 'invalid_provider' as any, message: `未知供应商 '${provider}'` };\n"
        "  }\n"
        "  const base = baseDefaultsOf(provider, ctx.providerConfig);\n  if (!base) {",
    ),
    (
        "M3", "命令面 /model refresh 空转 (不调 P5, 假装刷新成功)",
        "src/cli/setup-wizard.ts",
        "    const r = await refreshModelDiscovery(parsed.provider || undefined, { force: true });",
        "    const r: any = { refreshedAt: new Date().toISOString(), force: true, cachePath: '', results: [], counts: {}, failures: [], notes: [] };",
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
            detail = tail[-1].strip() if tail else (out.strip().splitlines()[-1][:140] if out.strip() else "(无输出)")
            reds = [ln.strip() for ln in out.splitlines() if ln.strip().startswith("❌")][:3]
        except subprocess.TimeoutExpired:
            red, detail, reds = True, "超时 (当判红处理, 但需人工确认)", []
        print(f"[{mid}] {'✅ 判红' if red else '❌ 判绿 (门不承重)'}  {desc}  ({rel} {before}→{after})")
        print(f"        {detail}")
        for rl in reds:
            print(f"        {rl[:150]}")
        if not red:
            failures.append(f"{mid}(判绿)")
        p.write_text(src, encoding="utf-8")
        restored = sha(p) == before
        assert restored, f"{mid}: 恢复失败"

    print("=" * 64)
    print(f"变异验证: {len(MUTATIONS) - len(failures)}/{len(MUTATIONS)} 判红")
    if failures:
        print("有问题: " + " | ".join(failures))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
