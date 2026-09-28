---
title: 容器化部署 (Docker / Compose): 多阶段镜像 + 非 root + 真探针 + 密钥不进镜像
source: session (leo 2026-09-28 容器化部署要求 + 本机真 docker build / docker run / curl 证据)
created: 2026-09-28
last_confirmed: 2026-09-28
schema_version: 2
audience: reader
stage: current
status: current
confidence: high
entity_type: protocol
tags: [docker, compose, deployment, container, healthcheck, non-root, secrets, node22, uid]
---

# 容器化部署 (Docker / Compose)

**口径**: 容器化**不改变 Bolloon 的运行契约** —— 还是那个 `dist/cli-entry.js`, 还是那个
`PORT` 环境变量, 还是那个 `${BOLLOON_HOME}` 状态目录。容器只做三件它该做的事:

1. **把构建链钉死** (依赖 → 编译 → 只留运行需要的);
2. **给一个确定的运行身份** (非 root, uid/gid 1001, 固定状态目录);
3. **给一个能判死的存活判据** (不是永远 200 的假检查)。

产物 5 个文件, 全在仓根:

| 文件 | 作用 |
| --- | --- |
| [Dockerfile](../../Dockerfile) | 多阶段镜像 (build → runtime) |
| [docker-compose.yml](../../docker-compose.yml) | 端口/卷/env/restart/healthcheck + 一次性 CLI 服务 |
| [.dockerignore](../../.dockerignore) | 构建上下文过滤 (含排除说明与取舍) |
| [.env.example](../../.env.example) | 环境变量**名**清单 (只有名与空值, 无任何真实值) |
| [README.md](../../README.md) | 多了一节「Docker」指向本页 |

---

## 1. 镜像怎么搭起来的

```
Stage build   (node:22.22.3-bookworm-slim)
  ├─ COPY package.json package-lock.json + src/constraint-runtime/package.json + scripts/postinstall.js
  ├─ npm ci --prefer-offline --legacy-peer-deps          ← 全部依赖 (含 devDependencies: tsc/esbuild/tsx)
  ├─ COPY tsconfig.json + scripts/ + src/
  ├─ npm run build --workspaces --if-present             ← 先建 @bolloon/constraint-runtime
  ├─ npm run build:main                                  ← tsc + 搬 workspace 产物到 dist/constraint-runtime
  ├─ npm run build:web                                   ← src/web/client.ts → dist/web/*
  └─ node -e "…" 产物自检 (6 个入口缺一个就红)
Stage runtime (同一个基础镜像)
  ├─ ENV NODE_ENV=production / PORT=54188 / BOLLOON_HOME / BOLLOON_HOST=0.0.0.0
  ├─ apt-get install git python3 ca-certificates
  ├─ 建 bolloon 用户 (uid/gid 1001) + /home/bolloon/.bolloon (0700)
  ├─ npm ci --omit=dev --prefer-offline --legacy-peer-deps
  ├─ 把 @bolloon/constraint-runtime 的悬空符号链接换成构建产物
  ├─ COPY --from=build /app/dist
  └─ VOLUME /home/bolloon/.bolloon · EXPOSE 54188 · HEALTHCHECK · USER bolloon
```

### 1.1 为什么是 `node:22.22.3-bookworm-slim` 而不是 alpine

- **Node 22 系**: 按容器化要求钉住 22 LTS 线; 版本号钉到补丁级 (`22.22.3`), `-slim` 只去掉
  perl/man-pages 一类构建工具。
- **bookworm (glibc) 而不是 alpine (musl)**: 生产依赖里有**预编译原生模块** ——
  `sodium-native` (`prebuilds/linux-x64/*.node`)、`@number0/iroh-*`、`rolldown`、`classic-level`。
  这些 `.node` 是按 glibc 编的; 换 musl 要么 `require` 直接失败, 要么得在镜像里现装
  python3/make/g++ 重新编译 (镜像更大、构建更慢、结果更不确定)。选 glibc = 直接用上游预编译产物。

> **实测的边界 (如实写)**: `npm ci` 会报 3 条 `EBADENGINE` 警告 ——
> `@polymarket/client@0.9.0` / `@polymarket/types@0.2.0` / `@polymarket/bindings@0.9.0`
> 的 `engines` 写的是 `node >= 24`, 而镜像是 22.22.3。**只是警告, 不阻断安装**;
> 这三个包在 `dist/` 里**只被** `dist/constraint-runtime/tools/PolymarketSDK/*` 引用
> (Polymarket 交易工具, 按需加载), 不在启动路径上。镜像默认按 22 钉住; 要用
> Polymarket 那一族工具, 把 `FROM` 换成 `node:24-bookworm-slim` 再构建即可
> (本机 `package.json` 的 `@types/node` 是 `^26`, 开发机 Node 也是 24 —— 22 是**容器的**选择,
> 不是项目的下限)。

### 1.2 三个只有真跑才会撞上的坑 (都在镜像里解决了)

1. **`npm ci` 会跑 `postinstall`** → `scripts/postinstall.js` 必须在 `npm ci` **之前**就位,
   否则 node 以 `Cannot find module` 退出, 构建第一步就死。所以 COPY 顺序是
   `package.json + lock + workspace package.json + scripts/postinstall.js` → `npm ci` → 其余。
2. **ERESOLVE**: 根项目 `typescript@^7.0.2`, 而 `@rayhanadev/iroh@0.1.1` 声明
   `peer typescript@^5` → npm 10 (`npm ci`) 直接拒装 (exit 1)。本机 `node_modules` 里
   这两个版本**本来就是并存的**, 说明项目一直按"忽略 peer 冲突"装 ⇒ 镜像里显式
   `--legacy-peer-deps` **如实复现**, 不是把门放宽。
3. **`@bolloon/constraint-runtime` 是 npm workspace**: `npm ci` 之后它在 `node_modules/` 里是
   **符号链接**指向 `/app/src/constraint-runtime`。而 `pi-sdk` / `constraint-layer` 等是按
   **裸包名** `import '@bolloon/constraint-runtime'` 的。运行阶段删掉 `src/` 后符号链接悬空,
   **启动即失败** ⇒ 必须把构建产物 (`dist` + `package.json`) 拷进
   `node_modules/@bolloon/constraint-runtime/`。

---

## 2. 构建与启停

```bash
# 构建 (约 50MB 基础镜像 + 依赖; 慢网下第一次会很久)
docker build -t bolloon-agent:0.5.1 .

# 起 (Web UI) —— 卷用命名卷, 前端只发布到宿主机回环
docker run -d --name bolloon-agent \
  -p 127.0.0.1:54188:54188 \
  -v bolloon-data:/home/bolloon/.bolloon \
  bolloon-agent:0.5.1 --web

# 或 compose
docker compose up -d
docker compose logs -f bolloon
docker compose ps            # STATE 里能看到 (healthy)
docker compose down          # 停; 加 -v 才会连数据卷一起删

# 一次性 CLI (不进默认 up)
docker compose run --rm bolloon-cli --version
docker compose run --rm bolloon-cli doctor
docker compose run --rm bolloon-cli model list
# 纯 docker 也行:
docker run --rm bolloon-agent:0.5.1 --version
```

**四种启动姿势**(入口都是 `dist/cli-entry.js`):

| 命令 | 行为 |
| --- | --- |
| `docker run … ` (不带参数) | **默认模式** = `bolloon`。容器里没有 electron (它在 devDependencies, 运行镜像不装) ⇒ `startElectron` 打印"未检测到 Electron…自动降级为 Web 模式"并转 Web。**能用, 但建议显式 `--web`** 免得日志里有误导行 |
| `… --web` | Web UI。**推荐** |
| `… --cli` | 交互 TUI。**需要** `-it` (`docker run -it … --cli`) |
| `… --version` / `doctor` / `model list` | 一次性子命令, 不占端口 |

### 2.1 `docker stop` 与信号

入口 `cli-entry.js` 会 **spawn 一个子 node 进程**跑 `dist/index.js` (stdio inherit)。
没有 init 时 PID 1 是 `cli-entry`, `SIGTERM` 只到它, 子进程收不到 ⇒ 只能等 10s 后被 SIGKILL。
所以 compose 里写了 `init: true` (tini 当 PID 1 并转发信号), 并且 `stop_grace_period: 30s`。
纯 `docker run` 想一样干净: 加 `--init`。

---

## 3. 端口与绑定

- **端口只认环境变量 `PORT`** (默认 `54188`)。源码里 `--port` 参数**不被解析** ——
  命令行传 `--port 8080` 是无效的, 改端口只能 `-e PORT=8080`。
- **`BOLLOON_HOST` 决定 bind 地址**, 默认 `127.0.0.1` (源码 `options.host ?? process.env.BOLLOON_HOST ?? '127.0.0.1'`)。
  容器里**必须** `BOLLOON_HOST=0.0.0.0`, 否则端口映射打不进去 (Dockerfile 已默认设好)。
- **对外暴露面由 `ports:` / `-p` 决定**, 与 `BOLLOON_HOST` 是两件事。本仓 compose 默认
  `127.0.0.1:54188:54188` —— 只有宿主机自己能连。要给局域网/反代, 改 `"54188:54188"`,
  并且**自己加认证/防火墙**: Web 面能读本地文件、能调 agent 工具, 不是公开服务。
- 端口占用: `lsof -nP -iTCP:54188 -sTCP:LISTEN`; 或者换个宿主端口 `-p 127.0.0.1:154188:54188`。

---

## 4. 卷与权限

镜像里 `/home/bolloon/.bolloon` 属 **`bolloon:bolloon` = uid/gid 1001**, 权限 `0700`
(里面会有身份私钥、`llm-config.json`、会话、日志、orbitdb)。

| 用途 | 命令 | 权限行为 |
| --- | --- | --- |
| **推荐: 命名卷** | `-v bolloon-data:/home/bolloon/.bolloon` | 卷首次创建时**继承镜像里该目录的属主** (1001:1001) ⇒ 开箱即可写, 不用 `--user` |
| bind mount (Linux) | `-v /srv/bolloon:/home/bolloon/.bolloon` | **宿主目录属主必须是 1001** (否则 `EACCES`)。修: `sudo chown -R 1001:1001 /srv/bolloon`; 或 `docker run --user $(id -u):$(id -g) …` 让容器用你的 uid (此时容器内 HOME 仍是 `/home/bolloon`) |
| bind mount (macOS/Windows) | 同上 | Docker Desktop 的文件共享会做 uid 映射, 一般**不报权限错**; 但别在容器里对共享目录跑大规模 chown/IO |
| 只读配置 | `-v $PWD/llm-config.json:/home/bolloon/.bolloon/llm-config.json:ro` | 见 §5 |

**`--user` 的坑**: 用 `--user <宿主uid>` 时, 家目录里的 `.npmrc`/HOME 相关路径仍是
`/home/bolloon`, 但目录属主是镜像里的 1001 ⇒ 若宿主 uid ≠ 1001 且目录已存在, 仍然写不进去。
最省事还是命名卷。

**这个卷里有什么**: `config.json` · `identity/`(私钥) · `llm-config.json`(API key) ·
`sessions/` · `goals/` · `runs/` · `logs/startup.log` · `orbitdb/` · `tasks/`。
⇒ **别 `docker commit`, 别 `docker cp` 出去, 别把卷内容导出进仓** (仓的 `.gitignore`
已经挡了 `.bolloon/` 与 `.env*`, 见 [.gitignore](../../.gitignore))。

---

## 5. 密钥怎么进容器 (两条通道, 一条更安全)

| 通道 | 做法 | 安全性 |
| --- | --- | --- |
| **A. 环境变量** | `cp .env.example .env.docker` 填值, compose 用 `env_file: .env.docker`; 或 `-e DEEPSEEK_API_KEY=…` | ⚠️ 值会进容器环境 ⇒ **同一台机器上任何能跑 `docker inspect` 的人都读得到**, 也会进 crash 报告/日志。仅适合本机自用 |
| **B. 挂载配置文件 (推荐)** | 把本机 `~/.bolloon/llm-config.json` (0600) 只读挂进 `/home/bolloon/.bolloon/llm-config.json` | ✅ 不进环境、不进镜像层、不进 `docker inspect`、不进 compose 输出。Bolloon 的密钥事实源本来就是它 |
| C. 生产编排 | `docker secret` / 外部 KMS / 探针注入 | ✅ 多机场景的正解, 本页不展开 |

**`.env.docker` 而不是 `.env` (刻意)**: `docker compose` 会自动读**仓根目录的 `.env`**
做 `${VAR}` 插值 —— 那正是本机放真 key 的私密文件。所以 compose 里:
① `env_file` 指向 `.env.docker` (名字不撞, 且已在 `.gitignore`);
② **凭证类变量一律不做 `${}` 插值**。

> 这不是理论担心: 本页第一版 compose 用了 `${MINIMAX_API_KEY:-}`, 于是
> `docker compose config` **真的把仓根 `.env` 里的 key 原样打了岀来** (本机实测)。
> 而这些输出经常被贴进 issue / CI 日志。改成"凭证只走 `env_file` / 挂载"后,
> `docker compose config` 的渲染结果里**没有任何凭证名**, 已复核。

**从没配过密钥的容器长什么样**: 能起、能开 Web UI, 但 agent 执行会被初始化门禁挡住
(源码里 `bolloon --cli` 的硬门禁: 未 ready ⇒ 打印状态并 `exit 1`; `--web` 面则把
`/api/setup` 报成未就绪)。想只诊断: `-e BOLLOON_SKIP_SETUP=1` (只进诊断模式, **不绕过**执行门禁)。

---

## 6. HEALTHCHECK 探什么 / 不探什么

镜像与 compose 里是**同一条**探针 (不依赖 curl — slim 镜像里没有; 用 node 自带的 `fetch`):

```
① GET /api/health  → 必须 HTTP 200 **且** body 里 ok:true
② GET /            → 必须 HTTP 200          (dist/web/index.html 真被服务)
两条都过才 exit 0 (healthy); 任一条不过 exit 1 (unhealthy)
```

- **为什么是这两条**: ① 是 `src/web/server.ts` 的 `healthCheck()` 端点 (含 version / uptime);
  ② 直接证明**前端真的编进镜像并被服务** (缺 `dist/web` 时 `serveStaticHtml` 回 404)。
  于是"进程活着但 Web 面没起来 / 前端没打进镜像 / 端口 bind 在错误地址"都会判死。
- **为什么不用 `/api/setup` 的 ready**: 未初始化就 unhealthy 会让容器重启循环 —— 那是**没配密钥**,
  不是**服务坏了**。存活判据不该惩罚配置缺失。
- **它不断言什么 (如实)**: P2P / IPFS / Kubo / 上游 LLM 连通性。这几项在设计上**允许降级**
  (源码里就是 `bootNotice('warn', …)` 后继续), 拿它们当存活判据会产出**假红**。
  要测这些, 用 `docker exec … bolloon doctor` / `bolloon network status`, 别塞进 HEALTHCHECK。
- 参数: `interval=30s` · `timeout=10s` · `retries=4` · **`start-period=120s`** (冷启动慢, 见 §7)。

---

## 7. 常见问题

### 7.1 容器起来就退 (exit 1/非 0)

```bash
docker logs bolloon-agent | tail -50        # 先看日志, 别猜
docker inspect bolloon-agent --format '{{.State.ExitCode}} {{.State.Error}}'
```
常见原因: ① `dist/cli-entry.js` 没编出来 (看构建日志里的"产物自检"); ② 挂载的
`llm-config.json` 坏了/权限不对 ⇒ 初始化门禁 fail-closed 退出; ③ 卷不可写 (见 §4);
④ 传了 `--port` (无效参数, 端口只能靠 `PORT`)。

### 7.2 端口占了 / 连不上

```bash
lsof -nP -iTCP:54188 -sTCP:LISTEN
docker port bolloon-agent
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:54188/api/health
```
连不上先分两类: **能从宿主机 curl 到吗** (到不了 ⇒ 端口映射/`BOLLOON_HOST` 问题);
**容器内 curl 到吗** (`docker exec bolloon-agent node -e "fetch('http://127.0.0.1:54188/api/health').then(r=>console.log(r.status))"`)
⇒ 内不通外不通 = 服务没起来, 内通外不通 = 绑定/映射。

### 7.3 卷权限 (EACCES / 写不进 `~/.bolloon`)

```
EACCES: permission denied, open '/home/bolloon/.bolloon/…'
```
⇒ bind mount 时宿主目录属主不是 1001 (`sudo chown -R 1001:1001 <dir>`), 或你 `--user` 到了
一个跟 1001 不同的 uid。命名卷没这问题。

### 7.4 冷启动慢 (为什么 health 一开始是 `starting`)

`--web` 路径在 `createWebServer` **之前**有 `await withTimeout(bootstrapIroh(...), 15_000)` ——
也就是说**最多 15s** 花在 iroh/P2P 初始化上, 之后才 bind 端口; P2P/Hyperswarm 还在后台继续
(不阻塞)。受限网络里这一步经常吃满超时。所以 `start-period=120s`, 别把 `--retries` 调小。
判断"是慢还是死了": `docker logs -f` 看还有没有新行; 容器内 `ps` 看 node 还在不在。

### 7.5 P2P 不通 (连不上别的节点)

- 默认 bridge 网络**出站没问题** (DHT/NAT 打洞), 但**入站**需要显式发布端口。要别人能连进来:
  `-p 4001:4001 -p 4001:4001/udp` (以及你实际用的 libp2p 端口), 或在 compose 里加 `network_mode: host`
  (仅 Linux)。
- 受限环境干脆关掉 P2P 相关组件: `-e BOLLOON_SKIP_KUBO=1`。
- 想确认是不是网络层: `docker exec … bolloon network status`。

### 7.6 容器里没有 electron / 没有浏览器

`bolloon` (不带参数) 会走"Electron 缺失 → 自动降级 Web"; `openBrowser` 调 `xdg-open`
在 slim 镜像里不存在, 只打一行错误、**不影响服务**。给用户的地址是
`http://<宿主机>:54188` (或反代域名)。

### 7.7 内存/磁盘

`docker stats bolloon-agent` 看实时占用; compose 里 `logging` 已限到 `10m × 3` 文件
(agent 日志量很大, 不限会把宿主磁盘写满)。`docker system prune` 别加 `--volumes` —— 那会删数据卷 (含私钥)。

---

## 8. 验收记录 (真跑, 不是静态检查)

<!--EVIDENCE-->

---

## 9. 如实留下的保留 (本页口径的边界)

<!--RESERVED-->

---

## 10. 参考

- [Dockerfile](../../Dockerfile) · [docker-compose.yml](../../docker-compose.yml) · [.dockerignore](../../.dockerignore) · [.env.example](../../.env.example)
- 端口/绑定: [src/index.ts](../../src/index.ts) 的 `mode === 'web'` 分支 · [src/web/server.ts](../../src/web/server.ts) 的 `healthCheck` 与 `BOLLOON_HOST` 处理
- 状态目录契约: `BOLLOON_HOME` > `$HOME/.bolloon`
- 邻居页: [runtime-profile.md](./runtime-profile.md)(校验脚本矩阵) · [current-status.md](./current-status.md)(线上状态)
