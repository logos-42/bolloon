#!/usr/bin/env node
/**
 * Bolloon — EVM 本地部署 + 部署清单 + 链上真读数验证 + 真交易闭环
 * =========================================================================
 * 用途: 在本地开发链 (anvil / hardhat node, chainId 31337) 或 (显式放行时) 测试网上真部署
 *   AgentEscrow (v2) + AgentTreasury, 生成 deployment manifest, 用链上真读数验证, 并跑
 *   createEscrowV2 → submitProofV2 → releaseV2 的真交易闭环 + F2 门槛断言。
 *
 * 两种 token 模式 (escrow/treasury 的 paymentAsset):
 *   - **mock 模式** (默认): 自己部署一个 MockERC20 (USDC 替身, decimals = 6),
 *     mint 给 deployer, 写进 manifest + ABI 目录。
 *   - **external 模式** (`TOKEN_ADDRESS` 已设置): **不部署 MockERC20**, 直接用该地址
 *     作为 paymentAsset —— 真网官方 USDC (base-sepolia
 *     `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, decimals 6) 就靠这个入口。
 *     规则: 链上真读 decimals()/symbol()/name(); decimals ≠ 6 直接**大声拒编**;
 *     **不 mint、不改它的任何状态**(唯一例外: E2E 需要 buyer 授权时才会发 approve,
 *     且 allowance 已足够时连 approve 都不发); manifest 里不出现 MockERC20,
 *     改记 `externalToken` 块 (address/decimals/symbol/source="external");
 *     ABI 目录也不写 MockERC20.json。
 *
 * 设计约束 (为什么长这样):
 *   - **零真实钱包**: 默认部署账户从 anvil 的公开开发助记符派生
 *     ("test test ... junk" 是 anvil 默认值, 公开文档可见, 非真实私钥)。
 *     绝不读取 ~/.hermes/wallets/。要换账户就传 DEPLOYER_PRIVATE_KEY 环境变量。
 *   - **零联网**: 默认 RPC = http://127.0.0.1:8545; 且除非显式
 *     ALLOW_NON_LOCAL=1, 脚本对非 31337 的 chainId 直接拒绝执行。
 *   - **幂等 / 可重入**: manifest 落在 contracts/deployments/<network>.json。
 *     重跑时若 chainId 一致 + 每个合约地址上 eth_getCode 非空 +
 *     **当前编译产物的 creation bytecode (immutable 占位槽清零后) 的 keccak256
 *     与 manifest 记录的 creationBytecodeHash 逐字一致** +
 *     链上 runtime bytecode 的 keccak256 与 manifest 记录一致 +
 *     构造参数一致 → 复用地址; 否则只重部署失效的那个 (并打印原因)。
 *     FORCE_REDEPLOY=1 强制全部重部署。
 *     闭环测试用「每次运行唯一」的 taskKey, 所以重跑不会撞 "task exists"。
 *
 * 环境变量:
 *   RPC_URL                默认 http://127.0.0.1:8545
 *   DEPLOYER_PRIVATE_KEY   默认 = anvil 开发账户 #0 (派生自公开助记符)
 *   AGENT_PRIVATE_KEY      默认 = anvil 开发账户 #1
 *   NETWORK_NAME           默认 localhost
 *   TOKEN_ADDRESS          已设置 = external 模式: 用它当 paymentAsset, 不部署 MockERC20
 *   FORCE_REDEPLOY         1 = 忽略已有 manifest 全部重部署
 *   ALLOW_NON_LOCAL        1 = 允许非 31337 chainId (默认禁止, 防误连主网)
 *   SKIP_E2E               1 = 跳过真交易闭环
 *
 * 用法:
 *   # 终端 A (macOS 上 foundry 缺 libusb 时要带 DYLD_LIBRARY_PATH)
 *   DYLD_LIBRARY_PATH=~/.local/lib ~/.foundry/bin/anvil --chain-id 31337
 *   # 终端 B (mock 模式)
 *   cd contracts/evm && npx hardhat compile && node scripts/deploy.js
 *   # 终端 B (external 模式: 用已有 USDC 地址)
 *   cd contracts/evm && npx hardhat compile && \
 *     TOKEN_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e NETWORK_NAME=base-sepolia \
 *     RPC_URL=https://sepolia.base.org ALLOW_NON_LOCAL=1 node scripts/deploy.js
 *
 * 产出:
 *   contracts/deployments/<network>.json      deployment manifest
 *   contracts/deployments/abis/*.json         各合约 ABI (manifest 里记路径)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

// ── 路径 ────────────────────────────────────────────────────────────────────
const EVM_DIR = path.resolve(__dirname, ".."); // contracts/evm
const DEPLOYMENTS_DIR = path.resolve(EVM_DIR, "..", "deployments"); // contracts/deployments
const ABIS_DIR = path.join(DEPLOYMENTS_DIR, "abis");
const ARTIFACTS_DIR = path.join(EVM_DIR, "artifacts", "contracts");

// ── 公开的开发助记符 (anvil 默认, 非真实钱包; 见脚本头注释) ─────────────────
const DEV_MNEMONIC = "test test test test test test test test test test test junk";
const LOCAL_CHAIN_ID = 31337n;

// ── 部署参数 ───────────────────────────────────────────────────────────────
const TOKEN_NAME = "USDC"; // MockERC20 的 name/symbol 都用这个
const TOKEN_DECIMALS = 6; // USDC 替身必须 6 位 (external 模式下: 外部 token 必须 6 位, 否则拒编)
const RELEASE_TIMEOUT = 7 * 86400; // AgentEscrow 构造参数
const TREASURY_DAILY_LIMIT = ethers.parseUnits("100000", 6); // AgentTreasury 构造参数
const TOKEN_SUPPLY = ethers.parseUnits("10000000", 6); // mint 给 deployer 的初始量 (仅 mock 模式)

// external 模式用的最小 ERC20 ABI —— **故意不含 mint**: 外部 token 不许被本脚本改状态,
// 万一有人误调 mint 会直接 "no matching function" 抛错, 而不是发出去一笔真交易。
const EXTERNAL_ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
];

// ── 冻结 hash 口径 (与 AgentEscrow.sol / MODEL_FREEZE.md §4 逐字一致) ──────
const TAG_TASK = ethers.encodeBytes32String("bolloon.task.v1");
const ABICODER = ethers.AbiCoder.defaultAbiCoder();

const log = (...a) => console.log(...a);
const hr = (t) => log(`\n${"─".repeat(72)}\n${t}\n${"─".repeat(72)}`);
const ok = (b) => (b ? "✅" : "❌");

/** 大声拒编: 打印一眼能看到的错误块 + 可行提示, 然后中止 (exit 1) */
function fatal(msg, hints = []) {
  log(`\n${"█".repeat(72)}`);
  log(`❌ 中止 (拒编): ${msg}`);
  for (const h of hints) log(`   → ${h}`);
  log("█".repeat(72));
  const e = new Error(msg);
  e.loud = true;
  e.hints = hints;
  throw e;
}

// ══════════════════════════════════════════════════════════════════════════
// 小工具
// ══════════════════════════════════════════════════════════════════════════

function loadArtifact(contractFileRelPath, name) {
  const p = path.join(ARTIFACTS_DIR, contractFileRelPath, `${name}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(
      `找不到 artifact: ${p}\n先跑: cd contracts/evm && npx hardhat compile`
    );
  }
  const a = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!a.abi || !a.bytecode) throw new Error(`artifact 不完整: ${p}`);
  return a;
}

/**
 * build-info 索引 + 按 artifact 逐字匹配。
 *
 * hardhat 的 artifact JSON 不带 solc 的 immutableReferences, 只有 build-info 里有。
 * 但 artifacts/build-info/ 下**会同时留着多次编译** (源码一改就多一份), 它们的
 * immutable 槽位偏移完全不同: 用错那份会把真实字节当槽位清零 → keccak 假不符 →
 * 无谓重部署, 甚至假相符。所以这里不"读到哪份算哪份", 而是拿 artifact 的
 * creation/runtime bytecode 去 build-info 里逐字匹配, 挑出真正产出它的那一份。
 */
function loadBuildInfo() {
  const dir = path.join(EVM_DIR, "artifacts", "build-info");
  const entries = [];
  if (!fs.existsSync(dir)) return entries;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      continue;
    }
    if (!j.output || !j.output.contracts) continue;
    entries.push({ file: f, json: j });
  }
  return entries;
}

const hex0x = (h) => (h ? (h.startsWith("0x") ? h : "0x" + h).toLowerCase() : null);

/** 找出真正产出这个 artifact 的 build-info 条目 (含该合约的 immutableReferences) */
function buildInfoFor(entries, name, artifact) {
  const wantCreation = hex0x(artifact.bytecode);
  const wantRuntime = hex0x(artifact.deployedBytecode);
  let fallback = null;
  for (const e of entries) {
    const cs = e.json.output.contracts || {};
    for (const src of Object.keys(cs)) {
      const c = cs[src][name];
      if (!c || !c.evm) continue;
      const hit = {
        file: e.file,
        source: src,
        creation: hex0x(c.evm.bytecode && c.evm.bytecode.object),
        runtime: hex0x(c.evm.deployedBytecode && c.evm.deployedBytecode.object),
        immutables: (c.evm.deployedBytecode && c.evm.deployedBytecode.immutableReferences) || {},
        build: {
          solcLongVersion: e.json.solcLongVersion,
          optimizer: (e.json.input && e.json.input.settings && e.json.input.settings.optimizer) || null,
          evmVersion: (e.json.input && e.json.input.settings && e.json.input.settings.evmVersion) || null,
        },
      };
      if (hit.creation === wantCreation || hit.runtime === wantRuntime) return hit;
      if (!fallback) fallback = hit;
    }
  }
  return fallback; // 一份都对不上 (artifact 被手改?) — 退回第一份, 调用方打告警
}

/** 部署后: 把 immutable 占位槽清零, 好和链上真实 code 逐字节对比 */
function neutralizeImmutables(code, immutableReferences) {
  const refs = immutableReferences || {};
  const keys = Object.keys(refs);
  if (keys.length === 0) return { code, zeroed: 0, slots: 0 };
  const buf = Buffer.from(code.slice(2), "hex");
  let zeroed = 0;
  let slots = 0;
  for (const k of keys) {
    for (const r of refs[k]) {
      buf.fill(0, r.start, r.start + r.length);
      zeroed += r.length;
      slots += 1;
    }
  }
  return { code: "0x" + buf.toString("hex"), zeroed, slots };
}

/**
 * 计算「当前编译产物」的 creation bytecode 规范化 keccak256 —— 幂等复用判定的证据。
 *
 * 为什么需要规范化: solc 把 immutable 值写进的是「create 字节码末尾嵌着的那段
 * runtime」, 所以 artifact 的 creation bytecode 里这些槽位应当是零 —— 但"应当是"
 * 不是证据。这里显式定位嵌入的 runtime 段 (长度 = cb.length - rb.length, 首字节起
 * 逐字相等), 把对应字节清零后再取 hash; 定位不到就退回原样 hash 并标注 normalized=false,
 * 绝不用"猜"的位置去改字节。
 *
 * 幂等判定只比 artifact↔artifact (编译↔编译), 不比链上 —— 链上 runtime hash 与
 * manifest 记录一致是自证的 (manifest 记的就是链上读到的值), 永远发现不了"源码改了"。
 */
function creationBytecodeHash(artifact, immutableReferences) {
  const creation = artifact.bytecode;
  const plainHash = ethers.keccak256(creation);
  const refs = immutableReferences || {};
  const keys = Object.keys(refs);
  if (keys.length === 0) {
    return {
      hash: plainHash,
      normalized: false,
      note: "该合约无 immutable 槽, 无需规范化",
      embeddedRuntimeOffset: null,
    };
  }
  const { code: runtimeZeroed } = neutralizeImmutables(artifact.deployedBytecode, refs);
  const cb = Buffer.from(creation.slice(2), "hex");
  const rb = Buffer.from(runtimeZeroed.slice(2), "hex");
  const tail = cb.length - rb.length;
  const embeddedRuntimeOffset = tail >= 0 && cb.subarray(tail).equals(rb) ? tail : null;
  if (embeddedRuntimeOffset === null) {
    return {
      hash: plainHash,
      normalized: false,
      note: "creation 里定位不到嵌入的 runtime 段 → 退回原样 hash (未改任何字节)",
      embeddedRuntimeOffset: null,
    };
  }
  let zeroed = 0;
  for (const k of keys) {
    for (const r of refs[k]) {
      cb.fill(0, embeddedRuntimeOffset + r.start, embeddedRuntimeOffset + r.start + r.length);
      zeroed += r.length;
    }
  }
  return {
    hash: ethers.keccak256("0x" + cb.toString("hex")),
    normalized: true,
    note: `creation 内嵌 runtime @offset=${embeddedRuntimeOffset}, 清零 ${zeroed} 字节`,
    embeddedRuntimeOffset,
  };
}

/** JSON 安全化: BigInt → 十进制字符串 (manifest 要能被人和别的工具读) */
function plain(v) {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = plain(v[k]);
    return o;
  }
  return v;
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(plain(obj), null, 2) + "\n", "utf8");
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function selectorOf(iface, fnSig) {
  const f = iface.getFunction(fnSig);
  if (!f) throw new Error(`ABI 里没有函数: ${fnSig}`);
  return f.selector; // 0x + 8 hex
}

function topic0Of(iface, evSig) {
  const e = iface.getEvent(evSig);
  if (!e) throw new Error(`ABI 里没有事件: ${evSig}`);
  return e.topicHash; // 0x + 64 hex
}

// ══════════════════════════════════════════════════════════════════════════
// main
// ══════════════════════════════════════════════════════════════════════════

async function main() {
  const failures = [];
  const assert = (label, cond, detail) => {
    log(`  ${ok(cond)} ${label}${detail ? "  — " + detail : ""}`);
    if (!cond) failures.push(label);
    return cond;
  };

  const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
  const NETWORK_NAME = process.env.NETWORK_NAME || "localhost";
  const MANIFEST_PATH = path.join(DEPLOYMENTS_DIR, `${NETWORK_NAME}.json`);

  // ── token 模式: TOKEN_ADDRESS 已设置 → external (不部署 MockERC20) ─────────
  const TOKEN_ADDRESS_RAW = (process.env.TOKEN_ADDRESS || "").trim();
  const externalMode = TOKEN_ADDRESS_RAW !== "";

  // ── 账户 (默认 anvil 开发账户, 非真实钱包) ────────────────────────────────
  const mnemonic = ethers.Mnemonic.fromPhrase(DEV_MNEMONIC);
  const dflt0 = ethers.HDNodeWallet.fromMnemonic(mnemonic, "m/44'/60'/0'/0/0");
  const dflt1 = ethers.HDNodeWallet.fromMnemonic(mnemonic, "m/44'/60'/0'/0/1");
  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY || dflt0.privateKey;
  const agentKey = process.env.AGENT_PRIVATE_KEY || dflt1.privateKey;

  const provider = new ethers.JsonRpcProvider(RPC_URL, null, {
    // 关键: ethers v6 默认对 eth_getTransactionCount / eth_blockNumber 做 250ms 缓存。
    // 本地链出块是瞬时的, 缓存会导致第 2 笔交易拿旧 nonce → "nonce has already been used"。
    // cacheTimeout: -1 = 关闭缓存, 让所有读数/序列号都是真实即时值 (本脚本要的就是"真读数")。
    cacheTimeout: -1,
  });
  const deployer = new ethers.Wallet(deployerKey, provider);
  const agent = new ethers.Wallet(agentKey, provider);

  hr("① 连接本地链");
  let net;
  try {
    net = await provider.getNetwork();
  } catch (e) {
    throw new Error(`连不上 RPC ${RPC_URL}: ${e.message}`);
  }
  const chainId = net.chainId;
  log(`  RPC_URL     : ${RPC_URL}`);
  log(`  chainId     : ${chainId}`);
  log(`  latestBlock : ${await provider.getBlockNumber()}`);

  if (chainId !== LOCAL_CHAIN_ID && process.env.ALLOW_NON_LOCAL !== "1") {
    throw new Error(
      `chainId=${chainId} 不是本地开发链 31337 — 拒绝部署 ` +
        `(要强行继续: ALLOW_NON_LOCAL=1, 后果自负)`
    );
  }

  log(`  deployer    : ${deployer.address}`);
  log(`  agent       : ${agent.address}`);
  const bal = await provider.getBalance(deployer.address);
  log(`  deployer bal: ${ethers.formatEther(bal)} ETH`);
  if (bal === 0n) throw new Error("deployer 余额为 0, 无法付 gas");

  // ── artifact ─────────────────────────────────────────────────────────────
  // external 模式不部署 MockERC20 → 也不加载它的 artifact (缺了不该让它挡住部署)
  const art = {
    AgentEscrow: loadArtifact("AgentEscrow.sol", "AgentEscrow"),
    AgentTreasury: loadArtifact("AgentTreasury.sol", "AgentTreasury"),
    ...(externalMode
      ? {}
      : { MockERC20: loadArtifact(path.join("mocks", "MockERC20.sol"), "MockERC20") }),
  };

  // build-info: 按 artifact 逐字匹配 (仓库里会堆多次编译的 build-info, 槽位偏移不同)
  const buildInfos = loadBuildInfo();
  const compiled = {}; // name → { refs, creation, build, buildInfoFile, artifactMatched }
  for (const k of Object.keys(art)) {
    const bi = buildInfoFor(buildInfos, k, art[k]);
    const refs = bi ? bi.immutables : {};
    compiled[k] = {
      refs,
      creation: creationBytecodeHash(art[k], refs),
      build: bi ? bi.build : null,
      buildInfoFile: bi ? bi.file : null,
      artifactMatched: !!bi && bi.creation === hex0x(art[k].bytecode),
    };
  }
  const solidity = compiled.AgentEscrow.build; // manifest.build 的溯源口径 (主合约)
  log(
    `  编译产物 : solc ${solidity?.solcLongVersion}  optimizer=${JSON.stringify(solidity?.optimizer)}  evm=${solidity?.evmVersion}`
  );
  log(`  token 模式: ${externalMode ? `external (TOKEN_ADDRESS=${TOKEN_ADDRESS_RAW})` : "mock (自部署 MockERC20)"}`);
  for (const k of Object.keys(compiled)) {
    const c = compiled[k];
    const slots = Object.values(c.refs).flat().length;
    log(
      `  ${k.padEnd(14)} creationBytecodeHash=${c.creation.hash.slice(0, 18)}…  ` +
        `immutable 槽=${slots}×32B  build-info=${c.buildInfoFile || "n/a"}`
    );
    log(`                 ↳ ${c.creation.note}`);
    if (!c.artifactMatched) {
      log(
        `                 ⚠ build-info 里没有与该 artifact 逐字匹配的编译输出 ` +
          `(artifact 被手改过?) — immutable 槽位偏移不可信, hash 比对可能假不符`
      );
    }
  }

  // ── 已有 manifest? (幂等判断依据) ────────────────────────────────────────
  const prev = process.env.FORCE_REDEPLOY === "1" ? null : readJsonSafe(MANIFEST_PATH);

  /**
   * 判断能否复用 manifest 里的记录 —— 三道都要过:
   *   (1) chainId 一致
   *   (2) **编译产物一致性**: 当前 artifact 的 creation bytecode (immutable 占位槽
   *       清零后) 的 keccak256 与 manifest 记录的 creationBytecodeHash 逐字一致。
   *       这一条是唯一能发现「源码改了/重新编译了」的检查: manifest 里的
   *       bytecodeHash 记的是链上 runtime code —— 拿它去比链上, 是自证 (manifest
   *       记的就是那次从链上读到的值), 永远发现不了源码已改, 于是会一边报「复用」
   *       一边让 provenance 说谎。
   *   (3) 地址上有 code + 链上 runtime code 的 keccak256 与 manifest 记录一致
   *       (地址被换掉 / 链被 reset 的情况) + 构造参数一致 (若给了 expectedArgs)
   */
  async function reusable(name, expectedArgs) {
    if (!prev || !prev.contracts) return null;
    if (BigInt(prev.chainId) !== chainId) return null;
    const rec = prev.contracts.find?.((c) => c.name === name) ||
      (prev.contracts[name] ? { ...prev.contracts[name], name } : null);
    if (!rec || !rec.address) return null;

    // (2) 编译产物 ↔ manifest 的逐字比对
    const curCreation = compiled[name].creation.hash;
    const recCreation =
      typeof rec.creationBytecodeHash === "string" ? rec.creationBytecodeHash.toLowerCase() : null;
    if (!recCreation) {
      log(`  ↻ ${name}: manifest 里没有 creationBytecodeHash, 无法证明复用安全 → 重部署`);
      return null;
    }
    if (curCreation.toLowerCase() !== recCreation) {
      log(`  ↻ bytecodeHash 不符 → 重部署 ${name}`);
      log(`      当前编译产物 (creation, immutable 槽清零): ${curCreation}`);
      log(`      manifest 记录                            : ${recCreation}`);
      return null;
    }

    // (3) 构造参数
    if (expectedArgs) {
      const a = JSON.stringify(rec.constructorArgs ?? null);
      const b = JSON.stringify(plain(expectedArgs)); // BigInt-safe (treasury dailyLimit 是 BigInt)
      if (a !== b) {
        log(`  ↻ ${name}: 构造参数变化 → 重部署`);
        return null;
      }
    }

    // (3) 链上地址与 runtime code
    let code;
    try {
      code = await provider.getCode(rec.address);
    } catch {
      return null;
    }
    if (code === "0x" || code === "0x0") return null;
    const liveHash = ethers.keccak256(code);
    if (rec.bytecodeHash && liveHash.toLowerCase() !== rec.bytecodeHash.toLowerCase()) {
      log(`  ↻ ${name}: 链上 code hash 与 manifest 不符 → 重部署`);
      return null;
    }
    // 复用前必须能对上「复用的一定是当前编译产物」这个事实
    const { code: normalized, slots } = neutralizeImmutables(code, compiled[name].refs);
    const liveNormalized = ethers.keccak256(normalized).toLowerCase();
    const artNormalized = ethers.keccak256(art[name].deployedBytecode).toLowerCase();
    if (liveNormalized !== artNormalized) {
      log(`  ↻ ${name}: 链上 runtime code 与当前编译产物不符 (immutable 清零后) → 重部署`);
      return null;
    }
    log(
      `  ✓ ${name}: creationBytecodeHash 一致 (${curCreation.slice(0, 18)}…)` +
        ` + 链上 runtime code 与编译产物一致 (清零 ${slots} 个 immutable 槽)`
    );
    return rec;
  }

  const deployed = []; // 本次的部署记录 (持久化进 manifest)

  async function deployOrReuse(key, ctorArgs, version, sourceNote) {
    const Factory = new ethers.ContractFactory(art[key].abi, art[key].bytecode, deployer);
    const reuse = await reusable(key, ctorArgs);
    if (reuse) {
      log(`  = ${key} 复用已有部署 ${reuse.address} (tx ${reuse.txHash})`);
      const code = await provider.getCode(reuse.address);
      deployed.push({
        name: key,
        address: reuse.address,
        txHash: reuse.txHash,
        blockNumber: reuse.blockNumber,
        bytecodeHash: ethers.keccak256(code),
        creationBytecodeHash: compiled[key].creation.hash,
        creationBytecodeHashNormalized: compiled[key].creation.normalized,
        constructorArgs: ctorArgs,
        contractVersion: reuse.contractVersion ?? version,
        reused: true,
        ...sourceNote,
      });
      return new ethers.Contract(reuse.address, art[key].abi, deployer);
    }

    const c = await Factory.deploy(...ctorArgs);
    const tx = c.deploymentTransaction();
    const rc = await tx.wait();
    const address = await c.getAddress();
    const code = await provider.getCode(address);
    log(
      `  + ${key} 部署完成\n      address  : ${address}\n      txHash   : ${tx.hash}\n` +
        `      block    : ${rc.blockNumber}\n      gasUsed  : ${rc.gasUsed}\n` +
        `      creationBytecodeHash: ${compiled[key].creation.hash}`
    );
    deployed.push({
      name: key,
      address,
      txHash: tx.hash,
      blockNumber: rc.blockNumber,
      gasUsed: rc.gasUsed.toString(),
      bytecodeHash: ethers.keccak256(code), // 链上 runtime code 的 keccak256
      // 部署字节码: immutable 占位槽清零后的 creation bytecode (幂等复用就比这个)
      creationBytecodeHash: compiled[key].creation.hash,
      creationBytecodeHashNormalized: compiled[key].creation.normalized,
      constructorArgs: ctorArgs,
      contractVersion: version,
      reused: false,
      ...sourceNote,
    });
    return new ethers.Contract(address, art[key].abi, deployer);
  }

  // ══════════════════════════════════════════════════════════════════════
  hr(
    `② 真部署 (${externalMode ? "AgentEscrow v2 / AgentTreasury; token = 外部已有地址" : "MockERC20 / AgentEscrow v2 / AgentTreasury"})`
  );
  // ══════════════════════════════════════════════════════════════════════

  let token;
  let tokenAddr;
  let tokenMeta; // manifest 里的 token 口径 (mock 或 external)
  const externalTokenWrites = []; // 对外部 token 的状态写入台账 (正常情况下为空; E2E approve 会追加)

  if (externalMode) {
    // ── external 模式: 用链上已有的 token; 不部署 MockERC20, 不 mint, 不改它的状态 ──
    try {
      tokenAddr = ethers.getAddress(TOKEN_ADDRESS_RAW);
    } catch {
      fatal(`TOKEN_ADDRESS 不是合法地址: ${TOKEN_ADDRESS_RAW}`, [
        "形如 0x + 40 位十六进制",
        "base-sepolia 官方 USDC: 0x036CbD53842c5426634e7929541eC2318f3dCF7e (decimals 6)",
      ]);
    }
    const extCode = await provider.getCode(tokenAddr);
    if (extCode === "0x" || extCode === "0x0") {
      fatal(`TOKEN_ADDRESS=${tokenAddr} 在 chainId=${chainId} (${RPC_URL}) 上没有合约代码`, [
        "确认地址与链匹配 — USDC 在 base-sepolia 与 base 主网是两个不同地址",
        "确认 RPC_URL 指向的就是你以为是的那条链",
      ]);
    }
    token = new ethers.Contract(tokenAddr, EXTERNAL_ERC20_ABI, deployer);
    let decimals;
    let symbol;
    let name;
    try {
      [decimals, symbol, name] = await Promise.all([
        token.decimals(),
        token.symbol(),
        token.name(),
      ]);
    } catch (e) {
      fatal(
        `读 ${tokenAddr} 的 decimals()/symbol()/name() 失败: ${e.shortMessage || e.message}`,
        [
          "该地址可能不是标准 ERC20 (方法缺失或返回类型不同)",
          "这三次都是 eth_call 只读调用, 脚本没有向它发任何交易",
        ]
      );
    }
    log(`  外部 token (链上真读, 未发任何交易): ${tokenAddr}`);
    log(
      `    codeLength=${(extCode.length - 2) / 2} bytes  decimals=${decimals}  ` +
        `symbol="${symbol}"  name="${name}"`
    );
    if (Number(decimals) !== TOKEN_DECIMALS) {
      fatal(
        `外部 token decimals = ${decimals}, ≠ ${TOKEN_DECIMALS} — 冻结口径要求 6 位 USDC, 拒绝继续`,
        [
          `地址 ${tokenAddr} (symbol="${symbol}") 的 decimals=${decimals}`,
          "AgentEscrow/AgentTreasury 的金额口径按 6 位定 (MODEL_FREEZE.md: token = USDC, decimals = 6)",
          "要支持非 6 位 token 必须先改冻结口径, 不在这里静默接受",
        ]
      );
    }
    tokenMeta = {
      address: tokenAddr,
      decimals: Number(decimals),
      symbol: String(symbol),
      name: String(name),
      source: "external",
    };
  } else {
    const tokenArtifactPath = "contracts/mocks/MockERC20.sol:MockERC20";
    token = await deployOrReuse("MockERC20", [TOKEN_NAME, TOKEN_DECIMALS], "mock-erc20-v1", {
      sourcePath: tokenArtifactPath,
      role: "USDC 替身 (decimals=6)",
    });
    tokenAddr = await token.getAddress();
    tokenMeta = {
      address: tokenAddr,
      decimals: Number(await token.decimals()),
      symbol: String(await token.symbol()),
      name: String(await token.name()),
      source: "mock",
    };
  }

  const escrow = await deployOrReuse("AgentEscrow", [tokenAddr, RELEASE_TIMEOUT], "1", {
    sourcePath: "contracts/AgentEscrow.sol:AgentEscrow",
    role: "Agent 服务托管 / 链上结算 (v1 legacy + v2)",
  });
  const escrowAddr = await escrow.getAddress();

  const treasury = await deployOrReuse("AgentTreasury", [tokenAddr, TREASURY_DAILY_LIMIT], "1", {
    sourcePath: "contracts/AgentTreasury.sol:AgentTreasury",
    role: "协议资金池 (分配权重 / 日限额 / 两段式所有权)",
  });
  const treasuryAddr = await treasury.getAddress();

  log(`\n  token=${tokenAddr}  escrow=${escrowAddr}  treasury=${treasuryAddr}`);

  // ══════════════════════════════════════════════════════════════════════
  hr("③ 链上真读数验证 (eth_getCode / decimals / 部署区块 / selector / topic0)");
  // ══════════════════════════════════════════════════════════════════════

  const escrowIface = new ethers.Interface(art.AgentEscrow.abi);
  const codeChecks = [];

  for (const rec of deployed) {
    const code = await provider.getCode(rec.address);
    const nonEmpty = code !== "0x" && code.length > 2;
    // 与编译产物比对: immutable 占位槽清零后应逐字节一致
    const a = art[rec.name];
    const { code: normalized, slots } = neutralizeImmutables(code, compiled[rec.name].refs);
    const liveHash = ethers.keccak256(normalized);
    const artHash = ethers.keccak256(a.deployedBytecode);
    const matches = liveHash.toLowerCase() === artHash.toLowerCase();
    codeChecks.push({
      name: rec.name,
      address: rec.address,
      nonEmpty,
      matchesArtifact: matches,
      runtimeBytes: (code.length - 2) / 2,
      immutableSlotsZeroed: slots,
    });
    log(`\n  ${rec.name} @ ${rec.address}`);
    assert("eth_getCode 非空", nonEmpty, `codeLength=${(code.length - 2) / 2} bytes`);
    assert(
      "链上 runtime bytecode == 编译产物 (immutable 占位清零后)",
      matches,
      slots > 0
        ? `清零 ${slots} 个 immutable 槽后 keccak 一致 ${liveHash.slice(0, 18)}…`
        : `keccak=${liveHash.slice(0, 18)}… == artifact=${artHash.slice(0, 18)}…`
    );
    const c = await provider.getCode(rec.address, rec.blockNumber);
    assert("部署区块上已存在 code", c !== "0x", `blockNumber=${rec.blockNumber}`);
  }

  // ── token: 一律以链上真读为准 (两种模式都读, 不信常量) ─────────────────────
  const tokenCode = await provider.getCode(tokenAddr);
  const tokenDecimals = await token.decimals();
  const tokenSymbol = await token.symbol();
  const tokenName = await token.name();
  log(`\n  token @ ${tokenAddr}  (source=${tokenMeta.source})`);
  log(`    symbol=${tokenSymbol}  name=${tokenName}`);
  assert("token eth_getCode 非空", tokenCode !== "0x", `codeLength=${(tokenCode.length - 2) / 2} bytes`);
  assert("token decimals() == 6", tokenDecimals === 6n, `decimals=${tokenDecimals}`);
  assert(
    `manifest token 口径与链上一致 (decimals/symbol/name)`,
    tokenMeta.decimals === Number(tokenDecimals) &&
      tokenMeta.symbol === String(tokenSymbol) &&
      tokenMeta.name === String(tokenName),
    `manifest: ${tokenMeta.decimals}/${tokenMeta.symbol}/${tokenMeta.name}`
  );
  if (externalMode) {
    assert(
      "external 模式: 部署阶段对外部 token 零状态写入 (未 mint / 未 approve)",
      externalTokenWrites.length === 0,
      `writes=[${externalTokenWrites.join(", ")}]`
    );
  }

  // ── 关键函数选择器 ───────────────────────────────────────────────────────
  const V2_FUNCS = [
    "createEscrowV2(bytes32,address,uint256,address,bytes32,bytes32,bytes32,bytes32,uint64,uint32,uint16)",
    "submitProofV2(bytes32,bytes32,bytes32,uint16)",
    "releaseV2(bytes32)",
    "claimAfterTimeoutV2(bytes32)",
  ];
  const bareEscrowHex = (await provider.getCode(escrowAddr)).slice(2).toLowerCase();

  log("\n  AgentEscrow v2 关键函数选择器 (ABI 计算 vs 链上 bytecode 分发器):");
  const selectorReport = [];
  for (const sig of V2_FUNCS) {
    const sel = selectorOf(escrowIface, sig); // 含 0x
    const inAbi = !!escrowIface.getFunction(sig);
    const inCode = bareEscrowHex.includes(sel.slice(2)); // PUSH4 <selector>
    selectorReport.push({ signature: sig, selector: sel, inAbi, inOnChainBytecode: inCode });
    assert(`${sel}  ${sig.split("(")[0]}`, inAbi && inCode, `inABI=${inAbi} inBytecode=${inCode}`);
  }

  // ── 5 个 v2 事件 topic0 ──────────────────────────────────────────────────
  const V2_EVENTS = [
    "EscrowCreatedV2(bytes32,bytes32,address,address,address,uint256,uint256,uint32,uint16,uint32)",
    "ProofSubmittedV2(bytes32,bytes32,bytes32,bytes32,uint16)",
    "ReleasedV2(bytes32,address,uint256,uint8)",
    "RefundedV2(bytes32,address,uint256,bytes32)",
    "DisputedV2(bytes32,address,bytes32)",
  ];
  log("\n  AgentEscrow v2 事件 topic0 (ABI 计算 vs 链上 bytecode 常量):");
  const topicReport = [];
  for (const sig of V2_EVENTS) {
    const t0 = topic0Of(escrowIface, sig);
    const inAbi = !!escrowIface.getEvent(sig);
    const inCode = bareEscrowHex.includes(t0.slice(2)); // PUSH32 <topic0>
    topicReport.push({ signature: sig, topic0: t0, inAbi, inOnChainBytecode: inCode });
    assert(`${t0.slice(0, 18)}…  ${sig.split("(")[0]}`, inAbi, `inABI=${inAbi} inBytecode=${inCode}`);
  }
  log(
    "\n  (说明: topic0 是否以字面常量出现在 runtime bytecode 取决于 solc 的常量折叠;" +
      "\n   下方 ⑤ 会用真交易 receipt 的 logs 逐个核对真正上链的 topic0 — 那才是硬证据。)"
  );

  // ══════════════════════════════════════════════════════════════════════
  hr("④ 写 ABI 文件 + deployment manifest");
  // ══════════════════════════════════════════════════════════════════════

  fs.mkdirSync(ABIS_DIR, { recursive: true });
  const abiPaths = {};
  // 只写本次真正用到的合约 ABI —— external 模式没有 MockERC20, 就不写它
  for (const k of Object.keys(art)) {
    const p = path.join(ABIS_DIR, `${k}.json`);
    writeJson(p, art[k].abi);
    abiPaths[k] = path.relative(DEPLOYMENTS_DIR, p); // 相对 contracts/deployments/
    log(`  ABI → ${abiPaths[k]}`);
  }
  if (externalMode && fs.existsSync(path.join(ABIS_DIR, "MockERC20.json"))) {
    log(
      "  (external 模式: 不写也不引用 MockERC20 ABI; abis/MockERC20.json 是此前 mock 模式的产物, 本次未触碰)"
    );
  }

  const escrowVersionOnChain = (await escrow.CONTRACT_VERSION()).toString();

  // token 口径: mock 模式记 `token` (USDC 替身), external 模式记 `externalToken`
  const tokenSection = externalMode
    ? {
        externalToken: {
          address: tokenAddr,
          decimals: tokenMeta.decimals,
          symbol: tokenMeta.symbol,
          name: tokenMeta.name,
          source: "external",
          addressFrom: "env TOKEN_ADDRESS",
          decimalsOnChain: Number(tokenDecimals),
          isMock: false,
          codeLengthBytes: (tokenCode.length - 2) / 2,
          note:
            "外部已有 ERC20 — 本脚本不部署、不 mint、不改它的状态; decimals 由链上真读并在 ≠6 时拒编; " +
            "唯一可能的状态写入是 E2E 需要 buyer 授权时的 approve (allowance 已足够则连 approve 都不发)",
          stateWritesByThisScript: externalTokenWrites,
        },
      }
    : {
        token: {
          name: tokenMeta.name,
          symbol: tokenMeta.symbol,
          address: tokenAddr,
          decimals: tokenMeta.decimals,
          decimalsOnChain: Number(tokenDecimals),
          source: "mock",
          isMock: true,
          note: "MockERC20 — 本地 USDC 替身, 非真实 USDC",
        },
      };

  const manifest = {
    schemaVersion: 1,
    chainId: Number(chainId),
    networkName: NETWORK_NAME,
    deployedAt: new Date().toISOString(),
    rpcUrl: RPC_URL,
    deployerAddress: deployer.address,
    tokenSource: tokenMeta.source, // "mock" = 本脚本部署 MockERC20; "external" = 用 TOKEN_ADDRESS
    contracts: deployed.map((r) => ({
      name: r.name,
      address: r.address,
      txHash: r.txHash,
      blockNumber: r.blockNumber,
      bytecodeHash: r.bytecodeHash, // keccak256(eth_getCode(addr))
      // keccak256(部署字节码, immutable 占位槽清零后) — 幂等复用判定就比这个
      creationBytecodeHash: r.creationBytecodeHash,
      creationBytecodeHashNormalized: !!r.creationBytecodeHashNormalized,
      constructorArgs: r.constructorArgs,
      contractVersion: r.contractVersion,
      sourcePath: r.sourcePath,
      role: r.role,
      reusedFromManifest: !!r.reused,
    })),
    // token 便捷入口: mock 模式是 USDC 替身; external 模式是 externalToken 块
    ...tokenSection,
    // 本部署切片里各合约的版本口径
    contractVersions: {
      AgentEscrow: {
        declaredOnChain_CONTRACT_VERSION: escrowVersionOnChain,
        semantic: "v2 (含 createEscrowV2/submitProofV2/releaseV2/claimAfterTimeoutV2 + F1 12 字段 + F3 事件)",
        modelFreezeRef: "MODEL_FREEZE.md §2.2/§3.2/§4/§5",
      },
      AgentTreasury: { semantic: "v1 (2026-08-13)" },
      ...(externalMode ? {} : { MockERC20: { semantic: "mock-erc20-v1 (USDC 替身)" } }),
    },
    // ABI 存放路径 (相对 contracts/deployments/)
    abiPaths,
    // 编译产物溯源 (决定 bytecodeHash 的那次编译)
    build: {
      solcLongVersion: solidity?.solcLongVersion ?? null,
      optimizer: solidity?.optimizer ?? null,
      evmVersion: solidity?.evmVersion ?? null,
      buildInfoFile: compiled.AgentEscrow.buildInfoFile,
      immutableSlots: Object.fromEntries(
        Object.keys(compiled).map((k) => [k, Object.values(compiled[k].refs).flat().length])
      ),
      creationBytecodeHashNormalization:
        "creationBytecodeHash = keccak256(artifact creation bytecode, 其中嵌入的 runtime 段的 immutable 占位槽已显式清零)",
      creationBytecodeNormalizationDetail: Object.fromEntries(
        Object.keys(compiled).map((k) => [
          k,
          {
            hash: compiled[k].creation.hash,
            normalized: compiled[k].creation.normalized,
            embeddedRuntimeOffset: compiled[k].creation.embeddedRuntimeOffset,
            note: compiled[k].creation.note,
          },
        ])
      ),
      note: "bytecodeHash 已对 immutable 占位槽清零后与上述编译产物比对一致",
    },
    // 关键 ABI 面 (固化进 manifest, 便于不读 ABI 文件也能核对)
    agentEscrowV2Interface: {
      functions: selectorReport,
      events: topicReport,
    },
    deploymentParams: {
      escrow_releaseTimeout: RELEASE_TIMEOUT.toString(),
      treasury_dailyLimit: TREASURY_DAILY_LIMIT.toString(),
      token_initialMintToDeployer: externalMode ? null : TOKEN_SUPPLY.toString(),
      token_mintPerformedByThisScript: !externalMode,
    },
    notes: [
      "本地零成本部署: 默认账户派生自 anvil 公开开发助记符, 未使用任何真实钱包",
      "bytecodeHash = keccak256(链上 eth_getCode 返回的 runtime bytecode)",
      externalMode
        ? `token 为外部已有 ERC20 (${tokenAddr}, symbol=${tokenMeta.symbol}, decimals=${tokenMeta.decimals}) — 本脚本未部署 MockERC20、未 mint、未改其状态`
        : "token 为本脚本部署的 MockERC20 (USDC 替身)",
      "chainId 31337 = anvil/hardhat 默认本地链",
      "刻意不加 verifiedAtRealRpc 字段: 本 manifest 的所有读数都来自 rpcUrl+chainId 那一条链, " +
        "一个布尔既不比 rpcUrl 多任何信息, 又会诱导把「RPC 应答了」当成「链就是你以为的那条」(被代理/被劫持的 RPC 一样返回 true); " +
        "要更强保证应做链身份绑定 (chainId 回读 + 块哈希 + 最终性深度), 不是加布尔。",
    ],
    reproduce: {
      step1_anvil:
        "DYLD_LIBRARY_PATH=~/.local/lib ~/.foundry/bin/anvil --chain-id 31337 --port 8545 --host 127.0.0.1",
      step2_deploy: externalMode
        ? `cd contracts/evm && npx hardhat compile && TOKEN_ADDRESS=${tokenAddr} NETWORK_NAME=${NETWORK_NAME} node scripts/deploy.js`
        : "cd contracts/evm && npx hardhat compile && node scripts/deploy.js",
      anvilNote:
        "本机 anvil/cast 动态链接要 /usr/local/opt/libusb/lib/libusb-1.0.0.dylib, 该路径不存在; " +
        "~/.local/lib/libusb-1.0.0.dylib 存在, 所以必须带 DYLD_LIBRARY_PATH。forge 不依赖 libusb, 无需该变量。",
      env: {
        RPC_URL: RPC_URL,
        NETWORK_NAME: NETWORK_NAME,
        TOKEN_ADDRESS: externalMode
          ? `${tokenAddr} (external 模式: 用已有 token, 不部署 MockERC20)`
          : "(未设置 → mock 模式: 自部署 MockERC20)",
        DEPLOYER_PRIVATE_KEY: "默认 = 由 anvil 公开开发助记符派生的账户 #0 (非真实钱包)",
        AGENT_PRIVATE_KEY: "默认 = 同一助记符的账户 #1",
        FORCE_REDEPLOY: "1 = 忽略已有 manifest 全部重部署",
        SKIP_E2E: "1 = 跳过真交易闭环与 F2 断言",
      },
      idempotency:
        "重跑会复用 manifest 里的地址 (需 chainId 一致 + 当前编译产物的 creationBytecodeHash 与 manifest 逐字一致 " +
        "+ 链上 eth_getCode 的 keccak256 一致 + 构造参数一致), 不重复部署; " +
        "只用 manifest 里记录的原始部署 txHash/blockNumber。bytecodeHash 不符会自动重部署并打印原因。",
      tradeLoopRerunSafety:
        "E2E 与 F2 断言使用每次运行唯一的 taskKey (taskId 带时间戳+随机数), 因此可反复执行不撞 'task exists'。",
    },
  };
  writeJson(MANIFEST_PATH, manifest);
  log(`\n  manifest → ${MANIFEST_PATH}`);

  // ══════════════════════════════════════════════════════════════════════
  const SKIP_E2E = process.env.SKIP_E2E === "1";
  const e2e = { ran: false };
  let stateReport = null;
  let f2Report = null;

  // ── E2E 资金预检 (mock 模式先 mint; external 模式绝不 mint) ───────────────
  // 闭环需要 buyer 付出 100 + 10 + 10 单位 (第三笔的 10 会释放给 agent)。
  // 外部 token 模式下余额不够时**大声报错并给可行提示 + 退出码非 0**, 绝不假通过。
  const buyer = deployer;
  const agentSigner = agent;
  const unit = tokenDecimals; // 链上真读的 decimals (external 模式前面已强制 == 6)
  const amount = ethers.parseUnits("100", unit);
  const amountB = ethers.parseUnits("10", unit);
  const amountC = ethers.parseUnits("10", unit);
  const e2eNeeded = amount + amountB + amountC;
  let e2eSkipReason = null;

  if (!SKIP_E2E) {
    if (!externalMode) {
      const mintTx = await token.mint(buyer.address, TOKEN_SUPPLY);
      await mintTx.wait();
      log(`\n  mint tx: ${mintTx.hash}  (mock 模式: 给 buyer 铸 ${TOKEN_SUPPLY} 单位, decimals=${unit})`);
    } else {
      log(`\n  外部 token 模式: 不 mint (脚本对外部 token 只做 eth_call 只读 + 必要 approve)`);
    }
    const balNow = await token.balanceOf(buyer.address);
    log(`  buyer ${buyer.address} token 余额 = ${balNow}  (E2E 需要 ${e2eNeeded})`);
    if (balNow < e2eNeeded) {
      log(`\n  ❌ E2E 无法继续: buyer 的 token 余额不足 (${balNow} < ${e2eNeeded}) — 不伪造通过结果`);
      const hints = [
        `token (${tokenAddr}) 由 TOKEN_ADDRESS 指定, 是外部已有 ERC20 → 脚本不会 mint 它`,
        `请先给 buyer ${buyer.address} 转入 ≥ ${e2eNeeded} 单位 (decimals=${unit})`,
        `查余额: cast call ${tokenAddr} "balanceOf(address)(uint256)" ${buyer.address} --rpc-url ${RPC_URL}`,
        `或改用持有该 token 的账户: DEPLOYER_PRIVATE_KEY=<该账户私钥> (私钥只经环境变量, 不会写进文件/日志)`,
        `只想部署不跑闭环: SKIP_E2E=1`,
      ];
      for (const h of hints) log(`     → ${h}`);
      failures.push("E2E: external token 余额不足 → 闭环未执行 (不是通过)");
      e2eSkipReason = "insufficient_external_token_balance";
    }
  }

  if (!SKIP_E2E && !e2eSkipReason) {
    hr("⑤ 真交易闭环: createEscrowV2 → submitProofV2 → releaseV2");

    // ── 授权 (allowance 足够就不发 approve —— external 模式下这可能是唯一的状态写入) ──
    const allowance = await token.allowance(buyer.address, escrowAddr);
    if (allowance < e2eNeeded) {
      const approveTx = await token.approve(escrowAddr, e2eNeeded);
      await approveTx.wait();
      log(`  approve tx: ${approveTx.hash}  (allowance ${allowance} < 需要 ${e2eNeeded}, escrow=${escrowAddr})`);
      if (externalMode) {
        externalTokenWrites.push(
          `approve(spender=${escrowAddr}, amount=${e2eNeeded}) by buyer — 外部 token 的唯一状态写入, 闭环必需`
        );
      }
    } else {
      log(`  approve 跳过: allowance(buyer, escrow) = ${allowance} >= 需要 ${e2eNeeded} (零状态写入)`);
    }

    const now = BigInt((await provider.getBlock("latest")).timestamp);
    const blockNow = await provider.getBlockNumber();

    // 每次运行唯一的 taskId → 重跑不撞 "task exists"
    const runId = `${Date.now()}-${ethers.hexlify(ethers.randomBytes(4)).slice(2)}`;
    const taskIdA = `bolloon-local-e2e-${runId}`;
    const taskKeyA = ethers.keccak256(
      ABICODER.encode(["bytes32", "string"], [TAG_TASK, taskIdA])
    );
    // 交叉核对: 链上 computeTaskKey 必须给出同一个键 (证明 hash 口径一致)
    const onChainKeyA = await escrow.computeTaskKey(taskIdA);
    assert(
      "taskKey 链下复算 == 链上 computeTaskKey()",
      onChainKeyA.toLowerCase() === taskKeyA.toLowerCase(),
      `offchain=${taskKeyA} onchain=${onChainKeyA}`
    );

    const sha = (s) => "sha256:" + ethers.sha256(ethers.toUtf8Bytes(s)).slice(2);
    const contentHash = (s) => ethers.keccak256(ethers.toUtf8Bytes(sha(s)));
    const termsHash = contentHash(`terms:${taskIdA}`);
    const quoteHash = contentHash(`quote:${taskIdA}`);
    const inputHash = contentHash(`input:${taskIdA}`);
    const manifestHash = contentHash(`manifest:${taskIdA}`);
    const resultHash = contentHash(`result:${taskIdA}`);
    const PROOF_VERSION = 1;

    const readState = async (key) => {
      const e = await escrow.escrows(key);
      const NAMES = ["ACTIVE", "RELEASED", "DISPUTED", "REFUNDED"];
      return {
        raw: Number(e.state),
        name: NAMES[Number(e.state)],
        buyer: e.buyer,
        agent: e.agent,
        amount: e.amount.toString(),
        proofHash: e.proofHash,
        resultHash: e.resultHash,
        contractVersion: Number(e.contractVersion),
        createdBlock: Number(e.createdBlock),
        deadline: Number(e.deadline),
        confirmationWindow: Number(e.confirmationWindow),
        paymentAsset: e.paymentAsset,
      };
    };

    const buyerBalBefore = await token.balanceOf(buyer.address);
    const agentBalBefore = await token.balanceOf(agentSigner.address);

    const before = await readState(taskKeyA);
    log(`\n  [闭环] taskId=${taskIdA}`);
    log(`         taskKey=${taskKeyA}`);
    log(`  创建前 state = ${before.name} (${before.raw})`);

    // 1) createEscrowV2
    const deadline = now + 3600n;
    const txCreate = await escrow
      .connect(buyer)
      .createEscrowV2(
        taskKeyA,
        agentSigner.address,
        amount,
        tokenAddr,
        termsHash,
        quoteHash,
        inputHash,
        manifestHash,
        deadline,
        3600,
        PROOF_VERSION
      );
    const rcCreate = await txCreate.wait();
    const afterCreate = await readState(taskKeyA);
    log(`\n  (1) createEscrowV2  tx=${txCreate.hash}  block=${rcCreate.blockNumber}  gas=${rcCreate.gasUsed}`);
    log(`      state: ${before.name} → ${afterCreate.name} (${afterCreate.raw})   escrow余额=${await token.balanceOf(escrowAddr)}`);

    // 2) submitProofV2 (只有 agent 能提交)
    const txProof = await escrow
      .connect(agentSigner)
      .submitProofV2(taskKeyA, resultHash, manifestHash, PROOF_VERSION);
    const rcProof = await txProof.wait();
    const afterProof = await readState(taskKeyA);
    log(`\n  (2) submitProofV2   tx=${txProof.hash}  block=${rcProof.blockNumber}  gas=${rcProof.gasUsed}`);
    log(`      state: ${afterCreate.name} → ${afterProof.name}   proofHash=${afterProof.proofHash}`);
    const expectedProof = await escrow.computeProofHash(resultHash, PROOF_VERSION);
    assert(
      "链上存入的 proofHash == 冻结口径 keccak256(abi.encode(proofDomain,resultHash,proofVersion))",
      afterProof.proofHash.toLowerCase() === expectedProof.toLowerCase()
    );

    // 3) releaseV2 (buyer 确认)
    const txRelease = await escrow.connect(buyer).releaseV2(taskKeyA);
    const rcRelease = await txRelease.wait();
    const afterRelease = await readState(taskKeyA);
    const agentBalAfter = await token.balanceOf(agentSigner.address);
    log(`\n  (3) releaseV2       tx=${txRelease.hash}  block=${rcRelease.blockNumber}  gas=${rcRelease.gasUsed}`);
    log(`      state: ${afterProof.name} → ${afterRelease.name} (${afterRelease.raw})   escrow余额=${await token.balanceOf(escrowAddr)}`);

    const stateTransition = `${before.name}→${afterCreate.name}→${afterProof.name}→${afterRelease.name}`;
    assert("状态迁移 == ACTIVE→ACTIVE→ACTIVE→RELEASED", stateTransition === "ACTIVE→ACTIVE→ACTIVE→RELEASED", stateTransition);
    assert(
      "资金到账 agent",
      agentBalAfter - agentBalBefore === amount,
      `agent +${agentBalAfter - agentBalBefore} (期望 ${amount})`
    );

    // ── 用真 receipt 的 logs 核对 5 个 v2 事件 topic0 确实上链 ─────────────
    const receiptLogs = [...rcCreate.logs, ...rcProof.logs, ...rcRelease.logs];
    const seenTopics = new Set();
    for (const l of receiptLogs) {
      // 只认 escrow 合约发出的日志
      if (l.address.toLowerCase() === escrowAddr.toLowerCase()) seenTopics.add(l.topics[0].toLowerCase());
    }
    log("\n  真交易 receipt 里实际出现的 escrow topic0:");
    for (const t of topicReport) {
      const seen = seenTopics.has(t.topic0.toLowerCase());
      log(`    ${ok(seen)} ${t.topic0.slice(0, 20)}…  ${t.signature.split("(")[0]}`);
    }
    const emitted = topicReport.filter((t) => seenTopics.has(t.topic0.toLowerCase())).map((t) => t.signature.split("(")[0]);
    assert(
      "闭环路径至少发出 EscrowCreatedV2 / ProofSubmittedV2 / ReleasedV2",
      ["EscrowCreatedV2", "ProofSubmittedV2", "ReleasedV2"].every((n) => emitted.includes(n)),
      `实际发出: ${emitted.join(", ")}`
    );
    const relLog = rcRelease.logs.find(
      (l) =>
        l.address.toLowerCase() === escrowAddr.toLowerCase() &&
        l.topics[0].toLowerCase() === topic0Of(escrowIface, V2_EVENTS[2]).toLowerCase()
    );
    if (relLog) {
      const parsed = escrowIface.parseLog({ topics: relLog.topics, data: relLog.data });
      assert("ReleasedV2.by == 0 (buyer)", Number(parsed.args.by) === 0, `by=${parsed.args.by}`);
      log(`    ReleasedV2 decoded: to=${parsed.args.to} amount=${parsed.args.amount} by=${parsed.args.by}`);
    }

    e2e.ran = true;
    e2e.taskId = taskIdA;
    e2e.taskKey = taskKeyA;
    e2e.transactions = {
      createEscrowV2: { txHash: txCreate.hash, blockNumber: rcCreate.blockNumber, gasUsed: rcCreate.gasUsed.toString() },
      submitProofV2: { txHash: txProof.hash, blockNumber: rcProof.blockNumber, gasUsed: rcProof.gasUsed.toString() },
      releaseV2: { txHash: txRelease.hash, blockNumber: rcRelease.blockNumber, gasUsed: rcRelease.gasUsed.toString() },
    };
    e2e.stateTransition = stateTransition;
    e2e.buyerBalanceDelta = (await token.balanceOf(buyer.address) - buyerBalBefore).toString();
    e2e.agentBalanceDelta = (agentBalAfter - agentBalBefore).toString();
    e2e.escrowBalanceAfter = (await token.balanceOf(escrowAddr)).toString();

    // ══════════════════════════════════════════════════════════════════════
    hr("⑥ F2 门槛真链断言: 无 proof 时 claimAfterTimeoutV2 必须 revert");
    // ══════════════════════════════════════════════════════════════════════

    const taskIdB = `bolloon-local-f2-noproof-${runId}`;
    const taskKeyB = ethers.keccak256(ABICODER.encode(["bytes32", "string"], [TAG_TASK, taskIdB]));
    const taskIdC = `bolloon-local-f2-withproof-${runId}`;
    const taskKeyC = ethers.keccak256(ABICODER.encode(["bytes32", "string"], [TAG_TASK, taskIdC]));

    const mk = async (taskId, key, window, amt) => {
      const t = await escrow.connect(buyer).createEscrowV2(
        key, agentSigner.address, amt, tokenAddr,
        contentHash(`terms:${taskId}`), contentHash(`quote:${taskId}`), contentHash(`input:${taskId}`),
        contentHash(`manifest:${taskId}`), BigInt((await provider.getBlock("latest")).timestamp) + 60n,
        window, PROOF_VERSION
      );
      return t.wait();
    };

    const rcB = await mk(taskIdB, taskKeyB, 60, amountB);
    const rcC = await mk(taskIdC, taskKeyC, 60, amountC);
    log(`  escrow B (无 proof): taskKey=${taskKeyB}  createBlock=${rcB.blockNumber}`);
    log(`  escrow C (有 proof): taskKey=${taskKeyC}  createBlock=${rcC.blockNumber}`);

    // 时间旅行越过 deadline + confirmationWindow
    let warped = true;
    try {
      await provider.send("evm_increaseTime", [300]);
      await provider.send("evm_mine", []);
    } catch (e) {
      warped = false;
      log(`  ⚠ 该 RPC 不支持 evm_increaseTime (${e.message}) — 无法越过超时点, F2 断言降级为 SKIPPED`);
    }
    const tsNow = BigInt((await provider.getBlock("latest")).timestamp);
    const claimableB = await escrow.claimableAt(taskKeyB);
    log(`  now=${tsNow}  deadline+window(B)=${claimableB}  已超时=${tsNow >= claimableB}`);
    if (warped) {
      assert("已越过超时点 (否则测的就不是 proof 门槛)", tsNow >= claimableB, `now>=claimableAt`);
    }

    const claimIface = new ethers.Interface(art.AgentEscrow.abi);
    const claimData = claimIface.encodeFunctionData("claimAfterTimeoutV2", [taskKeyB]);

    // (a) eth_call 静态调用 → 读 revert reason
    let staticRevert = null;
    try {
      await provider.call({ to: escrowAddr, from: agentSigner.address, data: claimData });
    } catch (e) {
      staticRevert = e.reason || e.shortMessage || e.message;
    }
    log(`\n  (a) eth_call claimAfterTimeoutV2(B) → revert = "${staticRevert}"`);
    const bStateBeforeClaim = await readState(taskKeyB);
    assert(
      'F2 (静态): revert reason == "no proof submitted"',
      warped ? staticRevert === "no proof submitted" : false,
      `reason=${JSON.stringify(staticRevert)}  state=${bStateBeforeClaim.name}`
    );

    // (b) 真发一笔必然失败的交易 (显式给 gasLimit 绕过 estimateGas 预检) → status 0
    let revertedTxHash = null;
    let revertedTxStatus = null;
    let revertedTxBlock = null;
    try {
      const rtx = await agentSigner.sendTransaction({
        to: escrowAddr,
        data: claimData,
        gasLimit: 300000,
      });
      revertedTxHash = rtx.hash;
      const rrc = await rtx.wait(); // ethers v6: status 0 会抛
      revertedTxStatus = rrc.status;
      revertedTxBlock = rrc.blockNumber;
    } catch (e) {
      if (e.receipt) {
        revertedTxHash = e.receipt.hash;
        revertedTxStatus = e.receipt.status;
        revertedTxBlock = e.receipt.blockNumber;
      } else {
        revertedTxHash = "n/a";
        revertedTxStatus = `send failed: ${e.shortMessage || e.message}`;
      }
    }
    log(`  (b) 真交易 claimAfterTimeoutV2(B) tx=${revertedTxHash} status=${revertedTxStatus} block=${revertedTxBlock}`);
    const bStateAfterClaim = await readState(taskKeyB);
    assert(
      "F2 (真链): 交易 status == 0 (reverted)",
      revertedTxStatus === 0,
      `status=${revertedTxStatus}`
    );
    assert(
      "F2 (真链): 资金未动 — state 仍 ACTIVE, proofHash 仍为 0",
      bStateAfterClaim.name === "ACTIVE" && BigInt(bStateAfterClaim.proofHash) === 0n,
      `state=${bStateAfterClaim.name} proofHash=${bStateAfterClaim.proofHash}`
    );
    assert(
      "F2 (真链): agent 余额未因该笔失败交易增加",
      (await token.balanceOf(agentSigner.address)) === agentBalAfter,
      `agentBal=${await token.balanceOf(agentSigner.address)}`
    );

    // (c) 阳性对照: escrow C 提交 proof 后, 同样的超时 claim 必须成功 → 证明门槛就是 proof
    const txProofC = await escrow.connect(agentSigner).submitProofV2(taskKeyC, contentHash(`result:${taskIdC}`), manifestHash, PROOF_VERSION);
    const rcProofC = await txProofC.wait();
    const balBeforeClaimC = await token.balanceOf(agentSigner.address);
    const txClaimC = await escrow.connect(agentSigner).claimAfterTimeoutV2(taskKeyC);
    const rcClaimC = await txClaimC.wait();
    const afterClaimC = await readState(taskKeyC);
    const claimedLog = rcClaimC.logs.find(
      (l) => l.address.toLowerCase() === escrowAddr.toLowerCase() &&
        l.topics[0].toLowerCase() === topic0Of(escrowIface, V2_EVENTS[2]).toLowerCase()
    );
    let byC = null;
    if (claimedLog) {
      const p = escrowIface.parseLog({ topics: claimedLog.topics, data: claimedLog.data });
      byC = Number(p.args.by);
      log(`\n  (c) 阳性对照 escrow C: submitProofV2 tx=${txProofC.hash}`);
      log(`      claimAfterTimeoutV2 tx=${txClaimC.hash} block=${rcClaimC.blockNumber} → ${afterClaimC.name}, ReleasedV2.by=${byC} (2=BY_TIMEOUT)`);
    }
    assert(
      "F2 (阳性对照): 有 proof 后 claimAfterTimeoutV2 成功且状态 → RELEASED",
      afterClaimC.name === "RELEASED" && byC === 2,
      `state=${afterClaimC.name} by=${byC}`
    );
    assert(
      "F2 (阳性对照): agent 收到超时释放的资金",
      (await token.balanceOf(agentSigner.address)) - balBeforeClaimC === amountC,
      `delta=${(await token.balanceOf(agentSigner.address)) - balBeforeClaimC}`
    );

    stateReport = {
      escrowClosed: { taskKey: taskKeyA, ...e2e.transactions, stateTransition },
      escrowB_noProof: {
        taskKey: taskKeyB,
        claimRevertedTxHash: revertedTxHash,
        claimRevertedStatus: revertedTxStatus,
        claimRevertedBlock: revertedTxBlock,
        staticRevertReason: staticRevert,
        stateAfterFailedClaim: bStateAfterClaim.name,
      },
      escrowC_withProof: {
        taskKey: taskKeyC,
        submitProofTx: txProofC.hash,
        claimTx: txClaimC.hash,
        claimBlock: rcClaimC.blockNumber,
        releasedBy: byC,
        state: afterClaimC.name,
      },
    };

    f2Report = {
      gate: "claimAfterTimeoutV2 requires proofHash != 0",
      heldOnRealChain: failures.length === 0,
      evidence: {
        staticCallRevertReason: staticRevert,
        realTxHash_status0: revertedTxHash,
        realTx_status: revertedTxStatus,
        positiveControl_withProof_state: afterClaimC.name,
      },
    };

    // 回填 manifest
    manifest.tradeLoop = e2e;
    manifest.f2Assertion = f2Report;
    manifest.verification = {
      ethGetCodeNonEmpty: codeChecks.every((c) => c.nonEmpty),
      onChainCodeMatchesArtifact: codeChecks.every((c) => c.matchesArtifact),
      tokenDecimalsIs6: Number(tokenDecimals) === 6,
      tokenSource: tokenMeta.source,
      tokenMetaReadOnChain: {
        address: tokenAddr,
        decimals: Number(tokenDecimals),
        symbol: String(tokenSymbol),
        name: String(tokenName),
      },
      mockTokenDeployedByThisScript: !externalMode,
      externalTokenWritesByThisScript: externalMode ? [...externalTokenWrites] : [],
      blockNumbers: deployed.map((r) => ({ name: r.name, blockNumber: r.blockNumber })),
      selectorChecks: selectorReport,
      topic0Checks: topicReport,
      topicsObservedInRealReceipts: [...seenTopics],
    };
    manifest.verificationReport = stateReport;
    if (externalMode) {
      // 台账回填 (externalToken 块引用的就是同一个数组)
      manifest.externalToken.untouchedBeforeE2E = true;
      manifest.externalToken.stateWritesByThisScript = [...externalTokenWrites];
    }
    writeJson(MANIFEST_PATH, manifest);
    log(`\n  manifest 已回填 verification + tradeLoop + f2Assertion → ${MANIFEST_PATH}`);
  } else if (SKIP_E2E) {
    log("\n  (SKIP_E2E=1: 跳过真交易闭环与 F2 断言)");
  } else {
    // 外部 token 余额不足 → 明确记成「没跑」, 不是「通过」
    log(`\n  (E2E 未执行: ${e2eSkipReason})`);
    manifest.tradeLoop = {
      ran: false,
      skipped: true,
      skippedReason: e2eSkipReason,
      requiredBalance: e2eNeeded.toString(),
      buyerAddress: buyer.address,
      tokenAddress: tokenAddr,
      actionable:
        `给 buyer 转入 ≥ ${e2eNeeded} 单位 (decimals=${unit}) 后重跑, 或设置 SKIP_E2E=1 只做部署`,
    };
    manifest.verification = {
      ethGetCodeNonEmpty: codeChecks.every((c) => c.nonEmpty),
      onChainCodeMatchesArtifact: codeChecks.every((c) => c.matchesArtifact),
      tokenDecimalsIs6: Number(tokenDecimals) === 6,
      tokenSource: tokenMeta.source,
      mockTokenDeployedByThisScript: !externalMode,
      externalTokenWritesByThisScript: externalMode ? [...externalTokenWrites] : [],
      blockNumbers: deployed.map((r) => ({ name: r.name, blockNumber: r.blockNumber })),
      selectorChecks: selectorReport,
      topic0Checks: topicReport,
      tradeLoopRan: false,
    };
    if (externalMode) {
      manifest.externalToken.untouchedBeforeE2E = true;
      manifest.externalToken.stateWritesByThisScript = [...externalTokenWrites];
    }
    writeJson(MANIFEST_PATH, manifest);
    log(`  manifest 已回填 verification + tradeLoop(未执行) → ${MANIFEST_PATH}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  hr("汇总");
  // ══════════════════════════════════════════════════════════════════════
  for (const r of deployed) {
    log(`  ${r.name.padEnd(14)} ${r.address}  tx ${r.txHash}  block ${r.blockNumber}${r.reused ? "  (复用)" : ""}`);
  }
  log(`\n  token (${tokenMeta.source}) : ${tokenAddr}  symbol=${tokenSymbol} decimals=${tokenDecimals}`);
  log(`  escrow CONTRACT_VERSION : ${escrowVersionOnChain}`);
  log(`  manifest                : ${MANIFEST_PATH}`);
  log(`  ABI 目录                : ${path.relative(process.cwd(), ABIS_DIR)}/`);
  if (externalMode) {
    log(`  外部 token 状态写入台账 : ${externalTokenWrites.length ? externalTokenWrites.join("; ") : "无 (零写入)"}`);
  }

  if (failures.length) {
    log(`\n  ❌ ${failures.length} 项断言失败:`);
    failures.forEach((f) => log(`     - ${f}`));
    process.exitCode = 1;
  } else {
    log("\n  ✅ 全部断言通过");
  }
}

main().catch((e) => {
  if (e.hints && e.hints.length) {
    // fatal() 已经把错误块和提示打出来了, 这里只补一行
    console.error(`\n[deploy.js] 失败: ${e.message}`);
  } else {
    console.error("\n[deploy.js] 失败:", e.shortMessage || e.message || e);
  }
  if (e.stack && process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
