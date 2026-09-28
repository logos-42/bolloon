# Bolloon Agent — 容器镜像 (多阶段构建)
#
# 设计要点 (先说清, 免得读的人只能靠猜):
#   · 基础镜像钉到 `node:22.22.3-bookworm-slim`:
#       - Node 22 是本包 CI/发布实测的 LTS 线;
#       - 选 **bookworm (glibc)** 而不是 alpine (musl), 因为生产依赖里有预编译原生模块
#         (`sodium-native` / `@number0/iroh-*` / `rolldown` / `classic-level`), 它们的
#         `prebuilds/*.node` 是按 glibc 编的; 换 musl 要么跑不通, 要么得在镜像里现装编译器;
#       - `-slim` 而不是全量 bookworm: 不装 perl/python-dev/man-pages 那几百 MB 构建工具。
#   · 构建阶段装**全部**依赖 (devDependencies 里的 typescript/esbuild/tsx 就是构建工具本身),
#     运行阶段只装生产依赖, 且不留 `src/`。
#   · 容器里以**非 root 用户 `bolloon` (uid/gid 1001)** 运行。
#   · 状态目录 `${BOLLOON_HOME}` → `/home/bolloon/.bolloon`, 声明成数据卷。
#   · 入口是 `dist/cli-entry.js`: 不带参数 = 默认模式 (Electron 缺失时自动降级为 Web),
#     `--web` = Web UI, `--version` / `doctor` / `model list` 等子命令照常可用。
#   · 两处 `npm ci` 共用**同一个 BuildKit 缓存** (`id=bolloon-npm`), 并加 `--prefer-offline`:
#     lockfile 已经钉死了版本与 integrity, 所以"命中本地缓存就不必再问 registry"是安全的;
#     在慢网/离线环境下这是能不能构建出来的差别 (3.1GB 的 npm 缓存可复用)。缓存是
#     `--mount=type=cache`, **不进镜像层**, 所以不占镜像体积。
#
# 注意: 本文件**不用** `# syntax=docker/dockerfile:` 指令 —— 那会强制在构建时再从 registry
#   拉一个 frontend 镜像; 这里用到的 `RUN --mount=type=cache` / `--mount=from=` 由 Docker 自带
#   BuildKit frontend 原生支持, 少一次网络依赖。
#
# 怎么启 (详见 docs/wiki/docker-deployment.md):
#   docker build -t bolloon-agent:0.5.1 .
#   docker run --rm -p 127.0.0.1:54188:54188 -v bolloon-data:/home/bolloon/.bolloon bolloon-agent:0.5.1 --web
#   # 或
#   docker compose up -d                            # Web 服务
#   docker compose run --rm bolloon-cli --version    # 一次性 CLI
#
# ⚠️ 本文件**不放任何密钥**: API key 一律走运行时环境变量或挂载的配置文件
#    (`/home/bolloon/.bolloon/llm-config.json`), 见 `.env.example` 与 compose 里的说明。

# ══════════════════════════════════════════════════════════════════════
# 阶段 1/2 · build —— 装依赖 + 编译 (tsc → dist, workspace → dist, web client)
# ══════════════════════════════════════════════════════════════════════
FROM node:22.22.3-bookworm-slim AS build

WORKDIR /app

ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false

# 先只放「依赖清单 + postinstall 脚本」:
#   `npm ci` 末尾会真跑 `postinstall` (`node scripts/postinstall.js`), 该文件必须已经就位,
#   否则 node 以 "Cannot find module" 退出 ⇒ npm ci 直接失败。
COPY package.json package-lock.json ./
COPY src/constraint-runtime/package.json src/constraint-runtime/
COPY scripts/postinstall.js scripts/postinstall.js

# `--legacy-peer-deps` 是**量出来的**, 不是抄来的习惯:
#   本仓 devDependencies 是 `typescript@^7.0.2` (盘上装的是 7.0.2), 而生产依赖
#   `@rayhanadev/iroh@0.1.1` 声明 `peer typescript@^5` ⇒ npm 10 (node:22 镜像自带) 的
#   ERESOLVE 直接拒装 (`npm ci` exit 1, 报 "Could not resolve dependency: peer typescript@\"^5\""),
#   构建在第一步就死。而本机 node_modules 里**并存的正是这两个版本** (7.0.2 + 要求 ^5 的 iroh)
#   ⇒ 这个项目本来就是按"忽略 peer 冲突"装出来的, `--legacy-peer-deps` 只是如实复现它。
#   复核办法: `node -p "require('./node_modules/typescript/package.json').version"` (7.0.2)
#   与 `node -p "JSON.stringify(require('./node_modules/@rayhanadev/iroh/package.json').peerDependencies)"`。
RUN --mount=type=cache,id=bolloon-npm,target=/root/.npm \
    npm ci --prefer-offline --legacy-peer-deps

# 自检: typescript@7 的编译器是**平台二进制** (`@typescript/typescript-<os>-<arch>`), 它挂在
#   `typescript` 的 `optionalDependencies` 里 —— 而 npm 对**可选依赖下载失败是静默跳过**
#   (只在几十步之后由 tsc 抛 "Unable to resolve @typescript/typescript-linux-x64", 极难归因)。
#   这里把"缺平台二进制"提前成一句能读懂的失败, 并给出补救办法。
RUN node -e "const fs=require('fs'),path=require('path');const nm=path.dirname(path.dirname(require.resolve('typescript/package.json')));const want=path.join(nm,'@typescript','typescript-'+process.platform+'-'+process.arch);const tv=require('typescript/package.json').version;if(fs.existsSync(want)){console.log('[build] TS 平台二进制 OK: '+want)}else{console.error('[build] 缺 '+want+' (typescript@'+tv+') —— npm 对可选依赖的下载失败是静默跳过; 补救: 在能下它的机器上 `npm cache add '+(path.basename(want))+'@'+tv+'` 后重跑, 或换条网络重跑。');process.exit(1)}"

# 再放源码与构建脚本 —— 改源码不会让上面那层重装依赖
COPY tsconfig.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/

# 三步编译, 顺序不能换:
#   ① `npm run build` (根脚本 = `--workspaces --if-present`) → 先建 @bolloon/constraint-runtime,
#      主 tsconfig 的 exclude 里有 `src/constraint-runtime`, 主 tsc **不会**编它;
#   ② `build:main` = `tsc` + `copy-constraint-runtime.mjs` (把 workspace 产物搬到
#      `dist/constraint-runtime`, pi-sdk 的工具用相对路径 import 它);
#   ③ `build:web` = `src/web/client.ts` → `dist/web/client.js` (+ index.html/explorer 等静态页)。
RUN npm run build --workspaces --if-present \
 && npm run build:main \
 && npm run build:web

# 构建自检: 关键产物缺一个就当场红掉, 不把半成品交给下一阶段
RUN node -e "const fs=require('fs');const need=['dist/cli-entry.js','dist/index.js','dist/web/server.js','dist/web/client.js','dist/web/index.html','dist/constraint-runtime/index.js'];const miss=need.filter(f=>!fs.existsSync(f));if(miss.length){console.error('[build] 缺少产物: '+miss.join(', '));process.exit(1)}console.log('[build] 产物自检 OK: '+need.length+' 个入口都在')"

# ══════════════════════════════════════════════════════════════════════
# 阶段 2/2 · runtime —— 只留生产依赖 + dist + 非 root 运行
# ══════════════════════════════════════════════════════════════════════
FROM node:22.22.3-bookworm-slim AS runtime

# NODE_ENV=production: 生产语义 (若干库据此关掉调试分支);
# PORT / BOLLOON_HOME: 端口与状态目录 (BOLLOON_HOME 的契约见源码: `BOLLOON_HOME` 优先,
#   否则 `$HOME/.bolloon` —— 这里显式钉死, 免得两者不一致);
# BOLLOON_HOST=0.0.0.0: **必须**。Web 服务默认只 bind 127.0.0.1 (源码里
#   `BOLLOON_HOST ?? '127.0.0.1'`), 那样容器外根本连不上。对外暴露面由 `-p` / compose
#   的 `ports:` 决定 (默认只发布到宿主机回环, 见 docker-compose.yml)。
ENV NODE_ENV=production \
    PORT=54188 \
    BOLLOON_HOME=/home/bolloon/.bolloon \
    BOLLOON_HOST=0.0.0.0

# 非 root 用户 (uid/gid 1001) + 状态目录
#   `.bolloon` 权限 0700: 里面会有身份私钥 / llm-config.json / 会话。
RUN groupadd --gid 1001 bolloon \
 && useradd --uid 1001 --gid 1001 --create-home --home-dir /home/bolloon --shell /usr/sbin/nologin bolloon \
 && install -d -o bolloon -g bolloon -m 0700 /home/bolloon/.bolloon

WORKDIR /app

# ⚠️ 这个 COPY 不只是搬文件, 它还是**串行化开关**:
#   BuildKit 默认并行跑互不依赖的阶段 ⇒ 本阶段的 apt 会和 build 阶段的 `npm ci` (约 900MB)
#   抢同一条出口, apt 的连接被挤掉 (本机实测: 单个探针构建里 apt 源可达, 并发跑时索引全部 Ign)。
#   本阶段从这里开始依赖 build 阶段的产物 ⇒ 强制定序: build 全部做完 → 才装系统包 → 才装生产依赖。
#   在宽带宽的 CI 上这一步几乎不花时间, 所以按默认保留 (而不是靠"关掉并行"的特殊参数)。
COPY --from=build --chown=bolloon:bolloon /app/dist ./dist

# git / python3: Bolloon 自己的能力矩阵会真调它们 (git 委派、`scripts/*.py` 一类校验门、
#   `bolloon runtime` 的运行时报)。不装的话容器能起, 但 `bolloon runtime` 会如实报
#   「安装未完成」, agent 的 git 类工具也会失败 —— 宁可多约 55MB 也不给一个半残的容器。
#
# APT_MIRROR 是**可选**构建参数 (默认空 = 用镜像自带的上游 deb.debian.org):
#   不写死默认值, 因为镜像自带源对大多数网络是对的; 只在"上游源不可达"时按需替换
#   (本机实测过: 构建沙箱里 deb.debian.org 的 `Packages` 索引报
#   `Connection failed [IP: 198.18.18.74 80]`):
#     docker build --build-arg APT_MIRROR=mirrors.cloud.tencent.com -t bolloon-agent:0.5.1 .
#   注意 sources 是 deb822 格式 (`/etc/apt/sources.list.d/debian.sources`), 只改写主机名,
#   路径 `/debian` 与 `/debian-security` 不动。
#
# 外面那圈 5 次退避重试是给窄网备的: **装不上仍然让构建红** (不降级成"没有就算了"),
# 只是把瞬时抖动和并发占道挡掉。
ARG APT_MIRROR=""
RUN set -eux; \
    if [ -n "$APT_MIRROR" ]; then \
      for f in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do \
        if [ -f "$f" ]; then sed -i "s|deb\.debian\.org|${APT_MIRROR}|g; s|security\.debian\.org|${APT_MIRROR}|g" "$f"; fi; \
      done; \
      echo "[apt] 已切源到 ${APT_MIRROR}:"; grep -h "^URIs:" /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
    fi; \
    ok=0; \
    for i in 1 2 3 4 5; do \
      if apt-get -o Acquire::Retries=3 update \
         && apt-get install -y --no-install-recommends git python3 ca-certificates; then ok=1; break; fi; \
      echo "[apt] 第 $i 次失败, 退避 15s 后重试 (窄网/占道下常见)"; sleep 15; \
    done; \
    [ "$ok" = "1" ] || { echo "[apt] git/python3 装不上: 用 --build-arg APT_MIRROR=<镜像站> 换源重试"; exit 1; }; \
    rm -rf /var/lib/apt/lists/*

# 只装生产依赖。
#   这一步**以 root 跑**: ① 为了能用上面那个共享 npm 缓存 (非 root 写不进去);
#   ② node_modules 归 root 但默认 755/644 ⇒ 运行用户 bolloon 只读即可, 不需要昂贵的
#      `chown -R node_modules` (那会把整份 node_modules 复制成新的一层, 镜像直接翻倍)。
#   装完只 chown 家目录 (几个文件), 并把 /app 自身交给 bolloon (运行时若往 cwd 落临时文件不会 EACCES)。
COPY package.json package-lock.json ./
COPY src/constraint-runtime/package.json src/constraint-runtime/
COPY scripts/postinstall.js scripts/postinstall.js
RUN --mount=type=cache,id=bolloon-npm,target=/root/.npm \
    HOME=/home/bolloon npm ci --omit=dev --prefer-offline --legacy-peer-deps \
 && rm -rf node_modules/@bolloon/constraint-runtime src \
 && chown -R bolloon:bolloon /home/bolloon \
 && chown bolloon:bolloon /app

# 运行阶段的假 workspace 目录已删 → `@bolloon/constraint-runtime` 的符号链接会悬空,
# 必须换成**构建产物** (pi-sdk / constraint-layer 等按**裸包名** import 它,
# 解析不到就整个启动失败)。
COPY --from=build --chown=bolloon:bolloon /app/src/constraint-runtime/dist ./node_modules/@bolloon/constraint-runtime/dist
COPY --from=build --chown=bolloon:bolloon /app/src/constraint-runtime/package.json ./node_modules/@bolloon/constraint-runtime/package.json

# (dist 已经在本阶段开头拷进来了 —— 那一步同时充当"等 build 阶段做完"的串行化开关)

# 状态卷: 配置 / 身份 / 会话 / 日志 / orbitdb 全在这里 —— **含私钥, 永不入镜像**
VOLUME ["/home/bolloon/.bolloon"]

EXPOSE 54188

# 真探针 (不是永远 200 的假检查): 同时要求
#   ① `GET /api/health` 返回 200 **且** JSON 里 `ok:true`  (src/web/server.ts 的 healthCheck)
#   ② `GET /` 返回 200                                    (dist/web/index.html 真被服务)
# 缺任一 ⇒ unhealthy。于是「进程活着但 Web 面没起来 / 前端没编进镜像」都会判死。
# 它**不**断言 P2P / IPFS / LLM 连通性 —— 那几项设计上就允许降级, 拿它们当存活判据是假红。
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=4 \
  CMD node -e "const p=process.env.PORT||'54188';const bail=setTimeout(()=>{console.log('unhealthy: probe timeout');process.exit(1)},9000);const j=(u)=>fetch('http://127.0.0.1:'+p+u,{signal:AbortSignal.timeout(4000)});Promise.all([j('/api/health').then(r=>r.json().then(v=>({c:r.status,ok:!!(v&&v.ok)})).catch(()=>({c:r.status,ok:false}))),j('/').then(r=>({c:r.status,ok:r.ok}))]).then(([h,i])=>{clearTimeout(bail);const ok=h.ok&&h.c===200&&i.ok&&i.c===200;console.log((ok?'healthy':'unhealthy')+' /api/health='+h.c+' ok='+h.ok+' /= '+i.c);process.exit(ok?0:1)}).catch(e=>{clearTimeout(bail);console.log('unhealthy: '+e.message);process.exit(1)})"

USER bolloon

# 入口 = 包 bin 指向的同一个文件。不带参数 = 默认模式 (容器里没有 electron ⇒ 自动降级 Web),
# 显式要 Web 就 `--web`。
ENTRYPOINT ["node", "/app/dist/cli-entry.js"]
CMD ["--web"]
