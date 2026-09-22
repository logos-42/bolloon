const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * AgentEscrow 测试 (v1 legacy + v2 结算口径)
 *
 * v1 原 11 个用例全部保留, 只改 1 个 —— 因为 F2 修的是真漏洞:
 *   claimAfterTimeout 原来没有 proof 门槛 → 卖家超时无 proof 也能领钱。
 *   "E1: 超时后 agent 可 claim" 现在必须先 submitProof (见 F2 describe)。
 * v2 新增: F1 12 字段 / F3 事件 / 冻结 hash 切径 (链上 keccak256+abi.encode+域标签,
 *   链下 sha256:<hex>; proofHash = keccak256(abi.encode("bolloon.proof.v1", resultHash, proofVersion)))。
 * F2b 新增 (permisssionless expire 逃生路径):
 *   F2 修完之后留了一个对称缺口 —— agent 领钱必须有 proof, 而 refundV2 只在 DISPUTED 可用、
 *   dispute 只能由 buyer/agent 自己发起 ⇒ agent 不交 proof 且 buyer 不 dispute 时资金永久锁死。
 *   expireV2/expire 条件 = ACTIVE ∧ 无 proof ∧ now >= claimableAt + expireGrace (默认 7 天),
 *   效果 = 全额退 buyer + 状态 EXPIRED, **任何人可调** (下面用无关的 third-party signer 验证)。
 */

// ── 冻结 hash 切径: 链下独立复算 (不引用合约实现) ──
const abi = ethers.AbiCoder.defaultAbiCoder();
const TAG_TASK = ethers.encodeBytes32String("bolloon.task.v1");
const TAG_PROOF = ethers.encodeBytes32String("bolloon.proof.v1");

const taskKeyOf = (id) => ethers.keccak256(abi.encode(["bytes32", "string"], [TAG_TASK, id]));
const legacyKeyOf = (id) => ethers.keccak256(ethers.toUtf8Bytes(id));
const sha256Digest = (s) => "sha256:" + ethers.sha256(ethers.toUtf8Bytes(s)).slice(2);
const contentHashOf = (s) => ethers.keccak256(ethers.toUtf8Bytes(sha256Digest(s)));
const proofHashOf = (resultHash, version) =>
  ethers.keccak256(abi.encode(["bytes32", "bytes32", "uint16"], [TAG_PROOF, resultHash, version]));

describe("AgentEscrow — Agent 服务托管 (v1 legacy + v2)", function () {
  let token, escrow, tokenAddr, owner, buyer, agent, other, snapshotId;

  const RELEASE_TIMEOUT = 7 * 86400;
  const taskId = "task-abc-123";
  const amount = ethers.parseUnits("100", 6);
  const proofHash = ethers.keccak256(ethers.toUtf8Bytes("cid:QmResult123"));

  // v2 夹具 (hash 全走冻结口径)
  const v2TaskId = "task-v2-001";
  const v2Key = taskKeyOf(v2TaskId);
  const resultHash = contentHashOf("result-content");
  const inputHash = contentHashOf("canonical-input");
  const manifestHash = contentHashOf("canonical-manifest");
  const quoteHash = ethers.keccak256(ethers.toUtf8Bytes("quote:q-1")); // 链下算好的 bytes32
  const termsHash = ethers.keccak256(ethers.toUtf8Bytes("terms:t-1"));
  const PROOF_VERSION = 1;

  const now = async () => (await ethers.provider.getBlock("latest")).timestamp;
  const warp = async (secs) => {
    await ethers.provider.send("evm_increaseTime", [secs]);
    await ethers.provider.send("evm_mine", []);
  };

  beforeEach(async function () {
    // 快照隔离: evm_increaseTime 跨测试污染 (block.timestamp / day 计算)
    snapshotId = await ethers.provider.send("evm_snapshot", []);
    [owner, buyer, agent, other] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("contracts/mocks/MockERC20.sol:MockERC20");
    token = await MockERC20.deploy("USDC", 6);
    await token.waitForDeployment();
    tokenAddr = await token.getAddress();
    await token.mint(buyer.address, ethers.parseUnits("10000", 6));

    const Escrow = await ethers.getContractFactory("AgentEscrow");
    escrow = await Escrow.deploy(tokenAddr, RELEASE_TIMEOUT);
    await escrow.waitForDeployment();

    await token.connect(buyer).approve(await escrow.getAddress(), ethers.parseUnits("10000", 6));
  });

  afterEach(async function () {
    await ethers.provider.send("evm_revert", [snapshotId]);
  });

  /** 建一个 v2 escrow (默认参数全合法, 可逐项覆盖) */
  async function createV2(over = {}) {
    return escrow.connect(buyer).createEscrowV2(
      over.taskKey ?? v2Key,
      over.agent ?? agent.address,
      over.amount ?? amount,
      over.paymentAsset ?? tokenAddr,
      over.termsHash ?? termsHash,
      over.quoteHash ?? quoteHash,
      over.inputHash ?? inputHash,
      over.manifestHash ?? manifestHash,
      over.deadline ?? (await now()) + 3600,
      over.confirmationWindow ?? 3600,
      over.proofVersion ?? PROOF_VERSION
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  describe("v1 legacy (接口与事件保持可用)", function () {
    it("createEscrow 创建托管 (资金入池)", async function () {
      await escrow.connect(buyer).createEscrow(agent.address, amount, taskId);
      expect(await escrow.balance()).to.equal(amount);
      const id = ethers.keccak256(ethers.toUtf8Bytes(taskId));
      const e = await escrow.escrows(id);
      expect(e.buyer).to.equal(buyer.address);
      expect(e.agent).to.equal(agent.address);
      expect(e.state).to.equal(0); // ACTIVE
    });

    it("submitProof 后 buyer release 释放给 agent", async function () {
      await escrow.connect(buyer).createEscrow(agent.address, amount, taskId);
      const id = ethers.keccak256(ethers.toUtf8Bytes(taskId));
      await escrow.connect(agent).submitProof(id, proofHash);
      await escrow.connect(buyer).release(id);
      expect(await token.balanceOf(agent.address)).to.equal(amount);
      const e = await escrow.escrows(id);
      expect(e.state).to.equal(1); // RELEASED
    });

    it("无证明不能 release", async function () {
      await escrow.connect(buyer).createEscrow(agent.address, amount, taskId);
      const id = ethers.keccak256(ethers.toUtf8Bytes(taskId));
      await expect(escrow.connect(buyer).release(id)).to.be.revertedWith("no proof submitted");
    });

    it("dispute 冻结 → owner refund 退款给 buyer", async function () {
      await escrow.connect(buyer).createEscrow(agent.address, amount, taskId);
      const id = ethers.keccak256(ethers.toUtf8Bytes(taskId));
      await escrow.connect(agent).submitProof(id, proofHash);
      await escrow.connect(buyer).dispute(id);
      expect((await escrow.escrows(id)).state).to.equal(2); // DISPUTED
      await escrow.refund(id);
      expect(await token.balanceOf(buyer.address)).to.equal(ethers.parseUnits("10000", 6)); // 退回
      expect(await escrow.balance()).to.equal(0);
    });

    it("dispute 后 owner 仲裁释放给 agent", async function () {
      await escrow.connect(buyer).createEscrow(agent.address, amount, taskId);
      const id = ethers.keccak256(ethers.toUtf8Bytes(taskId));
      await escrow.connect(agent).submitProof(id, proofHash);
      await escrow.connect(buyer).dispute(id);
      await escrow.releaseAfterArbitration(id);
      expect(await token.balanceOf(agent.address)).to.equal(amount);
    });

    it("E2: agent 地址为 0 拒绝创建 (防资金黑洞)", async function () {
      await expect(escrow.connect(buyer).createEscrow(ethers.ZeroAddress, amount, "task-zero-agent"))
        .to.be.revertedWith("agent cannot be zero");
    });

    it("amount=0 拒绝创建", async function () {
      await expect(escrow.connect(buyer).createEscrow(agent.address, 0, "task-zero-amt"))
        .to.be.revertedWith("amount must be > 0");
    });

    it("E3: proofHash=0 拒绝提交 (0 不是有效证明)", async function () {
      await escrow.connect(buyer).createEscrow(agent.address, amount, "task-proof0");
      const id = ethers.keccak256(ethers.toUtf8Bytes("task-proof0"));
      await expect(escrow.connect(agent).submitProof(id, ethers.ZeroHash))
        .to.be.revertedWith("invalid proof");
    });

    it("E1: 超时前 agent 不能 claim", async function () {
      await escrow.connect(buyer).createEscrow(agent.address, amount, "task-timeout1");
      const id = ethers.keccak256(ethers.toUtf8Bytes("task-timeout1"));
      await expect(escrow.connect(agent).claimAfterTimeout(id))
        .to.be.revertedWith("timeout not reached");
    });

    it("E1: dispute 后不可 claim (争议优先)", async function () {
      await escrow.connect(buyer).createEscrow(agent.address, amount, "task-dispute-timeout");
      const id = ethers.keccak256(ethers.toUtf8Bytes("task-dispute-timeout"));
      await escrow.connect(agent).submitProof(id, proofHash);
      await escrow.connect(buyer).dispute(id);
      await warp(8 * 86400);
      await expect(escrow.connect(agent).claimAfterTimeout(id))
        .to.be.revertedWith("not active");
    });

    it("v1 键 = keccak256(abi.encodePacked(taskId)), 与 v2 taskKey 是不同值 (两个都要进 manifest)", async function () {
      expect(await escrow.computeLegacyTaskKey(taskId)).to.equal(legacyKeyOf(taskId));
      expect(await escrow.computeTaskKey(taskId)).to.equal(taskKeyOf(taskId));
      expect(legacyKeyOf(taskId)).to.not.equal(taskKeyOf(taskId));
    });

    it("v1 createEscrow 同时发 legacy + v2 事件 (v2 专属字段取诚实缺省 0)", async function () {
      const id = legacyKeyOf(taskId);
      const tx = escrow.connect(buyer).createEscrow(agent.address, amount, taskId);
      await expect(tx).to.emit(escrow, "EscrowCreated").withArgs(id, buyer.address, agent.address, amount);
      const e = await escrow.escrows(id);
      await expect(tx).to.emit(escrow, "EscrowCreatedV2")
        .withArgs(id, ethers.ZeroHash, buyer.address, agent.address, tokenAddr, amount,
                  e.deadline, RELEASE_TIMEOUT, 0, 1);
      expect(e.deadline).to.equal(BigInt(e.createdAt));
      expect(e.confirmationWindow).to.equal(RELEASE_TIMEOUT);
      expect(e.termsHash).to.equal(ethers.ZeroHash);
      expect(e.quoteHash).to.equal(ethers.ZeroHash);
      expect(e.inputHash).to.equal(ethers.ZeroHash);
      expect(e.proofVersion).to.equal(0);      // legacy = 未版本化, 不冒称 bolloon.proof.v1
      expect(e.contractVersion).to.equal(1);
      expect(e.paymentAsset).to.equal(tokenAddr);
      expect(e.chainId).to.equal((await ethers.provider.getNetwork()).chainId);
    });

    it("v2 之后仍可选 v1: v1 dispute/refund 路径不受影响", async function () {
      await escrow.connect(buyer).createEscrow(agent.address, amount, "task-v1-2");
      const id = legacyKeyOf("task-v1-2");
      await escrow.connect(buyer).dispute(id);
      await escrow.refund(id);
      expect((await escrow.escrows(id)).state).to.equal(3); // REFUNDED
    });

    it("构造参数校验: token=0 / releaseTimeout 超 uint32 拒绝", async function () {
      const Escrow = await ethers.getContractFactory("AgentEscrow");
      await expect(Escrow.deploy(ethers.ZeroAddress, RELEASE_TIMEOUT))
        .to.be.revertedWith("token cannot be zero");
      await expect(Escrow.deploy(tokenAddr, 2n ** 32n))
        .to.be.revertedWith("releaseTimeout too large");
    });

    it("v1 escrow 的 claim 时点仍 = createdAt + releaseTimeout (行为没变)", async function () {
      await escrow.connect(buyer).createEscrow(agent.address, amount, "task-v1-timing");
      const id = legacyKeyOf("task-v1-timing");
      const e = await escrow.escrows(id);
      expect(await escrow.claimableAt(id)).to.equal(BigInt(e.createdAt) + BigInt(RELEASE_TIMEOUT));
      expect(await escrow.claimableAt(id)).to.equal(BigInt(e.deadline) + BigInt(e.confirmationWindow));
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  describe("F2 漏洞修复: 无 proof 不得超时取款", function () {
    it("F2: 无 proof 超时 claim 被拒 (v1 路径) — 钱留在合约里", async function () {
      await escrow.connect(buyer).createEscrow(agent.address, amount, "task-f2-noproof");
      const id = legacyKeyOf("task-f2-noproof");
      await warp(8 * 86400); // 时间到了, 但没有任何完成证明
      await expect(escrow.connect(agent).claimAfterTimeout(id))
        .to.be.revertedWith("no proof submitted");
      expect(await token.balanceOf(agent.address)).to.equal(0); // 卖家一分没拿到
      expect(await escrow.balance()).to.equal(amount);          // 资金仍在托管合约
      expect((await escrow.escrows(id)).state).to.equal(0);     // 仍 ACTIVE
    });

    it("F2: 无 proof 超时 claim 被拒 (v2 路径)", async function () {
      const key = taskKeyOf("task-f2-v2");
      await createV2({ taskKey: key });
      await warp(7201); // deadline + confirmationWindow 已过
      await expect(escrow.connect(agent).claimAfterTimeoutV2(key))
        .to.be.revertedWith("no proof submitted");
      expect(await token.balanceOf(agent.address)).to.equal(0);
      expect(await escrow.balance()).to.equal(amount);
    });

    it("F2 反例对照: 有 proof 才超时 claim 成功 (+ReleasedV2 by=2)", async function () {
      await escrow.connect(buyer).createEscrow(agent.address, amount, "task-f2-withproof");
      const id = legacyKeyOf("task-f2-withproof");
      await escrow.connect(agent).submitProof(id, proofHash); // ← 与上一用例唯一差别
      await warp(8 * 86400);
      const tx = escrow.connect(agent).claimAfterTimeout(id);
      await expect(tx).to.emit(escrow, "ClaimedAfterTimeout").withArgs(id, agent.address, amount);
      await expect(tx).to.emit(escrow, "ReleasedV2").withArgs(id, agent.address, amount, 2); // by=2 timeout
      expect(await token.balanceOf(agent.address)).to.equal(amount);
      expect((await escrow.escrows(id)).state).to.equal(1); // RELEASED
    });

    it("F2 反例对照: v2 路径有 proof 后超时 claim 成功", async function () {
      const key = taskKeyOf("task-f2-v2-ok");
      await createV2({ taskKey: key, deadline: (await now()) + 60, confirmationWindow: 60 });
      await escrow.connect(agent).submitProofV2(key, resultHash, manifestHash, PROOF_VERSION);
      await warp(200);
      await expect(escrow.connect(agent).claimAfterTimeoutV2(key))
        .to.emit(escrow, "ReleasedV2").withArgs(key, agent.address, amount, 2);
      expect(await token.balanceOf(agent.address)).to.equal(amount);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  describe("F1: v2 字段 (taskKey 取代上链 string taskId)", function () {
    it("F1: createEscrowV2 写入 12 个 v2 字段 (逐字段核对)", async function () {
      const deadline = (await now()) + 7200;
      const rc = await (await createV2({ deadline, confirmationWindow: 1234 })).wait();
      const e = await escrow.escrows(v2Key);
      expect(e.taskKey).to.equal(v2Key);
      expect(e.termsHash).to.equal(termsHash);
      expect(e.quoteHash).to.equal(quoteHash);
      expect(e.inputHash).to.equal(inputHash);
      expect(e.manifestHash).to.equal(manifestHash);
      expect(e.chainId).to.equal(31337n);
      expect(e.contractVersion).to.equal(1);
      expect(e.createdBlock).to.equal(rc.blockNumber);
      expect(e.deadline).to.equal(deadline);
      expect(e.confirmationWindow).to.equal(1234);
      expect(e.paymentAsset).to.equal(tokenAddr);
      expect(e.proofVersion).to.equal(PROOF_VERSION);
      expect(await escrow.claimableAt(v2Key)).to.equal(BigInt(deadline) + 1234n);
      expect(e.buyer).to.equal(buyer.address);
      expect(e.agent).to.equal(agent.address);
      expect(e.amount).to.equal(amount);
    });

    it("F1: 上链 struct 无 string 字段; v2 接口完全没有 string 入参/出参", async function () {
      const names = escrow.interface.getFunction("escrows").outputs[0].components.map((c) => c.name);
      expect(names).to.not.include("taskId");
      expect(names).to.include("taskKey");
      const v2Strings = escrow.interface.fragments
        .filter((f) => f.type === "function" && f.name.endsWith("V2"))
        .flatMap((f) => [...(f.inputs || []), ...(f.outputs || [])])
        .filter((i) => i.type === "string");
      expect(v2Strings).to.have.length(0); // v2 不把 taskId 字符串上链
      // 链下 bytes32 → string 反查约定: computeTaskKey 可复算校验
      expect(await escrow.computeTaskKey(v2TaskId)).to.equal(v2Key);
    });

    it("F1: createEscrowV2 各参数校验", async function () {
      await expect(createV2({ quoteHash: ethers.ZeroHash })).to.be.revertedWith("quoteHash required");
      await expect(createV2({ termsHash: ethers.ZeroHash })).to.be.revertedWith("termsHash required");
      await expect(createV2({ taskKey: ethers.ZeroHash })).to.be.revertedWith("taskKey cannot be zero");
      await expect(createV2({ agent: ethers.ZeroAddress })).to.be.revertedWith("agent cannot be zero");
      await expect(createV2({ amount: 0 })).to.be.revertedWith("amount must be > 0");
      await expect(createV2({ paymentAsset: other.address })).to.be.revertedWith("unsupported payment asset");
      await expect(createV2({ confirmationWindow: 0 })).to.be.revertedWith("confirmationWindow must be > 0");
      await expect(createV2({ deadline: (await now()) - 10 })).to.be.revertedWith("deadline in past");
      await createV2();
      await expect(createV2()).to.be.revertedWith("task exists");
    });

    it("F1: 只有 v1 createEscrow(string) 带 string 上链入参; compute* 助手是 pure 无状态", async function () {
      const withString = escrow.interface.fragments
        .filter((f) => f.type === "function" && !f.name.startsWith("compute"))
        .filter((f) => (f.inputs || []).some((i) => i.type === "string"))
        .map((f) => f.name);
      expect(withString).to.deep.equal(["createEscrow"]); // 唯一遗留: v1 legacy 入口
      const helpers = escrow.interface.fragments.filter((f) => f.type === "function" && f.name.startsWith("compute"));
      expect(helpers.map((f) => f.stateMutability)).to.deep.equal(["pure", "pure", "pure", "pure"]);
      expect(helpers.map((f) => f.name).sort()).to.deep.equal(
        ["computeLegacyTaskKey", "computeProofHash", "computeResultHash", "computeTaskKey"]
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  describe("冻结 hash 切径 (链上 vs 链下独立复算)", function () {
    it("computeTaskKey / computeResultHash / computeProofHash 与链下口径一致", async function () {
      expect(await escrow.computeTaskKey("task-x")).to.equal(taskKeyOf("task-x"));
      expect(await escrow.computeLegacyTaskKey("task-x")).to.equal(legacyKeyOf("task-x"));
      expect(await escrow.computeResultHash(sha256Digest("result-content"))).to.equal(resultHash);
      expect(await escrow.computeProofHash(resultHash, PROOF_VERSION)).to.equal(proofHashOf(resultHash, PROOF_VERSION));
      expect(await escrow.computeProofHash(resultHash, PROOF_VERSION)).to.not.equal(resultHash);
    });

    it("computeResultHash 拒绝非 sha256:<hex> 口径", async function () {
      await expect(escrow.computeResultHash("deadbeef")).to.be.revertedWith("expected sha256:<hex>");
      await expect(escrow.computeResultHash("sha256:")).to.be.revertedWith("expected sha256:<hex>");
    });

    it("submitProofV2: 链上算 proofHash = keccak256(abi.encode(proof.v1, resultHash, proofVersion))", async function () {
      await createV2();
      const expected = proofHashOf(resultHash, PROOF_VERSION);
      const tx = escrow.connect(agent).submitProofV2(v2Key, resultHash, manifestHash, PROOF_VERSION);
      await expect(tx).to.emit(escrow, "ProofSubmittedV2")
        .withArgs(v2Key, resultHash, manifestHash, expected, PROOF_VERSION);
      const e = await escrow.escrows(v2Key);
      expect(e.proofHash).to.equal(expected); // 链上值 == 链下独立复算值
      expect(e.resultHash).to.equal(resultHash);
      expect(e.manifestHash).to.equal(manifestHash);
      expect(e.proofVersion).to.equal(PROOF_VERSION);
    });

    it("submitProofV2: proofVersion 绑进 proofHash (换版本 = 换哈希)", async function () {
      await createV2();
      await escrow.connect(agent).submitProofV2(v2Key, resultHash, manifestHash, PROOF_VERSION);
      const e = await escrow.escrows(v2Key);
      expect(e.proofHash).to.equal(proofHashOf(resultHash, PROOF_VERSION));
      expect(e.proofHash).to.not.equal(proofHashOf(resultHash, 2));
      expect(await escrow.computeProofHash(resultHash, 2)).to.not.equal(e.proofHash);
    });

    it("submitProofV2: resultHash=0 / proofVersion=0 / 非 agent 拒绝", async function () {
      await createV2();
      await expect(escrow.connect(agent).submitProofV2(v2Key, ethers.ZeroHash, manifestHash, 1))
        .to.be.revertedWith("resultHash required");
      await expect(escrow.connect(agent).submitProofV2(v2Key, resultHash, manifestHash, 0))
        .to.be.revertedWith("proofVersion required");
      await expect(escrow.connect(other).submitProofV2(v2Key, resultHash, manifestHash, 1))
        .to.be.revertedWith("only agent");
    });

    it("v1 submitProof 标 proofVersion=0 且只认调用方给的 proofHash", async function () {
      await escrow.connect(buyer).createEscrow(agent.address, amount, "task-v1-proofver");
      const id = legacyKeyOf("task-v1-proofver");
      await expect(escrow.connect(agent).submitProof(id, proofHash))
        .to.emit(escrow, "ProofSubmittedV2").withArgs(id, ethers.ZeroHash, ethers.ZeroHash, proofHash, 0);
      const e = await escrow.escrows(id);
      expect(e.proofVersion).to.equal(0);
      expect(e.proofHash).to.equal(proofHash);
      expect(e.resultHash).to.equal(ethers.ZeroHash);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  describe("F3: v2 事件 (谁是出金方 / 争议理由)", function () {
    beforeEach(async function () {
      await createV2();
    });

    it("EscrowCreatedV2 事件全字段", async function () {
      const key = taskKeyOf("task-evt");
      const deadline = (await now()) + 500;
      await expect(createV2({ taskKey: key, deadline, confirmationWindow: 900 }))
        .to.emit(escrow, "EscrowCreatedV2")
        .withArgs(key, quoteHash, buyer.address, agent.address, tokenAddr, amount,
                  deadline, 900, PROOF_VERSION, 1);
    });

    it("ReleasedV2 by=0 (buyer 确认)", async function () {
      await escrow.connect(agent).submitProofV2(v2Key, resultHash, manifestHash, PROOF_VERSION);
      const tx = escrow.connect(buyer).releaseV2(v2Key);
      await expect(tx).to.emit(escrow, "Released").withArgs(v2Key, agent.address, amount);
      await expect(tx).to.emit(escrow, "ReleasedV2").withArgs(v2Key, agent.address, amount, 0);
      expect(await token.balanceOf(agent.address)).to.equal(amount);
    });

    it("ReleasedV2 by=1 (仲裁释放, 与 buyer 确认可区分)", async function () {
      await escrow.connect(agent).submitProofV2(v2Key, resultHash, manifestHash, PROOF_VERSION);
      await escrow.connect(buyer).disputeV2(v2Key, ethers.keccak256(ethers.toUtf8Bytes("reason:bad")));
      await expect(escrow.releaseAfterArbitrationV2(v2Key))
        .to.emit(escrow, "ReleasedV2").withArgs(v2Key, agent.address, amount, 1);
      expect(await token.balanceOf(agent.address)).to.equal(amount);
    });

    it("DisputedV2 带发起人 + reasonHash (buyer 发起)", async function () {
      const reason = ethers.keccak256(ethers.toUtf8Bytes("reason:not-delivered"));
      await expect(escrow.connect(buyer).disputeV2(v2Key, reason))
        .to.emit(escrow, "DisputedV2").withArgs(v2Key, buyer.address, reason);
      expect((await escrow.escrows(v2Key)).state).to.equal(2); // DISPUTED
    });

    it("DisputedV2 由 agent 发起时 by=agent", async function () {
      const reason = ethers.keccak256(ethers.toUtf8Bytes("reason:buyer-unresponsive"));
      await expect(escrow.connect(agent).disputeV2(v2Key, reason))
        .to.emit(escrow, "DisputedV2").withArgs(v2Key, agent.address, reason);
    });

    it("非当事人不能 dispute", async function () {
      const key = taskKeyOf("task-not-party");
      await createV2({ taskKey: key });
      await expect(escrow.connect(other).disputeV2(key, ethers.ZeroHash))
        .to.be.revertedWith("not party");
    });

    it("RefundedV2 带 reasonHash (owner 仲裁退款)", async function () {
      const reason = ethers.keccak256(ethers.toUtf8Bytes("reason:task-failed"));
      await escrow.connect(buyer).disputeV2(v2Key, reason);
      const tx = escrow.refundV2(v2Key, reason);
      await expect(tx).to.emit(escrow, "RefundedV2").withArgs(v2Key, buyer.address, amount, reason);
      await expect(tx).to.emit(escrow, "Refunded").withArgs(v2Key, buyer.address, amount);
      expect(await token.balanceOf(buyer.address)).to.equal(ethers.parseUnits("10000", 6));
      expect(await escrow.balance()).to.equal(0);
    });

    it("v1 refund 走 v1 路径时 RefundedV2.reasonHash = 0 (不伪造理由)", async function () {
      const key = taskKeyOf("task-v1-refund");
      await createV2({ taskKey: key });
      await escrow.connect(buyer).dispute(key);
      await expect(escrow.refund(key))
        .to.emit(escrow, "RefundedV2").withArgs(key, buyer.address, amount, ethers.ZeroHash);
    });

    it("非 owner 不能 refundV2 / releaseAfterArbitrationV2", async function () {
      await escrow.connect(buyer).disputeV2(v2Key, ethers.ZeroHash);
      await expect(escrow.connect(buyer).refundV2(v2Key, ethers.ZeroHash)).to.be.revertedWith("not owner");
      await expect(escrow.connect(buyer).releaseAfterArbitrationV2(v2Key)).to.be.revertedWith("not owner");
    });

    it("状态机: 未 dispute 不能 refundV2 / 未 proof 不能 releaseV2", async function () {
      await expect(escrow.refundV2(v2Key, ethers.ZeroHash)).to.be.revertedWith("not disputed");
      await expect(escrow.connect(buyer).releaseV2(v2Key)).to.be.revertedWith("no proof submitted");
      await expect(escrow.connect(other).releaseV2(v2Key)).to.be.revertedWith("only buyer");
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  describe("F2b: permissionless expire 逃生路径 (无 proof + 超期 → 任何人可把全额退给 buyer)", function () {
    const EXPIRE_GRACE = 7 * 86400; // = 合约默认 expireGrace (DEFAULT_EXPIRE_GRACE)
    const EXPIRED = 4;              // 枚举末尾追加, 旧值 0/1/2/3 不动

    it("F2b: 无 proof + 过 grace → 第三个无关地址可调, buyer 收全额, 状态 EXPIRED", async function () {
      const key = taskKeyOf("task-f2b-noproof");
      await createV2({ taskKey: key }); // deadline = now+3600, window = 3600
      const buyerBalBefore = await token.balanceOf(buyer.address);

      // 口径: expireAt = claimableAt + expireGrace
      expect(await escrow.expireGrace()).to.equal(BigInt(EXPIRE_GRACE));
      expect(await escrow.DEFAULT_EXPIRE_GRACE()).to.equal(BigInt(EXPIRE_GRACE));
      expect(await escrow.expireAt(key)).to.equal((await escrow.claimableAt(key)) + BigInt(EXPIRE_GRACE));
      expect((await escrow.escrows(key)).proofHash).to.equal(ethers.ZeroHash);

      // 超时点已过但 grace 未过 → 还不许 expire (agent 仍有 claim 窗口)
      await warp(7201); // > deadline + confirmationWindow (7200)
      await expect(escrow.connect(other).expireV2(key)).to.be.revertedWith("grace not elapsed");
      expect((await escrow.escrows(key)).state).to.equal(0); // 仍 ACTIVE

      // 越过 grace
      await warp(EXPIRE_GRACE);
      const tx = escrow.connect(other).expireV2(key); // other = 与 buyer/agent/owner 都无关
      await expect(tx).to.emit(escrow, "ExpiredV2").withArgs(key, other.address, buyer.address, amount);
      await tx;
      await expect(escrow.connect(other).expireV2(key)).to.be.revertedWith("not active"); // 重复调用

      expect(await token.balanceOf(buyer.address)).to.equal(buyerBalBefore + amount); // 全额退 buyer
      expect(await token.balanceOf(agent.address)).to.equal(0);                        // agent 一分不得
      expect(await escrow.balance()).to.equal(0);                                     // 余额守恒 (合约清零)
      expect(await token.totalSupply()).to.equal(ethers.parseUnits("10000", 6));       // 总量守恒
      expect((await escrow.escrows(key)).state).to.equal(EXPIRED);
    });

    it("F2b: 有 proof 时 expire 必须 revert (与 F2 互补, 走 claim 路径)", async function () {
      const key = taskKeyOf("task-f2b-withproof");
      await createV2({ taskKey: key, deadline: (await now()) + 60, confirmationWindow: 60 });
      await escrow.connect(agent).submitProofV2(key, resultHash, manifestHash, PROOF_VERSION);

      await warp(EXPIRE_GRACE + 600); // 即使远超 grace
      await expect(escrow.connect(other).expireV2(key)).to.be.revertedWith("proof exists");
      expect((await escrow.escrows(key)).state).to.equal(0); // 无副作用
      expect(await token.balanceOf(buyer.address)).to.equal(ethers.parseUnits("9900", 6));
      expect(await escrow.balance()).to.equal(amount);

      // 有 proof 的合法出口: claimAfterTimeoutV2 (by=2 timeout)
      await expect(escrow.connect(agent).claimAfterTimeoutV2(key))
        .to.emit(escrow, "ReleasedV2").withArgs(key, agent.address, amount, 2);
      expect((await escrow.escrows(key)).state).to.equal(1); // RELEASED
      expect(await token.balanceOf(agent.address)).to.equal(amount);
    });

    it("F2b: 未超期 (含 grace 内最后一秒) 不能 expire", async function () {
      const key = taskKeyOf("task-f2b-timing");
      await createV2({ taskKey: key });

      await expect(escrow.connect(other).expireV2(key)).to.be.revertedWith("grace not elapsed"); // 刚创建

      const expAt = await escrow.expireAt(key);
      await warp(Number(expAt) - (await now()) - 5); // 停在 grace 内
      await expect(escrow.connect(other).expireV2(key)).to.be.revertedWith("grace not elapsed");

      await warp(10); // 越过 expireAt
      await escrow.connect(other).expireV2(key);
      expect((await escrow.escrows(key)).state).to.equal(EXPIRED);
    });

    it("F2b: RELEASED / REFUNDED / DISPUTED 都不能 expire (状态优先)", async function () {
      // RELEASED
      const k1 = taskKeyOf("task-f2b-released");
      await createV2({ taskKey: k1 });
      await escrow.connect(agent).submitProofV2(k1, resultHash, manifestHash, PROOF_VERSION);
      await escrow.connect(buyer).releaseV2(k1);
      // REFUNDED
      const k2 = taskKeyOf("task-f2b-refunded");
      await createV2({ taskKey: k2 });
      await escrow.connect(buyer).disputeV2(k2, ethers.keccak256(ethers.toUtf8Bytes("reason:x")));
      await escrow.refundV2(k2, ethers.keccak256(ethers.toUtf8Bytes("reason:x")));
      // DISPUTED
      const k3 = taskKeyOf("task-f2b-disputed");
      await createV2({ taskKey: k3 });
      await escrow.connect(buyer).disputeV2(k3, ethers.ZeroHash);

      expect((await escrow.escrows(k1)).state).to.equal(1); // RELEASED
      expect((await escrow.escrows(k2)).state).to.equal(3); // REFUNDED
      expect((await escrow.escrows(k3)).state).to.equal(2); // DISPUTED

      await warp(EXPIRE_GRACE + 7200 + 600); // 时间对三个都足够
      await expect(escrow.connect(other).expireV2(k1)).to.be.revertedWith("not active");
      await expect(escrow.connect(other).expireV2(k2)).to.be.revertedWith("not active");
      await expect(escrow.connect(other).expireV2(k3)).to.be.revertedWith("not active");
    });

    it("F2b: 未知 taskKey → unknown task (不写脏缺省记录, 不动资金)", async function () {
      const key = taskKeyOf("never-created");
      await warp(30 * 86400);
      await expect(escrow.connect(other).expireV2(key)).to.be.revertedWith("unknown task");
      expect((await escrow.escrows(key)).state).to.equal(0);
      expect((await escrow.escrows(key)).buyer).to.equal(ethers.ZeroAddress);
      expect(await escrow.balance()).to.equal(0);
    });

    it("F2b: expireGrace 默认 7 天且可配置 (onlyOwner / >0 / 上限), 生效值不是常量", async function () {
      const key = taskKeyOf("task-f2b-grace");
      await createV2({ taskKey: key });
      const expAtDefault = await escrow.expireAt(key);

      await expect(escrow.connect(other).setExpireGrace(3600)).to.be.revertedWith("not owner");
      await expect(escrow.setExpireGrace(0)).to.be.revertedWith("expireGrace must be > 0");
      await expect(escrow.setExpireGrace(2n ** 32n)).to.be.revertedWith("expireGrace too large");

      await expect(escrow.setExpireGrace(3600)).to.emit(escrow, "ExpireGraceUpdated").withArgs(EXPIRE_GRACE, 3600);
      expect(await escrow.expireGrace()).to.equal(3600n);
      expect(await escrow.expireAt(key)).to.equal(expAtDefault - BigInt(EXPIRE_GRACE) + 3600n);
    });

    it("F2b: v1 路径 (expire) 同样能救出被锁的资金, 且未超期/重复调用照样拒", async function () {
      await escrow.connect(buyer).createEscrow(agent.address, amount, "task-f2b-v1");
      const id = legacyKeyOf("task-f2b-v1");
      const claimAt = await escrow.claimableAt(id);
      expect(claimAt).to.equal(BigInt((await escrow.escrows(id)).createdAt) + BigInt(RELEASE_TIMEOUT)); // v1 行为没变
      expect(await escrow.expireAt(id)).to.equal(claimAt + BigInt(EXPIRE_GRACE));

      await expect(escrow.connect(other).expire(id)).to.be.revertedWith("grace not elapsed");

      // F2 之后 v1 无 proof 也不能 claim → 这就是"永久锁死"那条路
      await warp(RELEASE_TIMEOUT + 1);
      await expect(escrow.connect(agent).claimAfterTimeout(id)).to.be.revertedWith("no proof submitted");
      expect(await token.balanceOf(agent.address)).to.equal(0);

      await warp(EXPIRE_GRACE);
      const tx = escrow.connect(other).expire(id);
      await expect(tx).to.emit(escrow, "ExpiredV2").withArgs(id, other.address, buyer.address, amount);
      await tx;
      expect(await token.balanceOf(buyer.address)).to.equal(ethers.parseUnits("10000", 6)); // 全额退回
      expect(await escrow.balance()).to.equal(0);
      expect((await escrow.escrows(id)).state).to.equal(EXPIRED);
      await expect(escrow.connect(other).expire(id)).to.be.revertedWith("not active"); // 重复调用
    });

    it("F2b: 枚举只在末尾追加 + 旧方法选择器一个不改 + 新选择器冻结", async function () {
      // 枚举数值: 旧值 0..3 冻结, EXPIRED = 4 (由状态机用例实测: RELEASED=1/REFUNDED=3/DISPUTED=2/EXPIRED=4)
      const frozen = {
        "createEscrow(address,uint256,string)": "0xe334e8dd",
        "submitProof(bytes32,bytes32)": "0x968e72bd",
        "release(bytes32)": "0x67d42a8b",
        "claimAfterTimeout(bytes32)": "0x22399f5d",
        "dispute(bytes32)": "0xadd98c70",
        "refund(bytes32)": "0x7249fbb6",
        "releaseAfterArbitration(bytes32)": "0x8b15b891",
        "createEscrowV2(bytes32,address,uint256,address,bytes32,bytes32,bytes32,bytes32,uint64,uint32,uint16)": "0x152215b8",
        "submitProofV2(bytes32,bytes32,bytes32,uint16)": "0x9037b29b",
        "releaseV2(bytes32)": "0xa7997ba4",
        "claimAfterTimeoutV2(bytes32)": "0xa53cf2b0",
        "disputeV2(bytes32,bytes32)": "0x484f5d07",
        "refundV2(bytes32,bytes32)": "0xf32b1e51",
        "releaseAfterArbitrationV2(bytes32)": "0x673765b0",
        "computeTaskKey(string)": "0xfd48b732",
        "computeLegacyTaskKey(string)": "0xc6921af6",
        "computeResultHash(string)": "0xe4a30dda",
        "computeProofHash(bytes32,uint16)": "0x70ee6f77",
        "claimableAt(bytes32)": "0xc6e1c6d7",
        "escrows(bytes32)": "0x2d83549c",
        "balance()": "0xb69ef8a8",
        // 本次新增
        "expire(bytes32)": "0xc6441798",
        "expireV2(bytes32)": "0x02c58a63",
        "expireAt(bytes32)": "0x12d89732",
        "setExpireGrace(uint256)": "0x5c9442f1",
        "expireGrace()": "0x3a6ff880",
        "DEFAULT_EXPIRE_GRACE()": "0x57500bdd",
      };
      for (const [sig, sel] of Object.entries(frozen)) {
        expect(escrow.interface.getFunction(sig).selector, sig).to.equal(sel);
      }
      // 全 ABI 无选择器冲突 (新增 4 个函数没撞任何既有函数)
      const selectors = escrow.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.selector);
      expect(new Set(selectors).size).to.equal(selectors.length);
      // 旧 7 个 v1 方法 + 旧 7 个 v2 方法全部还在 (没被删改)
      const names = escrow.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
      [
        "createEscrow", "submitProof", "release", "claimAfterTimeout", "dispute", "refund", "releaseAfterArbitration",
        "createEscrowV2", "submitProofV2", "releaseV2", "claimAfterTimeoutV2", "disputeV2", "refundV2", "releaseAfterArbitrationV2",
        "expire", "expireV2",
      ].forEach((n) => expect(names, n).to.include(n));
      // struct 形状没变 (仍 19 个字段, 没为 grace 塞新字段)
      expect(escrow.interface.getFunction("escrows").outputs[0].components).to.have.length(19);
    });
  });
});
