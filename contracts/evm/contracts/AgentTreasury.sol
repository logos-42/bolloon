// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * AgentTreasury — Agent Economic Network 资金池 (2026-08-13)
 *
 * 经济规则 (Agent Economic Protocol §6 Governance):
 *   - 外部资金进入 Treasury (Human/Company → $)
 *   - 按分配规则 (weights) 分配: Agent rewards / Compute / Developers / Insurance / Protocol / Reserve
 *   - 任务完成 → pay(provider); 争议 → escrow; 信誉不足 → block; 日支出超限 → freeze
 *
 * 设计: ERC20 计价 (USDC), 无原生 ETH 转账 (稳定币结算).
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract AgentTreasury {
    IERC20 public immutable token;
    address public owner;

    // 分配权重 (分母 1000)
    struct Allocation {
        uint256 agentRewards;   // %
        uint256 compute;        // %
        uint256 developers;     // %
        uint256 insurance;      // %
        uint256 protocol;       // %
        uint256 reserve;        // %
    }
    Allocation public allocation;

    // 冻结状态
    bool public frozen;

    // Agent 注册 (白名单 + 信誉门槛)
    mapping(address => bool) public registeredAgents;
    mapping(address => uint256) public agentReputation; // 0-100

    // 日支出跟踪 (T1 修复: dailyLimit 是合约状态, 非调用参数)
    mapping(uint256 => uint256) public dailySpend; // day → total spent
    uint256 public dailyLimit;

    // T2 修复: 紧急提款 + 所有权转移
    uint256 public constant EMERGENCY_DELAY = 2 days;
    address public pendingOwner;
    uint256 public withdrawRequestedAt;

    event Deposited(address indexed from, uint256 amount);
    event AgentRegistered(address indexed agent, uint256 reputation);
    event AgentPaid(address indexed agent, uint256 amount);
    event Allocated(string category, uint256 amount);
    event FreezeToggled(bool frozen);
    event AllocationUpdated(Allocation allocation);
    event DailyLimitUpdated(uint256 dailyLimit);
    event OwnershipTransferRequested(address indexed pendingOwner);
    event OwnershipTransferred(address indexed newOwner);
    event EmergencyWithdraw(address indexed to, uint256 amount);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier notFrozen() { require(!frozen, "treasury frozen"); _; }

    constructor(address _token, uint256 _dailyLimit) {
        token = IERC20(_token);
        owner = msg.sender;
        dailyLimit = _dailyLimit;
        // 默认分配: rewards 40% / compute 20% / dev 15% / insurance 10% / protocol 10% / reserve 5%
        allocation = Allocation(400, 200, 150, 100, 100, 50);
    }

    // ============ 资金 ============

    /** 外部资金进入 Treasury (Human/Company → $) */
    function deposit(uint256 amount) external notFrozen {
        require(amount > 0, "amount must be > 0");
        require(token.transferFrom(msg.sender, address(this), amount), "transfer failed");
        emit Deposited(msg.sender, amount);
    }

    /** 分配一笔资金 (按权重) */
    function allocate(uint256 amount) external onlyOwner notFrozen {
        require(_allocationTotal() == 1000, "weights != 1000");
        _allocated("agentRewards", amount * allocation.agentRewards / 1000);
        _allocated("compute", amount * allocation.compute / 1000);
        _allocated("developers", amount * allocation.developers / 1000);
        _allocated("insurance", amount * allocation.insurance / 1000);
        _allocated("protocol", amount * allocation.protocol / 1000);
        _allocated("reserve", amount * allocation.reserve / 1000);
    }

    function _allocated(string memory cat, uint256 amt) private {
        if (amt == 0) return;
        emit Allocated(cat, amt);
    }

    /** T1 修复: 任务完成 → 支付 provider (dailyLimit 用合约状态, 不可绕过) */
    function payAgent(address agent, uint256 amount) external onlyOwner notFrozen {
        require(registeredAgents[agent], "agent not registered");
        require(agentReputation[agent] >= 60, "reputation too low");
        require(amount > 0, "amount must be > 0");

        uint256 day = block.timestamp / 1 days;
        require(dailySpend[day] + amount <= dailyLimit, "daily limit exceeded");
        dailySpend[day] += amount;

        require(token.transfer(agent, amount), "pay failed");
        emit AgentPaid(agent, amount);
    }

    // ============ Agent 管理 ============

    function registerAgent(address agent, uint256 reputation) external onlyOwner {
        require(agent != address(0), "agent cannot be zero");
        require(reputation <= 100, "reputation 0-100");
        registeredAgents[agent] = true;
        agentReputation[agent] = reputation;
        emit AgentRegistered(agent, reputation);
    }

    function updateReputation(address agent, uint256 reputation) external onlyOwner {
        require(registeredAgents[agent], "agent not registered");
        require(reputation <= 100, "reputation 0-100");
        agentReputation[agent] = reputation;
    }

    // ============ 配置 (T1/T3 修复) ============

    /** T3 修复: 更新分配权重 (总和必须 1000) */
    function updateAllocation(Allocation calldata newAlloc) external onlyOwner {
        require(newAlloc.agentRewards + newAlloc.compute + newAlloc.developers
            + newAlloc.insurance + newAlloc.protocol + newAlloc.reserve == 1000, "weights != 1000");
        allocation = newAlloc;
        emit AllocationUpdated(newAlloc);
    }

    /** T1 修复: 更新每日预算 */
    function updateDailyLimit(uint256 newLimit) external onlyOwner {
        dailyLimit = newLimit;
        emit DailyLimitUpdated(newLimit);
    }

    // ============ 所有权 (T2 修复) ============

    /** 两段式所有权转移 */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "new owner cannot be zero");
        pendingOwner = newOwner;
        emit OwnershipTransferRequested(newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "not pending owner");
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(msg.sender);
    }

    // ============ 冻结 ============

    function setFrozen(bool value) external onlyOwner {
        frozen = value;
        emit FreezeToggled(value);
    }

    // ============ 紧急 (T2 修复) ============

    /**
     * 紧急提款: 两段式 — 请求后等 EMERGENCY_DELAY 才能执行.
     * 防 owner 密钥丢失/被盗时资金永久锁定或立即被窃.
     */
    function requestEmergencyWithdraw() external onlyOwner {
        withdrawRequestedAt = block.timestamp;
    }

    function emergencyWithdraw(address to) external onlyOwner {
        require(block.timestamp >= withdrawRequestedAt + EMERGENCY_DELAY, "delay not elapsed");
        require(withdrawRequestedAt != 0, "not requested");
        uint256 bal = token.balanceOf(address(this));
        require(bal > 0, "no balance");
        require(token.transfer(to, bal), "withdraw failed");
        withdrawRequestedAt = 0;
        emit EmergencyWithdraw(to, bal);
    }

    /** 余额查询 (审计) */
    function balance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    function _allocationTotal() private view returns (uint256) {
        return allocation.agentRewards + allocation.compute + allocation.developers
            + allocation.insurance + allocation.protocol + allocation.reserve;
    }
}
