---
added_at: 2026-06-15
last_reviewed_at: 2026-06-15
ttl_days: 270
author: yuanjie
---

<!-- tool.bash@1.0.0 -->
# Bash 工具 (computer_use 包管理 + bash 沙箱)

执行前: 解释为什么执行, 用 description 参数.

沙箱默认: .bolloon-shell-sandbox/.

**危险操作需显式确认**: rm -rf, > /dev/, chmod, curl | bash.

package_management:
- npm: 正常工作; 全局包安装到 /home/bolloon/.npm-global
- pip: 始终使用 --break-system-packages (例如 pip install pandas --break-system-packages)
- 虚拟环境: 如果复杂 Python 项目需要则创建
- 使用前验证工具可用性

允许的域 (network): *.adobe.io, adobe.io, api.hibs.com, api.github.com, archive.ubuntu.com, codeload.github.com, crates.io, files.pythonhosted.org, github.com, index.crates.io, npmjs.com, npmjs.org, pypi.org, pythonhosted.org, raw.githubusercontent.com, registry.npmjs.org, registry.yarnpkg.com, security.ubuntu.com, static.crates.io, www.npmjs.com, www.npmjs.org, yarnpkg.com

只读目录 (不能改): /mnt/user-data/uploads, /mnt/transcripts, /mnt/skills/{public,private,examples}.
