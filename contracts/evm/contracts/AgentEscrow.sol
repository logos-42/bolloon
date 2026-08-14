// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * AgentEscrow — Agent 服务托管 (2026-08-13)
 *
 * 流程 (Agent Economic Protocol §5 Proof→Payment):
 *   buyer 存款 → agent 执行任务 → proof (完成证明) → release 给 agent
 *   争议 → 冻结 → 仲裁
 *
 * 经济规则: 完成任务才释放; 争议挂起; 未完成可退款.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract AgentEscrow {
    IERC20 public immutable token;
    address public owner;

    enum EscrowState { ACTIVE, RELEASED, DISPUTED, REFUNDED }

    struct Escrow {
        address buyer;
        address agent;
        uint256 amount;
        EscrowState state;
        string taskId;
        uint256 createdAt;
        bytes32 proofHash;   // 完成证明 (结果 CID 的 hash)
    }

    mapping(bytes32 => Escrow) public escrows; // taskId → escrow
    bytes32[] public taskIds;

    event EscrowCreated(bytes32 indexed taskId, address buyer, address agent, uint256 amount);
    event ProofSubmitted(bytes32 indexed taskId, bytes32 proofHash);
    event Released(bytes32 indexed taskId, address agent, uint256 amount);
    event Disputed(bytes32 indexed taskId);
    event Refunded(bytes32 indexed taskId, address buyer, uint256 amount);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address _token) {
        token = IERC20(_token);
        owner = msg.sender;
    }

    /** buyer 创建托管 (存款 USDC) */
    function createEscrow(address agent, uint256 amount, string calldata taskId) external {
        bytes32 id = _taskHash(taskId);
        require(escrows[id].buyer == address(0), "task exists");
        require(token.transferFrom(msg.sender, address(this), amount), "deposit failed");
        escrows[id] = Escrow(msg.sender, agent, amount, EscrowState.ACTIVE, taskId, block.timestamp, bytes32(0));
        taskIds.push(id);
        emit EscrowCreated(id, msg.sender, agent, amount);
    }

    /** agent 提交完成证明 (proofHash = 结果 CID hash) */
    function submitProof(bytes32 taskId, bytes32 proofHash) external {
        Escrow storage e = escrows[taskId];
        require(e.state == EscrowState.ACTIVE, "not active");
        require(msg.sender == e.agent, "only agent");
        e.proofHash = proofHash;
        emit ProofSubmitted(taskId, proofHash);
    }

    /** buyer 确认完成 → 释放给 agent */
    function release(bytes32 taskId) external {
        Escrow storage e = escrows[taskId];
        require(e.state == EscrowState.ACTIVE, "not active");
        require(msg.sender == e.buyer, "only buyer");
        require(e.proofHash != bytes32(0), "no proof submitted");
        e.state = EscrowState.RELEASED;
        require(token.transfer(e.agent, e.amount), "release failed");
        emit Released(taskId, e.agent, e.amount);
    }

    /** 争议: 冻结资金 (买方/agent 均可发起) */
    function dispute(bytes32 taskId) external {
        Escrow storage e = escrows[taskId];
        require(e.state == EscrowState.ACTIVE, "not active");
        require(msg.sender == e.buyer || msg.sender == e.agent, "not party");
        e.state = EscrowState.DISPUTED;
        emit Disputed(taskId);
    }

    /** 仲裁/退款 (owner 仲裁后) */
    function refund(bytes32 taskId) external onlyOwner {
        Escrow storage e = escrows[taskId];
        require(e.state == EscrowState.DISPUTED, "not disputed");
        e.state = EscrowState.REFUNDED;
        require(token.transfer(e.buyer, e.amount), "refund failed");
        emit Refunded(taskId, e.buyer, e.amount);
    }

    /** 仲裁后释放给 agent (owner 仲裁: 任务确实完成) */
    function releaseAfterArbitration(bytes32 taskId) external onlyOwner {
        Escrow storage e = escrows[taskId];
        require(e.state == EscrowState.DISPUTED, "not disputed");
        e.state = EscrowState.RELEASED;
        require(token.transfer(e.agent, e.amount), "release failed");
        emit Released(taskId, e.agent, e.amount);
    }

    function _taskHash(string calldata taskId) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(taskId));
    }

    /** 余额 (审计) */
    function balance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }
}
