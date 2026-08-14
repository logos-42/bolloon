const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AgentEscrow — Agent 服务托管", function () {
  let token, escrow, owner, buyer, agent, snapshotId;

  beforeEach(async function () {
    // 快照隔离: evm_increaseTime 跨测试污染 (block.timestamp / day 计算)
    snapshotId = await ethers.provider.send("evm_snapshot", []);
    [owner, buyer, agent] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("contracts/mocks/MockERC20.sol:MockERC20");
    token = await MockERC20.deploy("USDC", 6);
    await token.waitForDeployment();
    await token.mint(buyer.address, ethers.parseUnits("10000", 6));

    const Escrow = await ethers.getContractFactory("AgentEscrow");
    escrow = await Escrow.deploy(await token.getAddress(), 7 * 86400); // releaseTimeout = 7 days
    await escrow.waitForDeployment();

    await token.connect(buyer).approve(await escrow.getAddress(), ethers.parseUnits("10000", 6));
  });

  afterEach(async function () {
    await ethers.provider.send("evm_revert", [snapshotId]);
  });

  const taskId = "task-abc-123";
  const amount = ethers.parseUnits("100", 6);
  const proofHash = ethers.keccak256(ethers.toUtf8Bytes("cid:QmResult123"));

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

  // ============ 完备性: 漏洞修复验证 (E1/E2/E3) ============

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

  it("E1: 超时后 agent 可 claim (防资金永久锁定)", async function () {
    await escrow.connect(buyer).createEscrow(agent.address, amount, "task-timeout2");
    const id = ethers.keccak256(ethers.toUtf8Bytes("task-timeout2"));
    // 快进 8 天
    await ethers.provider.send("evm_increaseTime", [8 * 86400]);
    await ethers.provider.send("evm_mine", []);
    await escrow.connect(agent).claimAfterTimeout(id);
    expect(await token.balanceOf(agent.address)).to.equal(amount);
  });

  it("E1: dispute 后不可 claim (争议优先)", async function () {
    await escrow.connect(buyer).createEscrow(agent.address, amount, "task-dispute-timeout");
    const id = ethers.keccak256(ethers.toUtf8Bytes("task-dispute-timeout"));
    await escrow.connect(agent).submitProof(id, proofHash);
    await escrow.connect(buyer).dispute(id);
    await ethers.provider.send("evm_increaseTime", [8 * 86400]);
    await ethers.provider.send("evm_mine", []);
    await expect(escrow.connect(agent).claimAfterTimeout(id))
      .to.be.revertedWith("not active");
  });
});
