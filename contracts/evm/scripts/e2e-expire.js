#!/usr/bin/env node
/**
 * Bolloon — F2b `expire` 逃生路径的**真链验证** (本地 anvil, chainId 31337)
 * =========================================================================
 * 目的: 不是在 hardhat/forge 的内存 EVM 里"通过", 而是在真节点上**真发交易**, 拿到
 *   txHash / receipt.status / 前后余额变化 / 真事件日志 —— 证明:
 *     ① 无 proof + 过 grace 时, **无关第三方**发 `expireV2` 真能成功, 全额退 buyer, 状态 EXPIRED
 *     ② 有 proof 时 expire 真 revert ("proof exists"), 资金走 claimAfterTimeoutV2
 *     ③ 未过 grace 时 expire 真 revert ("grace not elapsed") —— 真发一笔 status 0 的交易
 *     ④ v1 `expire(bytes32)` 同样真链生效
 *     ⑤ 新选择器真的在链上 runtime code 里 (expireV2=0x02c58a63 / expire=0xc6441798),
 *        且 14 个旧方法选择器一个不少
 *
 * 边界 (刻意为之):
 *   - **只在本机 anvil 上部署一次性实例**, 绝不写 contracts/deployments/*.json、
 *     绝不改 ABI 文件、绝不碰已记录的 P2 部署 (0xe7f1…) —— 那个实例先于本次改动部署,
 *     它的 runtime code 里**没有** expireV2, 所以真交易验证必须用新编译的新实例。
 *   - 零真实钱包: 账户全部派生自 anvil 公开开发助记符; 绝不读 ~/.hermes/wallets/。
 *   - 非 31337 链直接拒绝 (除显式 ALLOW_NON_LOCAL=1)。
 *
 * 用法 (anvil 要先在跑):
 *   DYLD_LIBRARY_PATH=~/.local/lib ~/.foundry/bin/anvil --chain-id 31337 --port 8545 &
 *   cd contracts/evm && npx hardhat compile && node scripts/e2e-expire.js
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const EVM_DIR = path.resolve(__dirname, "..");
const ARTIFACTS_DIR = path.join(EVM_DIR, "artifacts", "contracts");

const DEV_MNEMONIC = "test test test test test test test test test test test junk";
const LOCAL_CHAIN_ID = 31337n;
const RELEASE_TIMEOUT = 7 * 86400;
const TOKEN_DECIMALS = 6;
const ESCROW_AMOUNT = ethers.parseUnits("10", 6);
const PROOF_VERSION = 1;

const TAG_TASK = ethers.encodeBytes32String("bolloon.task.v1");
const ABICODER = ethers.AbiCoder.defaultAbiCoder();

// 冻结选择器 (与新写入的测试一致): 新增 2 个 + 旧 14 个抽查
const SEL_EXPIRE_V2 = "02c58a63";
const SEL_EXPIRE = "c6441798";
const SEL_OLD = {
  "createEscrow(address,uint256,string)": "e334e8dd",
  "submitProof(bytes32,bytes32)": "968e72bd",
  "release(bytes32)": "67d42a8b",
  "claimAfterTimeout(bytes32)": "22399f5d",
  "dispute(bytes32)": "add98c70",
  "refund(bytes32)": "7249fbb6",
  "releaseAfterArbitration(bytes32)": "8b15b891",
  "createEscrowV2(...)": "152215b8",
  "submitProofV2(...)": "9037b29b",
  "releaseV2(bytes32)": "a7997ba4",
  "claimAfterTimeoutV2(bytes32)": "a53cf2b0",
  "disputeV2(bytes32,bytes32)": "484f5d07",
  "refundV2(bytes32,bytes32)": "f32b1e51",
  "releaseAfterArbitrationV2(bytes32)": "673765b0",
};

const log = (...a) => console.log(...a);
const hr = (t) => log(`\n${"─".repeat(74)}\n${t}\n${"─".repeat(74)}`);

function loadArtifact(rel, name) {
  const p = path.join(ARTIFACTS_DIR, rel, `${name}.json`);
  if (!fs.existsSync(p)) throw new Error(`找不到 artifact: ${p}\n先跑: cd contracts/evm && npx hardhat compile`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function main() {
  const failures = [];
  const assert = (label, cond, detail) => {
    log(`  ${cond ? "✅" : "❌"} ${label}${detail ? "  — " + detail : ""}`);
    if (!cond) failures.push(label);
    return cond;
  };

  const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
  const provider = new ethers.JsonRpcProvider(RPC_URL, null, { cacheTimeout: -1 });

  const mnemonic = ethers.Mnemonic.fromPhrase(DEV_MNEMONIC);
  const buyer = new ethers.Wallet(
    ethers.HDNodeWallet.fromMnemonic(mnemonic, "m/44'/60'/0'/0/0").privateKey, provider);
  const agent = new ethers.Wallet(
    ethers.HDNodeWallet.fromMnemonic(mnemonic, "m/44'/60'/0'/0/1").privateKey, provider);
  // 完全无关的第三方 (既不 deposit, 也不是 agent, 也不是 owner) —— permissionless 的验证者
  const thirdParty = new ethers.Wallet(
    ethers.HDNodeWallet.fromMnemonic(mnemonic, "m/44'/60'/0'/0/2").privateKey, provider);

  hr("① 连接本地链");
  const net = await provider.getNetwork();
  log(`  RPC      : ${RPC_URL}`);
  log(`  chainId  : ${net.chainId}   latestBlock: ${await provider.getBlockNumber()}`);
  if (net.chainId !== LOCAL_CHAIN_ID && process.env.ALLOW_NON_LOCAL !== "1") {
    throw new Error(`chainId=${net.chainId} 不是本地开发链 31337 — 拒绝执行 (ALLOW_NON_LOCAL=1 才能强行继续)`);
  }
  log(`  buyer      : ${buyer.address}`);
  log(`  agent      : ${agent.address}`);
  log(`  thirdParty : ${thirdParty.address}  (与 buyer/agent/owner 都无关)`);

  // ── 部署一次性实例 (不动 manifest / ABI) ────────────────────────────────
  hr("② 本地一次性部署 (MockERC20 + 新编译的 AgentEscrow) —— 不写 manifest");
  const tokenArt = loadArtifact(path.join("mocks", "MockERC20.sol"), "MockERC20");
  const escrowArt = loadArtifact("AgentEscrow.sol", "AgentEscrow");

  const tokenC = await new ethers.ContractFactory(tokenArt.abi, tokenArt.bytecode, buyer).deploy("USDC", TOKEN_DECIMALS);
  const rcToken = await tokenC.deploymentTransaction().wait();
  const tokenAddr = await tokenC.getAddress();
  const escrowC = await new ethers.ContractFactory(escrowArt.abi, escrowArt.bytecode, buyer).deploy(tokenAddr, RELEASE_TIMEOUT);
  const rcEscrow = await escrowC.deploymentTransaction().wait();
  const escrowAddr = await escrowC.getAddress();
  log(`  MockERC20    @ ${tokenAddr}  tx=${rcToken.hash}  status=${rcToken.status}  block=${rcToken.blockNumber}`);
  log(`  AgentEscrow  @ ${escrowAddr}  tx=${rcEscrow.hash}  status=${rcEscrow.status}  block=${rcEscrow.blockNumber}`);
  assert("两个合约部署 receipt.status == 1", rcToken.status === 1 && rcEscrow.status === 1);

  // ── 链上 runtime code 里的接口面 (硬证据: 新选择器真的在码里) ─────────────
  const runtime = (await provider.getCode(escrowAddr)).slice(2).toLowerCase();
  log(`\n  AgentEscrow runtime code: ${runtime.length / 2} bytes`);
  assert(`expireV2(bytes32) 选择器 0x${SEL_EXPIRE_V2} 在链上 runtime code 里`, runtime.includes(SEL_EXPIRE_V2));
  assert(`expire(bytes32) 选择器 0x${SEL_EXPIRE} 在链上 runtime code 里`, runtime.includes(SEL_EXPIRE));
  for (const [sig, sel] of Object.entries(SEL_OLD)) {
    assert(`旧方法 ${sig} (0x${sel}) 仍在 runtime code 里 (没被改掉)`, runtime.includes(sel));
  }

  const escrow = new ethers.Contract(escrowAddr, escrowArt.abi, buyer);
  const token = new ethers.Contract(tokenAddr, tokenArt.abi, buyer);

  // ── 资金准备 ────────────────────────────────────────────────────────────
  const mintTx = await token.mint(buyer.address, ethers.parseUnits("10000", 6));
  await mintTx.wait();
  const approveTx = await token.approve(escrowAddr, ethers.MaxUint256);
  await approveTx.wait();

  hr("③ expireGrace 口径 (链上真读)");
  const grace = await escrow.expireGrace();
  const graceDefault = await escrow.DEFAULT_EXPIRE_GRACE();
  log(`  expireGrace()            = ${grace}  (${Number(grace) / 86400} 天)`);
  log(`  DEFAULT_EXPIRE_GRACE()   = ${graceDefault}  (${Number(graceDefault) / 86400} 天)`);
  assert("默认 = 7 天", grace === 7n * 86400n && graceDefault === 7n * 86400n, `grace=${grace}`);
  assert("新合约的 owner = buyer(部署者)", (await escrow.owner()).toLowerCase() === buyer.address.toLowerCase());

  const sha = (s) => "sha256:" + ethers.sha256(ethers.toUtf8Bytes(s)).slice(2);
  const contentHash = (s) => ethers.keccak256(ethers.toUtf8Bytes(sha(s)));
  const runId = `${Date.now()}-${ethers.hexlify(ethers.randomBytes(4)).slice(2)}`;
  const taskKeyOf = (id) => ethers.keccak256(ABICODER.encode(["bytes32", "string"], [TAG_TASK, id]));
  const now = async () => BigInt((await provider.getBlock("latest")).timestamp);

  const mkEscrowV2 = async (key, taskId, window = 60) => {
    const t = await escrow.connect(buyer).createEscrowV2(
      key, agent.address, ESCROW_AMOUNT, tokenAddr,
      contentHash(`terms:${taskId}`), contentHash(`quote:${taskId}`), contentHash(`input:${taskId}`),
      contentHash(`manifest:${taskId}`), (await now()) + 60n, window, PROOF_VERSION
    );
    return t.wait();
  };
  const stateName = async (key) => ["ACTIVE", "RELEASED", "DISPUTED", "REFUNDED", "EXPIRED"][Number((await escrow.escrows(key)).state)];

  // ── 三个 escrow: E1 (无 proof, 主角) / E2 (有 proof, 阴性对照) / E3 (v1) ──
  hr("④ 建三个 escrow (E1 无 proof / E2 有 proof / E3 v1 legacy)");
  const id1 = `bolloon-local-expire-noproof-${runId}`;
  const key1 = taskKeyOf(id1);
  const rcE1 = await mkEscrowV2(key1, id1);
  log(`  E1 (v2, 无 proof) taskKey=${key1}  tx=${rcE1.hash}  status=${rcE1.status}  block=${rcE1.blockNumber}`);

  const id2 = `bolloon-local-expire-withproof-${runId}`;
  const key2 = taskKeyOf(id2);
  const rcE2 = await mkEscrowV2(key2, id2);
  const txProof2 = await escrow.connect(agent).submitProofV2(key2, contentHash(`result:${id2}`), contentHash(`manifest:${id2}`), PROOF_VERSION);
  const rcProof2 = await txProof2.wait();
  log(`  E2 (v2, 有 proof) taskKey=${key2}  tx=${rcE2.hash}  proofTx=${txProof2.hash}  status=${rcProof2.status}`);

  const id3 = `bolloon-local-expire-v1-${runId}`;
  const legacyKey3 = ethers.keccak256(ethers.toUtf8Bytes(id3));
  const txE3 = await escrow.connect(buyer).createEscrow(agent.address, ESCROW_AMOUNT, id3);
  const rcE3 = await txE3.wait();
  log(`  E3 (v1 legacy)    legacyKey=${legacyKey3}  tx=${txE3.hash}  status=${rcE3.status}`);

  const escrowBalAfterDeposits = await token.balanceOf(escrowAddr);
  assert("三个 escrow 共 30 USDC 已入托管", escrowBalAfterDeposits === ESCROW_AMOUNT * 3n, `balance=${escrowBalAfterDeposits}`);

  // ── ③ 阴性: 未过 grace 时真发 expireV2 → status 0 ──────────────────────
  hr("⑤ 阴性对照 A: 未过 grace, 第三方真发 expireV2 → 必须 status 0");
  const expireAt1 = await escrow.expireAt(key1);
  const claimableAt1 = await escrow.claimableAt(key1);
  log(`  E1 claimableAt=${claimableAt1}  expireAt=${expireAt1}  now=${await now()}  (差 = ${expireAt1 - claimableAt1} s = grace)`);
  assert("expireAt - claimableAt == expireGrace", expireAt1 - claimableAt1 === grace, `${expireAt1 - claimableAt1}`);

  let staticRevertA = null;
  try {
    await provider.call({ to: escrowAddr, from: thirdParty.address, data: escrow.interface.encodeFunctionData("expireV2", [key1]) });
  } catch (e) {
    staticRevertA = e.reason || e.shortMessage || e.message;
  }
  log(`  eth_call expireV2(E1) revert = "${staticRevertA}"`);
  assert('静态: revert reason == "grace not elapsed"', staticRevertA === "grace not elapsed", `got=${JSON.stringify(staticRevertA)}`);

  let realRcA = null, realTxA = null;
  try {
    const t = await thirdParty.sendTransaction({ to: escrowAddr, data: escrow.interface.encodeFunctionData("expireV2", [key1]), gasLimit: 300000 });
    realTxA = t.hash;
    realRcA = (await t.wait()).status;
  } catch (e) {
    realTxA = e.receipt ? e.receipt.hash : "n/a";
    realRcA = e.receipt ? e.receipt.status : `send failed: ${e.shortMessage || e.message}`;
  }
  log(`  真交易 expireV2(E1) tx=${realTxA}  receipt.status=${realRcA}`);
  assert("真链: 该笔交易 receipt.status == 0", realRcA === 0, `status=${realRcA}`);
  assert("真链: 未过 grace 时 E1 状态仍 ACTIVE, 钱没动", (await stateName(key1)) === "ACTIVE" && (await token.balanceOf(escrowAddr)) === escrowBalAfterDeposits);

  // ── 时间旅行越过所有 expireAt ────────────────────────────────────────────
  hr("⑥ 时间旅行: 越过 E1/E2 的 expireAt");
  const jump = Number(expireAt1 - (await now())) + 30;
  await provider.send("evm_increaseTime", [jump]);
  await provider.send("evm_mine", []);
  const nowAfter = await now();
  log(`  evm_increaseTime(+${jump}s) → now=${nowAfter}  E1.expireAt=${expireAt1}  E2.expireAt=${await escrow.expireAt(key2)}`);
  assert("已越过 E1 的 expireAt", nowAfter >= expireAt1, `now=${nowAfter} >= ${expireAt1}`);
  assert("已越过 E2 的 expireAt", nowAfter >= (await escrow.expireAt(key2)));

  // ── 阴性对照 B: 有 proof → expire 必须 revert ───────────────────────────
  hr("⑦ 阴性对照 B: 过了 grace 但**有 proof** → expireV2 必须 revert (走 claim 路径)");
  let staticRevertB = null;
  try {
    await provider.call({ to: escrowAddr, from: thirdParty.address, data: escrow.interface.encodeFunctionData("expireV2", [key2]) });
  } catch (e) {
    staticRevertB = e.reason || e.shortMessage || e.message;
  }
  log(`  eth_call expireV2(E2) revert = "${staticRevertB}"`);
  assert('静态: revert reason == "proof exists"', staticRevertB === "proof exists", `got=${JSON.stringify(staticRevertB)}`);
  assert("E2 仍 ACTIVE, 钱还在合约", (await stateName(key2)) === "ACTIVE");

  // 阳性: 有 proof 的合法出口 claimAfterTimeoutV2 (by=2)
  const agentBalBeforeClaim = await token.balanceOf(agent.address);
  const txClaim2 = await escrow.connect(agent).claimAfterTimeoutV2(key2);
  const rcClaim2 = await txClaim2.wait();
  const releasedLog = rcClaim2.logs.find((l) => l.topics[0] === escrow.interface.getEvent("ReleasedV2").topicHash);
  const releasedBy = releasedLog ? Number(escrow.interface.parseLog(releasedLog).args.by) : null;
  log(`  claimAfterTimeoutV2(E2) tx=${txClaim2.hash}  status=${rcClaim2.status}  ReleasedV2.by=${releasedBy}  state=${await stateName(key2)}`);
  assert("有 proof 时 claim 真链成功 (status 1, by=2 timeout, RELEASED)", rcClaim2.status === 1 && releasedBy === 2 && (await stateName(key2)) === "RELEASED");
  assert("agent 收到该笔 10 USDC", (await token.balanceOf(agent.address)) - agentBalBeforeClaim === ESCROW_AMOUNT);

  // ── 主角: 第三方真发 expireV2(E1) ───────────────────────────────────────
  hr("⑧ 主角: 无关第三方真发 expireV2(E1) —— 无 proof + 过 grace");
  const buyerBalBefore = await token.balanceOf(buyer.address);
  const agentBalBefore = await token.balanceOf(agent.address);
  const escrowBalBefore = await token.balanceOf(escrowAddr);

  const txExpire1 = await escrow.connect(thirdParty).expireV2(key1);
  const rcExpire1 = await txExpire1.wait();
  const expiredEvt = escrow.interface.getEvent("ExpiredV2");
  const expiredLog = rcExpire1.logs.find((l) => l.address.toLowerCase() === escrowAddr.toLowerCase() && l.topics[0] === expiredEvt.topicHash);
  const parsed = expiredLog ? escrow.interface.parseLog({ topics: expiredLog.topics, data: expiredLog.data }) : null;

  log(`\n  【真交易】expireV2(E1)`);
  log(`    txHash           : ${txExpire1.hash}`);
  log(`    receipt.status   : ${rcExpire1.status}   (1 = success)`);
  log(`    block            : ${rcExpire1.blockNumber}   gasUsed: ${rcExpire1.gasUsed}`);
  log(`    from (caller)    : ${txExpire1.from}   (= 无关第三方 ${thirdParty.address})`);
  log(`    ExpiredV2.topic0 : ${expiredEvt.topicHash}`);
  if (parsed) {
    log(`    ExpiredV2 decoded: taskKey=${parsed.args.taskKey}  caller=${parsed.args.caller}  refundedTo=${parsed.args.refundedTo}  amount=${parsed.args.amount}`);
  }
  log(`\n    buyer     余额: ${buyerBalBefore} → ${await token.balanceOf(buyer.address)}  (Δ ${(await token.balanceOf(buyer.address)) - buyerBalBefore})`);
  log(`    agent     余额: ${agentBalBefore} → ${await token.balanceOf(agent.address)}  (Δ ${(await token.balanceOf(agent.address)) - agentBalBefore})`);
  log(`    escrow    余额: ${escrowBalBefore} → ${await token.balanceOf(escrowAddr)}  (Δ ${(await token.balanceOf(escrowAddr)) - escrowBalBefore})`);
  log(`    E1 state       : ${await stateName(key1)}`);

  assert("receipt.status == 1 (真链成功, 不是静态调用)", rcExpire1.status === 1, `status=${rcExpire1.status}`);
  assert("ExpiredV2 事件已上链且字段正确", !!parsed
    && parsed.args.taskKey === key1
    && parsed.args.caller.toLowerCase() === thirdParty.address.toLowerCase()
    && parsed.args.refundedTo.toLowerCase() === buyer.address.toLowerCase()
    && parsed.args.amount === ESCROW_AMOUNT);
  assert("buyer 余额 +10 USDC (全额退给买家, 不是卖家)", (await token.balanceOf(buyer.address)) - buyerBalBefore === ESCROW_AMOUNT);
  assert("agent 余额没变 (无 proof 拿不到钱)", (await token.balanceOf(agent.address)) === agentBalBefore);
  assert("托管余额 -10 USDC (守恒)", (await token.balanceOf(escrowAddr)) === escrowBalBefore - ESCROW_AMOUNT);
  assert("E1 状态 == EXPIRED (枚举值 4)", (await escrow.escrows(key1)).state === 4n, `state=${(await escrow.escrows(key1)).state}`);

  // 重复调用
  let staticRevertRepeat = null;
  try {
    await provider.call({ to: escrowAddr, from: thirdParty.address, data: escrow.interface.encodeFunctionData("expireV2", [key1]) });
  } catch (e) {
    staticRevertRepeat = e.reason || e.shortMessage || e.message;
  }
  log(`\n  重复调用 expireV2(E1) revert = "${staticRevertRepeat}"`);
  assert('重复调用 revert "not active"', staticRevertRepeat === "not active", `got=${JSON.stringify(staticRevertRepeat)}`);

  // ── v1 路径真链 ─────────────────────────────────────────────────────────
  hr("⑨ v1 legacy 路径: 第三方真发 expire(bytes32)");
  const expireAt3 = await escrow.expireAt(legacyKey3);
  assert("v1 expireAt = claimableAt + grace", expireAt3 === (await escrow.claimableAt(legacyKey3)) + grace);
  const jump2 = Number(expireAt3 - (await now())) + 30;
  await provider.send("evm_increaseTime", [jump2]);
  await provider.send("evm_mine", []);
  log(`  evm_increaseTime(+${jump2}s) → now=${await now()}  E3.expireAt=${expireAt3}`);

  const buyerBalBefore3 = await token.balanceOf(buyer.address);
  const txExpire3 = await escrow.connect(thirdParty).expire(legacyKey3);
  const rcExpire3 = await txExpire3.wait();
  const log3 = rcExpire3.logs.find((l) => l.address.toLowerCase() === escrowAddr.toLowerCase() && l.topics[0] === expiredEvt.topicHash);
  const parsed3 = log3 ? escrow.interface.parseLog({ topics: log3.topics, data: log3.data }) : null;
  log(`\n  【真交易】expire(E3)`);
  log(`    txHash          : ${txExpire3.hash}`);
  log(`    receipt.status  : ${rcExpire3.status}`);
  log(`    block           : ${rcExpire3.blockNumber}   gasUsed: ${rcExpire3.gasUsed}`);
  log(`    buyer 余额 Δ    : ${(await token.balanceOf(buyer.address)) - buyerBalBefore3}`);
  log(`    E3 state        : ${await stateName(legacyKey3)}`);
  assert("v1 expire 真链 status == 1", rcExpire3.status === 1);
  assert("v1: buyer 全额退回", (await token.balanceOf(buyer.address)) - buyerBalBefore3 === ESCROW_AMOUNT);
  assert("v1: E3 状态 == EXPIRED", (await stateName(legacyKey3)) === "EXPIRED");
  assert("v1: ExpiredV2.caller == 第三方", !!parsed3 && parsed3.args.caller.toLowerCase() === thirdParty.address.toLowerCase());

  // ── 收尾: 托管里只剩已 RELEASED/DISPUTED 之外的钱应为 0 ─────────────────
  hr("⑩ 汇总");
  log(`  一次性部署 (未写入 manifest / ABI):`);
  log(`    MockERC20   ${tokenAddr}  tx=${rcToken.hash}`);
  log(`    AgentEscrow ${escrowAddr}  tx=${rcEscrow.hash}`);
  log(`  真交易:`);
  log(`    expireV2(E1) 未过 grace 失败 : ${realTxA}  status=${realRcA}`);
  log(`    claimAfterTimeoutV2(E2)       : ${txClaim2.hash}  status=${rcClaim2.status}`);
  log(`    expireV2(E1) 成功             : ${txExpire1.hash}  status=${rcExpire1.status}`);
  log(`    expire(E3, v1) 成功           : ${txExpire3.hash}  status=${rcExpire3.status}`);
  log(`  托管合约余额 (应 = 0: E1/E3 已过期退款, E2 已释放): ${await token.balanceOf(escrowAddr)}`);
  assert("收尾: 托管余额 == 0 (无残留)", (await token.balanceOf(escrowAddr)) === 0n, `balance=${await token.balanceOf(escrowAddr)}`);

  if (failures.length) {
    log(`\n  ❌ ${failures.length} 项断言失败:`);
    failures.forEach((f) => log(`     - ${f}`));
    process.exitCode = 1;
  } else {
    log("\n  ✅ 全部断言通过 (真链 4 笔交易, 其中 1 笔故意 status 0)");
  }
}

main().catch((e) => {
  console.error("\n[e2e-expire.js] 失败:", e.shortMessage || e.message || e);
  if (e.stack && process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
