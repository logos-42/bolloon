const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AgentEscrow — Agent 服务托管", function () {
  let token, escrow, owner, buyer, agent;

  beforeEach(async function () {
    [owner, buyer, agent] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("contracts/mocks/MockERC20.sol:MockERC20");
    token = await MockERC20.deploy("USDC", 6);
    await token.waitForDeployment();
    await token.mint(buyer.address, ethers.parseUnits("10000", 6));

    const Escrow = await ethers.getContractFactory("AgentEscrow");
    escrow = await Escrow.deploy(await token.getAddress());
    await escrow.waitForDeployment();

    await token.connect(buyer).approve(await escrow.getAddress(), ethers.parseUnits("10000", 6));
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
});
