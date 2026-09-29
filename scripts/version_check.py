from __future__ import annotations
# bolloon-version: 0.4.29
# runtime: dev-only —— 薄包装, 全部判定交给 src/utils/update-manager.ts (唯一检查逻辑)
#
# 为什么不再自己实现一份:
#   旧版这里写死了 `0.3.7` (与 package.json 0.4.28 差 21 个版本), 还自己打 registry、
#   自己比版本 —— 与 CLI / auto-update / 安装脚本各算一套, 于是"我到底是什么版本"
#   有多个答案。现在本脚本只做三件事:
#     ① 找到同一份 Update Manager (优先 tsx 跑 src, 回退编译产物 dist)
#     ② 执行 `check --json`, 读它的结构化结论
#     ③ 按结论打印人话 —— **网络失败绝不显示"已是最新"**
#
# 与 AGENTS.md §1 步 0 的约定一致: 最新时静默 (不刷屏); 有话说时才输出。
# 想看完整结论: BOLLOON_UPDATE_VERBOSE=1 python3 scripts/version_check.py
# 想看结构化输出: python3 scripts/version_check.py json

import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPTS_DIR.parent
TIMEOUT_S = 40


def entry_command() -> tuple[list[str], str] | None:
    """优先用 tsx 跑源码 (永远是最新逻辑), 回退到编译产物 dist。

    返回 (argv, 说明); 两者都没有则 None —— 此时**不猜**, 明确告诉用户检查不可用。
    """
    tsx = REPO_ROOT / "node_modules" / ".bin" / "tsx"
    src = REPO_ROOT / "src" / "utils" / "update-cli.ts"
    if tsx.exists() and src.exists():
        return ([str(tsx), str(src)], "tsx(src)")
    dist = REPO_ROOT / "dist" / "utils" / "update-cli.js"
    if dist.exists():
        return (["node", str(dist)], "dist(编译产物)")
    return None


def main() -> int:
    want_json = "json" in sys.argv[1:] or "--json" in sys.argv[1:]
    verbose = os.environ.get("BOLLOON_UPDATE_VERBOSE") == "1"

    entry = entry_command()
    if entry is None:
        # 不假装知道 —— 检查不可用就是检查不可用 (它不等于"已是最新")
        print("[bolloon] 版本检查不可用: 既没有 node_modules/.bin/tsx, 也没有 dist/utils/update-cli.js")
        print("[bolloon] 先 npm install, 或 npm run build:main")
        return 2

    argv, how = entry
    cmd = argv + ["check", "--json"]

    try:
        proc = subprocess.run(
            cmd,
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=TIMEOUT_S,
            env={**os.environ, "BOLLOON_UPDATE_FROM_SCRIPT": "1"},
        )
    except subprocess.TimeoutExpired:
        print(f"[bolloon] 版本检查超时 ({TIMEOUT_S}s) — 不能判定为最新")
        return 2
    except Exception as exc:  # pragma: no cover - 环境异常
        print(f"[bolloon] 版本检查未能执行: {exc}")
        return 2

    raw = (proc.stdout or "").strip()
    payload = None
    if raw:
        # 取最后一段 JSON 对象 (防止命令前的日志混入)
        start = raw.find("{")
        if start >= 0:
            try:
                payload = json.loads(raw[start:])
            except Exception:
                payload = None

    if payload is None:
        tail = (proc.stderr or raw or "").strip().splitlines()
        hint = tail[-1] if tail else "无输出"
        print(f"[bolloon] 版本检查失败 ({how}): {hint}")
        return 2

    if want_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0 if proc.returncode == 0 else 2

    status = payload.get("status")
    current = payload.get("currentVersion", "unknown")
    latest = payload.get("latestVersion")
    reason = payload.get("reason") or ""
    install = payload.get("installMethod", "unknown")

    if status == "up_to_date":
        if verbose:
            print(f"[bolloon] 已是最新版本 (v{current}, {install})")
        return 0
    if status == "check_skipped":
        if verbose:
            print(f"[bolloon] 距上次检查不足间隔, 使用缓存结论 (v{current}, {install})")
        return 0
    if status == "update_available":
        print(f"[bolloon] 发现新版本: v{current} -> v{latest} (安装方式: {install})")
        if install == "npm-global":
            print("[bolloon] 更新: bolloon update (直接执行; 只看计划用 bolloon update --dry-run)")
        else:
            print("[bolloon] 这是源码/开发目录, 更新走: git pull && npm install && npm run build:all")
        return 0
    if status == "unsupported_installation":
        print(f"[bolloon] 当前安装方式不支持自动更新 (v{current}, {install}); 最新为 v{latest or '未知'}")
        if reason:
            print(f"[bolloon] {reason}")
        return 0
    if status == "offline":
        print(f"[bolloon] 离线: 连不上 npm registry ({reason}) — 这不代表是最新版")
        return 0
    if status == "registry_unavailable":
        print(f"[bolloon] registry 不可用: {reason} — 这不代表是最新版")
        return 0
    if status == "local_version_unknown":
        print(f"[bolloon] 读不到本地版本 ({reason}) — 不判断是否有更新")
        return 0

    print(f"[bolloon] 未知检查结论: {status}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
