# Release notes 模板 (中文, 与 npm 版本同步命名)

> 一份 Release notes 的**唯一来源**是 `docs/release-notes/v<版本>.md` (版本号 = `package.json` 的 `version`)。
> `scripts/gh-release.mjs` 读这个文件 → 覆盖生成最后一节「可核验信息 / 提交列表」→ `gh release create`。
> **Release 名 = git tag 名 = `v<package.json 的 version>`** —— 三者必须逐字一致。

## 写这一份的纪律 (硬规则, 违反就是编造)

1. **一个字都不许编**。每条只能是:
   - `git log <上一个 tag>..v<本版本> --oneline` 里**真存在**的提交, 或
   - `docs/wiki/log.md` / `docs/wiki/update-protocol.md` 里**真写下的**记录与数字, 或
   - 你**当场真跑**出来的输出。
2. **数字一律带出处约定**: 真跑数字直接写 (如 `34/34` · `63 PASS / 0 FAIL / 0 SKIP`), 拿不准的**不写数字**, 改写「详见本节提交列表」。宁可少写一句, 不可多写一个假数。
3. **不搬私有内容**: 内部任务书 / 研究课题 / 私下发给受托方的材料 / 本机凭据与私有路径, 一律不进公开 Release。脚本硬拦两条禁词 (内部工具名 + 私有锚点路径, 见 `scripts/gh-release.mjs` 的 `FORBIDDEN_LITERALS`), 但机械拦截只是兜底, 判据在写的人。
4. **本节「可核验信息 / 提交列表」不要手写** —— 由脚本从 npm registry 现取 + `git log` 现取并覆盖。手抄会过期。

## 分节结构 (顺序固定, 空节写「无」而不是删掉)

```markdown
## 亮点
> 1–3 条, 写给「要不要升级」的人: 这一版最值钱的变化是什么。

## 新增能力
- 新增的命令 / 选项 / 界面 / 接口。带用法示例。

## 修复
- 修掉的**真缺陷**: 现象 → 原因一句 → 修后真数字 (有就跑, 没有就不写)。

## 验证 (真跑数字)
- 发前门禁 / 发布判据 / 仓内硬门, 逐条贴真数字与命令。

## 升级方法
```bash
npm i -g @bolloon/bolloon-agent@<版本>   # 或最新
bolloon update                           # 已装用户就地更新 (stable 通道)
```

## 可核验信息      <!-- 脚本覆盖生成, 不要手写 -->
## 提交列表        <!-- 脚本覆盖生成, 不要手写 -->
```

## 发版顺序 (与 `docs/wiki/update-protocol.md` §14 是同一份口径)

```bash
# 1. 本地: 版本号 + 门禁 + 出包
npm version <x.y.z> --no-git-tag-version && git add package.json package-lock.json && ...
npx tsc --noEmit && npx vitest run            # 门禁
git tag -a v<x.y.z> -m "<一句话>"             # annotated, 必须
git push origin master && git push origin v<x.y.z>

# 2. npm 那一侧
npm publish --access public
node scripts/verify-release.mjs <x.y.z> --install-check     # 发布后硬门

# 3. GitHub 那一侧 (本脚本)
node scripts/gh-release.mjs --dry-run         # 先读 notes
node scripts/gh-release.mjs                   # 建 Release (latest)
```
