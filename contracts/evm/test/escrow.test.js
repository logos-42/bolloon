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
});
