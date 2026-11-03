# App 自动更新链（Tauri updater）— 原理、现状、换钥记录

> 2026-11-04 立档。起因：0.7.3–0.7.5 三次发布都没产出 `.sig`，线上清单停在 `0.7.0-1`，
> 要更新时才发现「链断了」；而当时的签名私钥已丢失，只能换钥。

## 一、链路四个环节

```
① 构建产物                 ② 用私钥签名                 ③ 发清单                     ④ 客户端验签
Bolloon.app.tar.gz   →   Bolloon.app.tar.gz.sig   →   latest.json (url+signature)  →   用内嵌 pubkey 校验
                                                          ↑
                                          bolloon.cn / jsDelivr / GitHub Pages / ghfast
```

- **`latest.json` 是公告**：`{version, notes, pub_date, platforms:{ "<target>-<arch>": {url, signature} }}`
- **`signature` 是对产物字节做的 minisign 签名**（不是对 json 签）
- **`pubkey` 内嵌在 App 里**（`plugins.updater.pubkey`）；验不过 → 客户端**静默不更新**（用户看不到原因）
- **私钥 = 发布权**。私钥丢失 = 没有任何客户端会认你的新包

## 二、minisign 格式（排错时用来辨认）

| | 公钥 `updater.key.pub` | 私钥 `updater.key` |
| --- | --- | --- |
| 首行 | `untrusted comment: minisign public key: <16位hex id>` | `untrusted comment: minisign encrypted secret key` |
| 次行 | base64，解出 42 字节（alg 2 + keyid 8 + pk 32） | base64，长得多（KDF 参数 + 加密后的密钥） |
| 大小 | ~152 B（本仓这份本身就是 base64 文本，可直接粘进 conf） | ~348 B |
| 用途 | 验签（随 App 分发） | 签名（需口令解锁） |

- **算法标记语义**（实测）：`sig.alg == "ED"` ⇒ Ed25519 over **BLAKE2b-512(文件)**（Tauri 默认）；`"Ed"` ⇒ 对原文直接签。**写反会得到"签名无效"的假红**。
- **口令文件** `updater.password`（32 B）只是解锁私钥用的，单独没有签名能力。

## 三、2026-11-04 换钥记录

| 项 | 值 |
| --- | --- |
| 旧公钥 id | `BB8BDA7857F45ABA`（私钥已丢失，仅存公钥与口令） |
| 新公钥 id | `90ED1F410A295CD7` |
| 新私钥 | `rust/app-tauri/src-tauri/.tauri/updater.key`（348 B，0600，**git 忽略**） |
| 新口令 | `.tauri/updater.password`（32 B，0600）→ **必须存进密码管理器** |
| 首版 | `0.7.6`（dmg + `Bolloon.app.tar.gz` + `.sig` 全部产出） |

**代价（必须公告）**：已装 ≤0.7.5 的客户端内嵌的是旧公钥，验新签名必然失败 ⇒ **需要手动重装一次**。
这是换钥的物理结果，没有兼容办法（除非找回旧私钥）。

## 四、发布纪律（脚本已固化）

```bash
bash scripts/tauri-release.sh --check      # 只自检：密钥三件套 / 公钥一致 / 版本一致
bash scripts/tauri-release.sh              # 自检 → 构建 → 收产物 → 生成清单 → 本地真验签
SKIP_BUILD=1 bash scripts/tauri-release.sh # 已构建过，只补清单与验签
```

四道门（任一不过直接非零退出）：

1. **密钥三件套齐全**（私钥/口令/公钥，权限 600）——换钥事故的根因就是这里断了；
2. **公钥一致**：`tauri.conf.json` 的 `pubkey` 必须与 `.tauri/updater.key.pub` 逐字节相同；
3. **版本一致**：`tauri.conf.json` / `package.json` / `rust/Cargo.toml` / `app-tauri Cargo.toml`；
4. **真验签**：`scripts/verify-updater-signature.mjs` 用 conf 的 pubkey 验本地产物的 `.sig`
   （blake2b512 + ed25519，Node 原生 crypto，无第三方依赖；key id 不匹配会直接指出"不是这把钥匙签的"）。

**部署后必须再验一次线上**（防"本地 OK、线上传错"）：

```bash
PUB=$(python3 -c "import json;print(json.load(open('rust/app-tauri/src-tauri/tauri.conf.json'))['plugins']['updater']['pubkey'])")
node scripts/verify-updater-signature.mjs --manifest https://bolloon.cn/update/latest.json --pubkey "$PUB"
```

## 五、常见症状对照

| 症状 | 真正原因 |
| --- | --- |
| 点检查更新 → 提示"已是最新" | 线上 `latest.json` 的 `version` ≤ 当前版本（清单没人更新） |
| 下载完没反应 | `.sig` 与产物不配套 / 私钥换过但客户端公钥没换（验签静默失败） |
| 清单有 `signature` 但客户端仍不更新 | `signature` 不是 base64(minisign 文本)，或 key id 与 pubkey 不一致 |
| `tauri build` 报 `public key invalid` | `pubkey` 直接塞了 `RW…` 原文（必须先 base64 成文本块；本仓 `.pub` 已是 base64） |

## 六、防再丢

- 私钥 + 口令进密码管理器，并保留一份离线备份（换钥代价是全员手动重装，不要再来一次）；
- 发布前跑 `--check`；部署后跑线上验签；
- **绝不**用 `tauri signer generate` 覆盖已有 `.tauri/updater.key`（除非确实要换钥并公告）。
