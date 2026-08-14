const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AgentTreasury — Agent 经济资金池", function () {
  let token, treasury, owner, agent, buyer;

  beforeEach(async function () {
    [owner, agent, buyer] = await ethers.getSigners();
    // 简单 ERC20 (mint 给 owner)
    const MockERC20 = await ethers.getContractFactory("contracts/mocks/MockERC20.sol:MockERC20");
    token = await MockERC20.deploy("USDC", 6);
    await token.waitForDeployment();
    await token.mint(owner.address, ethers.parseUnits("10000", 6));

    const Treasury = await ethers.getContractFactory("AgentTreasury");
    treasury = await Treasury.deploy(await token.getAddress());
    await treasury.waitForDeployment();

    await token.approve(await treasury.getAddress(), ethers.parseUnits("10000", 6));
    await treasury.registerAgent(agent.address, 90);
  });

  it("deposit 外部资金进入 Treasury", async function () {
    const amt = ethers.parseUnits("1000", 6);
    await treasury.deposit(amt);
    expect(await treasury.balance()).to.equal(amt);
  });

  it("allocate 按权重分配 (事件)", async function () {
    await treasury.deposit(ethers.parseUnits("1000", 6));
    await expect(treasury.allocate(ethers.parseUnits("1000", 6)))
      .to.emit(treasury, "Allocated").withArgs("agentRewards", ethers.parseUnits("400", 6));
  });

  it("payAgent 信誉不足拒绝", async function () {
    await treasury.deposit(ethers.parseUnits("1000", 6));
    await treasury.registerAgent(agent.address, 30); // 信誉低
    await expect(treasury.payAgent(agent.address, ethers.parseUnits("10", 6), ethers.parseUnits("100", 6)))
      .to.be.revertedWith("reputation too low");
  });

  it("payAgent 日预算超限拒绝", async function () {
    await treasury.deposit(ethers.parseUnits("1000", 6));
    const dayLimit = ethers.parseUnits("50", 6);
    await treasury.payAgent(agent.address, ethers.parseUnits("30", 6), dayLimit);
    await expect(treasury.payAgent(agent.address, ethers.parseUnits("30", 6), dayLimit))
      .to.be.revertedWith("daily limit exceeded");
  });

  it("payAgent 成功支付 + 日支出记录", async function () {
    await treasury.deposit(ethers.parseUnits("1000", 6));
    await treasury.payAgent(agent.address, ethers.parseUnits("10", 6), ethers.parseUnits("100", 6));
    expect(await token.balanceOf(agent.address)).to.equal(ethers.parseUnits("10", 6));
    const day = BigInt(Math.floor(Date.now() / 86400000));
    expect(await treasury.dailySpend(day)).to.equal(ethers.parseUnits("10", 6));
  });

  it("frozen 后拒绝所有操作", async function () {
    await treasury.deposit(ethers.parseUnits("1000", 6));
    await treasury.setFrozen(true);
    await expect(treasury.deposit(ethers.parseUnits("1", 6))).to.be.revertedWith("treasury frozen");
    await expect(treasury.payAgent(agent.address, ethers.parseUnits("1", 6), ethers.parseUnits("100", 6)))
      .to.be.revertedWith("treasury frozen");
  });
});
