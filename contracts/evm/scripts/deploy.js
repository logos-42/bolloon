#!/usr/bin/env node
/**
 * Bolloon — EVM 本地部署 + 部署清单 + 链上真读数验证 + 真交易闭环
 * =========================================================================
 * 用途: 在本地开发链 (anvil / hardhat node, chainId 31337) 上真部署
 *   MockERC20 (USDC 替身, decimals = 6) + AgentEscrow (v2) + AgentTreasury,
 *   生成 deployment manifest, 用链上真读数验证, 并跑 createEscrowV2 →
 *   submitProofV2 → releaseV2 的真交易闭环 + F2 门槛断言。
 *
 * 设计约束 (为什么长这样):
 *   - **零真实钱包**: 默认部署账户从 anvil 的公开开发助记符派生
 *     ("test test ... junk" 是 anvil 默认值, 公开文档可见, 非真实私钥)。
 *     绝不读取 ~/.hermes/wallets/。要换账户就传 DEPLOYER_PRIVATE_KEY 环境变量。
 *   - **零联网**: 默认 RPC = http://127.0.0.1:8545; 且除非显式
 *     ALLOW_NON_LOCAL=1, 脚本对非 31337 的 chainId 直接拒绝执行。
 *   - **幂等 / 可重入**: manifest 落在 contracts/deployments/<network>.json。
 *     重跑时若 chainId 一致 + 每个合约地址上 eth_getCode 非空 +
 *     链上 runtime bytecode 的 keccak256 与 manifest 记录一致 +
 *     构造参数一致 → 复用地址, 不重复部署; 否则只重部署失效的那个。
 *     FORCE_REDEPLOY=1 强制全部重部署。
 *     闭环测试用「每次运行唯一」的 taskKey, 所以重跑不会撞 "task exists"。
 *
 * 环境变量:
 *   RPC_URL                默认 http://127.0.0.1:8545
 *   DEPLOYER_PRIVATE_KEY   默认 = anvil 开发账户 #0 (派生自公开助记符)
 *   AGENT_PRIVATE_KEY      默认 = anvil 开发账户 #1
 *   NETWORK_NAME           默认 localhost
 *   FORCE_REDEPLOY         1 = 忽略已有 manifest 全部重部署
 *   ALLOW_NON_LOCAL        1 = 允许非 31337 chainId (默认禁止, 防误连主网)
 *   SKIP_E2E               1 = 跳过真交易闭环
 *
 * 用法:
 *   # 终端 A (macOS 上 foundry 缺 libusb 时要带 DYLD_LIBRARY_PATH)
 *   DYLD_LIBRARY_PATH=~/.local/lib ~/.foundry/bin/anvil --chain-id 31337
 *   # 终端 B
 *   cd contracts/evm && npx hardhat compile && node scripts/deploy.js
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
const TOKEN_DECIMALS = 6; // USDC 替身必须 6 位
const RELEASE_TIMEOUT = 7 * 86400; // AgentEscrow 构造参数
const TREASURY_DAILY_LIMIT = ethers.parseUnits("100000", 6); // AgentTreasury 构造参数
const TOKEN_SUPPLY = ethers.parseUnits("10000000", 6); // mint 给 deployer 的初始量

// ── 冻结 hash 口径 (与 AgentEscrow.sol / MODEL_FREEZE.md §4 逐字一致) ──────
const TAG_TASK = ethers.encodeBytes32String("bolloon.task.v1");
const ABICODER = ethers.AbiCoder.defaultAbiCoder();

const log = (...a) => console.log(...a);
const hr = (t) => log(`\n${"─".repeat(72)}\n${t}\n${"─".repeat(72)}`);
const ok = (b) => (b ? "✅" : "❌");

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
 * build-info 里才有 solc 的 immutableReferences (hardhat 的 artifact JSON 不带这个字段)。
 * 没有它就无法把 chain 上的 runtime code 和编译产物对齐 —— 因为 immutable
 * (AgentEscrow/AgentTreasury 的 `token`) 的 32 字节槽在 artifact 里是全零,
 * 在链上却是真地址。返回 { immutables, solidity }。
 */
function loadBuildInfo() {
  const dir = path.join(EVM_DIR, "artifacts", "build-info");
  const immutables = {};
  let solidity = null;
  if (!fs.existsSync(dir)) return { immutables, solidity };
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      continue;
    }
    const contracts = j.output && j.output.contracts;
    if (!contracts) continue;
    solidity = {
      solcLongVersion: j.solcLongVersion,
      optimizer: j.input && j.input.settings && j.input.settings.optimizer,
      evmVersion: j.input && j.input.settings && j.input.settings.evmVersion,
    };
    for (const src of Object.keys(contracts)) {
      for (const cn of Object.keys(contracts[src])) {
        const c = contracts[src][cn];
        const refs =
          c.evm && c.evm.deployedBytecode && c.evm.deployedBytecode.immutableReferences;
        if (refs && Object.keys(refs).length) immutables[cn] = refs;
      }
    }
  }
  return { immutables, solidity };
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
  const art = {
    MockERC20: loadArtifact(path.join("mocks", "MockERC20.sol"), "MockERC20"),
    AgentEscrow: loadArtifact("AgentEscrow.sol", "AgentEscrow"),
    AgentTreasury: loadArtifact("AgentTreasury.sol", "AgentTreasury"),
  };
  const { immutables, solidity } = loadBuildInfo();
  log(
    `  编译产物 : solc ${solidity?.solcLongVersion}  optimizer=${JSON.stringify(solidity?.optimizer)}  evm=${solidity?.evmVersion}`
  );
  log(
    `  immutable 槽位 (build-info): ` +
      Object.entries(immutables)
        .map(([k, v]) => `${k}=${Object.values(v).flat().length}×32B`)
        .join("  ")
  );

  // ── 已有 manifest? (幂等判断依据) ────────────────────────────────────────
  const prev = process.env.FORCE_REDEPLOY === "1" ? null : readJsonSafe(MANIFEST_PATH);

  /**
   * 判断能否复用 manifest 里的记录:
   *   chainId 一致 + 地址上有 code + runtime code keccak256 与记录一致
   *   (+ 若给了 expectedArgs 则构造参数也要一致)
   */
  async function reusable(name, expectedArgs) {
    if (!prev || !prev.contracts) return null;
    if (BigInt(prev.chainId) !== chainId) return null;
    const rec = prev.contracts.find?.((c) => c.name === name) ||
      (prev.contracts[name] ? { ...prev.contracts[name], name } : null);
    if (!rec || !rec.address) return null;
    if (expectedArgs) {
      const a = JSON.stringify(rec.constructorArgs ?? null);
      const b = JSON.stringify(plain(expectedArgs)); // BigInt-safe (treasury dailyLimit 是 BigInt)
      if (a !== b) {
        log(`  ↻ ${name}: 构造参数变化 → 重部署`);
        return null;
      }
    }
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
        creationBytecodeHash: reuse.creationBytecodeHash,
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
        `      block    : ${rc.blockNumber}\n      gasUsed  : ${rc.gasUsed}`
    );
    deployed.push({
      name: key,
      address,
      txHash: tx.hash,
      blockNumber: rc.blockNumber,
      gasUsed: rc.gasUsed.toString(),
      bytecodeHash: ethers.keccak256(code), // 链上 runtime code 的 keccak256
      creationBytecodeHash: ethers.keccak256(art[key].bytecode), // 部署字节码
      constructorArgs: ctorArgs,
      contractVersion: version,
      reused: false,
      ...sourceNote,
    });
    return new ethers.Contract(address, art[key].abi, deployer);
  }

  // ══════════════════════════════════════════════════════════════════════
  hr("② 真部署 (MockERC20 / AgentEscrow v2 / AgentTreasury)");
  // ══════════════════════════════════════════════════════════════════════

  const tokenArtifactPath = "contracts/mocks/MockERC20.sol:MockERC20";
  const token = await deployOrReuse("MockERC20", [TOKEN_NAME, TOKEN_DECIMALS], "mock-erc20-v1", {
    sourcePath: tokenArtifactPath,
    role: "USDC 替身 (decimals=6)",
  });
  const tokenAddr = await token.getAddress();

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
    const { code: normalized, slots } = neutralizeImmutables(code, immutables[rec.name]);
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

  const tokenCode = await provider.getCode(tokenAddr);
  assert("\n  token decimals() == 6", (await token.decimals()) === 6n, `decimals=${await token.decimals()}`);
  log(`  token symbol/name: ${await token.symbol()} / ${await token.name()}`);
  assert("token eth_getCode 非空", tokenCode !== "0x", `codeLength=${(tokenCode.length - 2) / 2} bytes`);

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
  for (const k of ["MockERC20", "AgentEscrow", "AgentTreasury"]) {
    const p = path.join(ABIS_DIR, `${k}.json`);
    writeJson(p, art[k].abi);
    abiPaths[k] = path.relative(DEPLOYMENTS_DIR, p); // 相对 contracts/deployments/
    log(`  ABI → ${abiPaths[k]}`);
  }

  const escrowVersionOnChain = (await escrow.CONTRACT_VERSION()).toString();
  const manifest = {
    schemaVersion: 1,
    chainId: Number(chainId),
    networkName: NETWORK_NAME,
    deployedAt: new Date().toISOString(),
    rpcUrl: RPC_URL,
    deployerAddress: deployer.address,
    contracts: deployed.map((r) => ({
      name: r.name,
      address: r.address,
      txHash: r.txHash,
      blockNumber: r.blockNumber,
      bytecodeHash: r.bytecodeHash, // keccak256(eth_getCode(addr))
      creationBytecodeHash: r.creationBytecodeHash, // keccak256(部署字节码)
      constructorArgs: r.constructorArgs,
      contractVersion: r.contractVersion,
      sourcePath: r.sourcePath,
      role: r.role,
      reusedFromManifest: !!r.reused,
    })),
    // token 便捷入口 (USDC 替身)
    token: {
      name: TOKEN_NAME,
      symbol: TOKEN_NAME,
      address: tokenAddr,
      decimals: TOKEN_DECIMALS,
      decimalsOnChain: Number(await token.decimals()),
      isMock: true,
      note: "MockERC20 — 本地 USDC 替身, 非真实 USDC",
    },
    // 本部署切片里各合约的版本口径
    contractVersions: {
      AgentEscrow: {
        declaredOnChain_CONTRACT_VERSION: escrowVersionOnChain,
        semantic: "v2 (含 createEscrowV2/submitProofV2/releaseV2/claimAfterTimeoutV2 + F1 12 字段 + F3 事件)",
        modelFreezeRef: "MODEL_FREEZE.md §2.2/§3.2/§4/§5",
      },
      AgentTreasury: { semantic: "v1 (2026-08-13)" },
      MockERC20: { semantic: "mock-erc20-v1 (USDC 替身)" },
    },
    // ABI 存放路径 (相对 contracts/deployments/)
    abiPaths,
    // 编译产物溯源 (决定 bytecodeHash 的那次编译)
    build: {
      solcLongVersion: solidity?.solcLongVersion ?? null,
      optimizer: solidity?.optimizer ?? null,
      evmVersion: solidity?.evmVersion ?? null,
      immutableSlots: Object.fromEntries(
        Object.entries(immutables).map(([k, v]) => [k, Object.values(v).flat().length])
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
      token_initialMintToDeployer: TOKEN_SUPPLY.toString(),
    },
    notes: [
      "本地零成本部署: 默认账户派生自 anvil 公开开发助记符, 未使用任何真实钱包",
      "bytecodeHash = keccak256(链上 eth_getCode 返回的 runtime bytecode)",
      "chainId 31337 = anvil/hardhat 默认本地链",
    ],
    reproduce: {
      step1_anvil:
        "DYLD_LIBRARY_PATH=~/.local/lib ~/.foundry/bin/anvil --chain-id 31337 --port 8545 --host 127.0.0.1",
      step2_deploy: "cd contracts/evm && npx hardhat compile && node scripts/deploy.js",
      anvilNote:
        "本机 anvil/cast 动态链接要 /usr/local/opt/libusb/lib/libusb-1.0.0.dylib, 该路径不存在; " +
        "~/.local/lib/libusb-1.0.0.dylib 存在, 所以必须带 DYLD_LIBRARY_PATH。forge 不依赖 libusb, 无需该变量。",
      env: {
        RPC_URL: RPC_URL,
        NETWORK_NAME: NETWORK_NAME,
        DEPLOYER_PRIVATE_KEY: "默认 = 由 anvil 公开开发助记符派生的账户 #0 (非真实钱包)",
        AGENT_PRIVATE_KEY: "默认 = 同一助记符的账户 #1",
        FORCE_REDEPLOY: "1 = 忽略已有 manifest 全部重部署",
        SKIP_E2E: "1 = 跳过真交易闭环与 F2 断言",
      },
      idempotency:
        "重跑会复用 manifest 里的地址 (需 chainId 一致 + 链上 eth_getCode 的 keccak256 一致 + 构造参数一致), " +
        "不重复部署; 只用 manifest 里记录的原始部署 txHash/blockNumber。",
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

  if (!SKIP_E2E) {
    // ── token 分发 ─────────────────────────────────────────────────────────
    hr("⑤ 真交易闭环: createEscrowV2 → submitProofV2 → releaseV2");
    const buyer = deployer;
    const agentSigner = agent;
    const mintTx = await token.mint(buyer.address, TOKEN_SUPPLY);
    await mintTx.wait();
    const approveTx = await token.approve(escrowAddr, TOKEN_SUPPLY);
    await approveTx.wait();
    log(`  mint   tx: ${mintTx.hash}`);
    log(`  approve tx: ${approveTx.hash}`);

    const amount = ethers.parseUnits("100", 6);
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

    const mk = async (taskId, key, window) => {
      const t = await escrow.connect(buyer).createEscrowV2(
        key, agentSigner.address, ethers.parseUnits("10", 6), tokenAddr,
        contentHash(`terms:${taskId}`), contentHash(`quote:${taskId}`), contentHash(`input:${taskId}`),
        contentHash(`manifest:${taskId}`), BigInt((await provider.getBlock("latest")).timestamp) + 60n,
        window, PROOF_VERSION
      );
      return t.wait();
    };

    const rcB = await mk(taskIdB, taskKeyB, 60);
    const rcC = await mk(taskIdC, taskKeyC, 60);
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
      (await token.balanceOf(agentSigner.address)) - balBeforeClaimC === ethers.parseUnits("10", 6),
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
      tokenDecimalsIs6: Number(await token.decimals()) === 6,
      blockNumbers: deployed.map((r) => ({ name: r.name, blockNumber: r.blockNumber })),
      selectorChecks: selectorReport,
      topic0Checks: topicReport,
      topicsObservedInRealReceipts: [...seenTopics],
    };
    manifest.verificationReport = stateReport;
    writeJson(MANIFEST_PATH, manifest);
    log(`\n  manifest 已回填 verification + tradeLoop + f2Assertion → ${MANIFEST_PATH}`);
  } else {
    log("\n  (SKIP_E2E=1: 跳过真交易闭环与 F2 断言)");
  }

  // ══════════════════════════════════════════════════════════════════════
  hr("汇总");
  // ══════════════════════════════════════════════════════════════════════
  for (const r of deployed) {
    log(`  ${r.name.padEnd(14)} ${r.address}  tx ${r.txHash}  block ${r.blockNumber}${r.reused ? "  (复用)" : ""}`);
  }
  log(`\n  token decimals on-chain : ${await token.decimals()}`);
  log(`  escrow CONTRACT_VERSION : ${escrowVersionOnChain}`);
  log(`  manifest                : ${MANIFEST_PATH}`);
  log(`  ABI 目录                : ${path.relative(process.cwd(), ABIS_DIR)}/`);

  if (failures.length) {
    log(`\n  ❌ ${failures.length} 项断言失败:`);
    failures.forEach((f) => log(`     - ${f}`));
    process.exitCode = 1;
  } else {
    log("\n  ✅ 全部断言通过");
  }
}

main().catch((e) => {
  console.error("\n[deploy.js] 失败:", e.shortMessage || e.message || e);
  if (e.stack && process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
