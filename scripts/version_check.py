from __future__ import annotations
# bolloon-version: 0.3.7
# runtime: dev-only (checks npm registry for @bolloon/bolloon-agent)
#
# 与 src/utils/auto-update.ts 保持一致：bolloon 通过 npm 全局分发，
# 因此版本检查以 npm registry 为准，不再指向其它仓库的 GitHub releases。

import json
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

NPM_REGISTRY = "https://registry.npmjs.org/@bolloon/bolloon-agent"
PKG_NAME = "@bolloon/bolloon-agent"
SCRIPTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPTS_DIR.parent


def parse_version(value: str) -> tuple[int, ...]:
    parts = re.findall(r"\d+", value)
    return tuple(int(part) for part in parts[:3]) if parts else (0,)


def get_local_version() -> str:
    # 优先：仓库 package.json（开发态）
    repo_pkg = REPO_ROOT / "package.json"
    if repo_pkg.exists():
        try:
            data = json.loads(repo_pkg.read_text(encoding="utf-8"))
            if data.get("name") == PKG_NAME and data.get("version"):
                return data["version"]
        except Exception:
            pass
    # 回退：全局安装版本
    try:
        out = subprocess.run(
            ["npm", "ls", "-g", PKG_NAME, "--depth=0", "--json"],
            capture_output=True, text=True, timeout=8,
        )
        data = json.loads(out.stdout or "{}")
        for node in (data.get("dependencies") or {}).values():
            v = node.get("version")
            if v:
                return v
    except Exception:
        pass
    return "unknown"


def get_remote_version() -> str:
    try:
        req = urllib.request.Request(NPM_REGISTRY, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            return data.get("dist-tags", {}).get("latest", "")
    except Exception:
        return ""


def main() -> int:
    local = get_local_version()
    remote = get_remote_version()
    if not remote:
        return 0
    if local == "unknown":
        print(f"[bolloon] 无法检测本地版本。最新版为 v{remote}")
        return 0
    if parse_version(remote) > parse_version(local):
        print(f"[bolloon] 发现新版本: v{local} -> v{remote}")
        print(f"[bolloon] 运行: bash scripts/upgrade.sh")
        print(f"[bolloon] 或: bolloon --update-now")
    return 0


if __name__ == "__main__":
    sys.exit(main())
