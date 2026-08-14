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

    // 日支出跟踪
    mapping(uint256 => uint256) public dailySpend; // day → total spent

    event Deposited(address indexed from, uint256 amount);
    event AgentRegistered(address indexed agent, uint256 reputation);
    event AgentPaid(address indexed agent, uint256 amount);
    event Allocated(string category, uint256 amount);
    event FreezeToggled(bool frozen);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier notFrozen() { require(!frozen, "treasury frozen"); _; }

    constructor(address _token) {
        token = IERC20(_token);
        owner = msg.sender;
        // 默认分配: rewards 40% / compute 20% / dev 15% / insurance 10% / protocol 10% / reserve 5%
        allocation = Allocation(400, 200, 150, 100, 100, 50);
    }

    // ============ 资金 ============

    /** 外部资金进入 Treasury (Human/Company → $) */
    function deposit(uint256 amount) external notFrozen {
        require(token.transferFrom(msg.sender, address(this), amount), "transfer failed");
        emit Deposited(msg.sender, amount);
    }

    /** 分配一笔资金 (按权重) */
    function allocate(uint256 amount) external onlyOwner notFrozen {
        uint256 total = allocation.agentRewards + allocation.compute + allocation.developers
            + allocation.insurance + allocation.protocol + allocation.reserve;
        require(total == 1000, "weights != 1000");
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

    /** 任务完成 → 支付 provider (含信誉门槛 + 日预算) */
    function payAgent(address agent, uint256 amount, uint256 dailyLimit) external onlyOwner notFrozen {
        require(registeredAgents[agent], "agent not registered");
        require(agentReputation[agent] >= 60, "reputation too low");

        uint256 day = block.timestamp / 1 days;
        require(dailySpend[day] + amount <= dailyLimit, "daily limit exceeded");
        dailySpend[day] += amount;

        require(token.transfer(agent, amount), "pay failed");
        emit AgentPaid(agent, amount);
    }

    // ============ Agent 管理 ============

    function registerAgent(address agent, uint256 reputation) external onlyOwner {
        registeredAgents[agent] = true;
        agentReputation[agent] = reputation;
        emit AgentRegistered(agent, reputation);
    }

    function updateReputation(address agent, uint256 reputation) external onlyOwner {
        require(registeredAgents[agent], "agent not registered");
        agentReputation[agent] = reputation;
    }

    // ============ 冻结 ============

    function setFrozen(bool value) external onlyOwner {
        frozen = value;
        emit FreezeToggled(value);
    }

    /** 余额查询 (审计) */
    function balance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }
}
