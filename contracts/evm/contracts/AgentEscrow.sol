// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * AgentEscrow — Agent 服务托管 / 链上结算
 *
 * 流程 (Agent Economic Protocol §5 Proof→Payment):
 *   buyer 存款 → agent 执行任务 → proof (完成证明) → release 给 agent
 *   争议 → 冻结 → 仲裁
 *
 * 经济规则: 完成任务才释放; 争议挂起; 未完成可退款.
 *
 * ══ 版本 ═══════════════════════════════════════════════════════════════════
 * v1 (legacy, 2026-08-13): createEscrow(string taskId) / submitProof / release /
 *   claimAfterTimeout / dispute / refund / releaseAfterArbitration
 *   —— **全部保留**, 6 个旧事件签名不变, 函数选择器不变 (旧客户端继续可用)。
 * v2 (2026-09-22, MODEL_FREEZE.md §2.2/§3.2/§4): createEscrowV2 / submitProofV2 /
 *   releaseV2 / claimAfterTimeoutV2 / disputeV2 / refundV2 / releaseAfterArbitrationV2
 *   —— 上链任务标识从 `string taskId` 收紧为 `bytes32 taskKey`, 并补齐
 *   termsHash / quoteHash / inputHash / resultHash / manifestHash / chainId /
 *   contractVersion / createdBlock / deadline / confirmationWindow / paymentAsset /
 *   proofVersion 共 12 个字段 (F1)。
 *   v1 路径写入的 v2 字段一律取"诚实缺省": proofVersion = 0 (= 未版本化 legacy 证明),
 *   termsHash / quoteHash / inputHash / manifestHash = 0 (= 未提供), 绝不伪造数据。
 *
 * ══ F2 (真漏洞, 已修) ═══════════════════════════════════════════════════════
 *   旧 `claimAfterTimeout` 没有 proof 门槛 → 卖家超时即可无证明领钱。
 *   现在 v1 `claimAfterTimeout` 与 v2 `claimAfterTimeoutV2` **都要求**
 *   `proofHash != bytes32(0)`。无证明的资金退出路径 = buyer 发 dispute → owner refund。
 *
 * ══ F2b: F2 修出来的对称缺口 —— 永久锁死, 已用 permissionless `expire` 修 ══════
 *   问题 (真实存在, 不是理论): F2 之后 agent 领钱必须有 proof, 而 `refundV2` 只在
 *   `DISPUTED` 可用、`_dispute` 只允许 buyer/agent 自己发起 (owner 不能代替发起)。
 *   ⇒ 若 **agent 不交 proof 且 buyer 也不 dispute** (buyer 丢钥匙 / 不活跃 / 懒得花 gas),
 *     这笔钱没有任何人能取走 —— 资金**永久锁死**。
 *   修法: 新增 permissionless `expireV2(bytes32)` / `expire(bytes32)`:
 *     条件 = 状态 ACTIVE ∧ 无 proof (`proofHash == 0`) ∧
 *            `block.timestamp >= claimableAt(e) + expireGrace`
 *     效果 = **全额退回 buyer** (不是卖家), 状态 → EXPIRED, 发 `ExpiredV2`。
 *   与 F2 互补、不冲突 (二者互斥, 有 proof 只能走 claim, 无 proof 只能走 expire):
 *     · 有 proof          → expire revert "proof exists"        (走 claimAfterTimeout*)
 *     · 未过 grace        → expire revert "grace not elapsed"   (agent 仍有 claim 机会)
 *     · 非 ACTIVE         → expire revert "not active" (RELEASED/REFUNDED/DISPUTED/EXPIRED/重复调用)
 *   调用者不受限 (**任何人可调**, 第三方也能把买家的钱救出来) → 摆脱"必须有一方作为"的死结。
 *   为什么退 buyer 而不是卖家: 契约上无 proof = 交付未被证明, 无辜方是已经付了钱的 buyer。
 *   注意: `expireGrace` 是**全局参数**, 对已存在的 ACTIVE escrow 立即生效 (不做 per-task 快照);
 *   agent 的自我保护方式 = 在 grace 内提交 proof, 一旦上链就只能走 claim 路径。
 *   v1 路径的判断 (为什么不盲目只修 v2): v1 **有同样的洞** ——
 *   `claimAfterTimeout` 已被 F2 加了 proof 门槛, 而 v1 `refund` 同样 onlyOwner + 仅 DISPUTED,
 *   且 owner 无法自己把 escrow 推进 DISPUTED。角色换成 buyer 一样会永久锁死,
 *   所以 v1 也补 `expire(bytes32)` (签名与 v1 其余方法一致, 收 bytes32 键)。
 *
 * ══ F3 v2 事件 (为什么必须补) ════════════════════════════════════════════════
 *   旧口径下 `release`(buyer 确认) 与 `releaseAfterArbitration`(仲裁) 共用 `Released`,
 *   事件里分不清是谁出的金; `Disputed` 无发起人/理由。
 *   v2 口径: `ReleasedV2.by` (0=buyer 1=仲裁 2=超时) + `DisputedV2(by, reasonHash)`。
 *   每次状态变更同时发 legacy + v2 事件 (legacy 只对 v1 语义的调用发同名旧事件,
 *   超时路径仍只发 `ClaimedAfterTimeout`, 不给旧 `Released` 增加歧义)。
 *
 * ══ hash 切径 (冻结, MODEL_FREEZE.md §4: 链上 keccak256 / 链下 "sha256:<hex>") ══
 *   taskKey       = keccak256(abi.encode(bytes32("bolloon.task.v1"), taskIdString))
 *   legacyTaskKey = keccak256(abi.encodePacked(taskIdString))        // v1 过渡兼容键
 *   resultHash    = keccak256(bytes(utf8("sha256:<hex of result content>")))
 *   inputHash     = keccak256(bytes(utf8("sha256:<hex of canonical input>")))
 *   manifestHash  = keccak256(bytes(utf8("sha256:<hex of canonical manifest>")))
 *   proofHash     = keccak256(abi.encode(bytes32("bolloon.proof.v1"), resultHash, proofVersion))
 *   多字段一律 abi.encode (32 字节对齐), 禁止对多动态类型用 abi.encodePacked。
 *   `computeTaskKey` / `computeLegacyTaskKey` / `computeResultHash` / `computeProofHash`
 *   是上述口径的**链上可复算入口**, 任何第三方可独立核对 (另一方必须能复算)。
 *   proofHash 由 `submitProofV2` 在链上计算, 不让调用方自定义 → 口径不可被绕过。
 *
 * ══ bytes32 taskKey → 原任务 id 的反查约定 (链下) ═════════════════════════════
 *   taskKey 是不可逆的 keccak 值, v2 路径**不上链**原始 taskId 字符串。
 *   链下约定: 客户端维护 `taskKey -> taskIdString` 的本地/加密映射
 *   (bolloon SessionStore / 本地 store), 或用候选 id 复算 `computeTaskKey` 校验。
 *   v1 的 `createEscrow(string)` 为兼容仍走 calldata 传原串; 其键
 *   `keccak256(abi.encodePacked(taskId))` 与 v2 的 taskKey **是两个不同的值**,
 *   两个值都要进 deployment manifest, 否则历史交易对不上。
 */
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract AgentEscrow {
    IERC20 public immutable token;
    address public owner;

    /// 合约版本: 带 v2 事件者 = 1 (MODEL_FREEZE.md §5); 已审计现状 v0 无版本字段
    uint32 public constant CONTRACT_VERSION = 1;

    /// 域标签 (bytes32 ASCII 右补零), 冻结于 MODEL_FREEZE.md §4
    bytes32 public constant DOMAIN_TASK = "bolloon.task.v1";
    bytes32 public constant DOMAIN_PROOF = "bolloon.proof.v1";

    /// ReleasedV2.by 取值
    uint8 public constant BY_BUYER = 0;
    uint8 public constant BY_ARBITRATION = 1;
    uint8 public constant BY_TIMEOUT = 2;

    /// proofVersion = 0 保留给 legacy (未版本化) 证明, 链上不参与 "bolloon.proof.v1" 计算
    uint16 public constant PROOF_VERSION_LEGACY = 0;

    /**
     * 状态机。**数值顺序冻结**: 只在末尾追加, 绝不插入/重排
     * (0 ACTIVE / 1 RELEASED / 2 DISPUTED / 3 REFUNDED 是已冻结口径, 链下按数值索引)。
     * 4 EXPIRED = F2b 新增 (permissionless expire 的终态)。
     */
    enum EscrowState { ACTIVE, RELEASED, DISPUTED, REFUNDED, EXPIRED }

    /**
     * 单任务托管记录。
     * 前 6 个字段 = v1 布局 (只删掉 `string taskId`, 其余顺序不变, 保证旧 getter 具名字段可用);
     * 后 13 个字段 = v2 (taskKey + F1 的 12 个字段)。
     */
    struct Escrow {
        // ── v1 ──
        address buyer;
        address agent;
        uint256 amount;
        EscrowState state;
        uint256 createdAt;
        bytes32 proofHash;        // 完成证明 (v1: 调用方给; v2: 链上按冻结口径算)
        // ── v2 (F1) ──
        bytes32 taskKey;          // 取代上链的 string taskId
        bytes32 termsHash;
        bytes32 quoteHash;
        bytes32 inputHash;
        bytes32 resultHash;
        bytes32 manifestHash;
        uint256 chainId;          // EIP-155, 创建时 block.chainid
        uint32 contractVersion;   // 写入时的合约版本 (本版 = 1)
        uint64 createdBlock;
        uint64 deadline;          // 每任务交付期限 (取代全局 releaseTimeout 的口径)
        uint32 confirmationWindow;// deadline 之后 buyer 的确认/争议窗口 (秒)
        address paymentAsset;     // 每 escrow 支付资产 (本合约只支持 immutable token)
        uint16 proofVersion;      // 0 = legacy 未版本化
    }

    // F0'/solc 约束: 19 字段 struct 的 public mapping **自动 getter** 会 stack-too-deep
    // (legacy codegen, optimizer off) → mapping 收成 internal, 手写同名 getter 返回 struct
    // (ABI 与旧自动 getter 形状一致: escrows(bytes32) -> tuple, 参数名照旧)。
    mapping(bytes32 => Escrow) internal _escrows; // taskKey → escrow
    bytes32[] public taskIds;

    /** v1 同名 getter (保留 `escrows(bytes32)` 选择器; 返回 mem struct 以免再爆栈) */
    function escrows(bytes32 taskKey) external view returns (Escrow memory) {
        return _escrows[taskKey];
    }

    // ── legacy 事件 (签名冻结, 不删不改) ──
    event EscrowCreated(bytes32 indexed taskId, address buyer, address agent, uint256 amount);
    event ProofSubmitted(bytes32 indexed taskId, bytes32 proofHash);
    event Released(bytes32 indexed taskId, address agent, uint256 amount);
    event Disputed(bytes32 indexed taskId);
    event Refunded(bytes32 indexed taskId, address buyer, uint256 amount);
    event ClaimedAfterTimeout(bytes32 indexed taskId, address agent, uint256 amount);

    // ── v2 事件 (MODEL_FREEZE.md §3.2, 参数名/索引与冻结文本逐字一致) ──
    event EscrowCreatedV2(bytes32 indexed taskKey, bytes32 indexed quoteHash, address indexed buyer,
                          address agent, address paymentAsset, uint256 amount, uint256 deadline,
                          uint32 confirmationWindow, uint16 proofVersion, uint32 contractVersion);
    event ProofSubmittedV2(bytes32 indexed taskKey, bytes32 resultHash, bytes32 manifestHash,
                           bytes32 proofHash, uint16 proofVersion);
    event ReleasedV2(bytes32 indexed taskKey, address to, uint256 amount, uint8 by);
    event RefundedV2(bytes32 indexed taskKey, address to, uint256 amount, bytes32 reasonHash);
    event DisputedV2(bytes32 indexed taskKey, address by, bytes32 reasonHash);

    /// F2b: permissionless expire 的结算事件 (caller = 发起 expire 的任何人, refundedTo = buyer)
    event ExpiredV2(bytes32 indexed taskKey, address indexed caller, address indexed refundedTo, uint256 amount);

    /// F2b: expireGrace 变更 (配置变更必须留痕, 否则链上无法解释 expireAt 的漂移)
    event ExpireGraceUpdated(uint256 previousGrace, uint256 newGrace);

    /** 超时释放的全局默认值: 只作用于 v1 `createEscrow(string)` 口径 (防资金永久锁定 E1) */
    uint256 public releaseTimeout;

    /// F2b: expire 缓冲的默认值 (7 天)。只做"默认", 真正生效值读 `expireGrace`。
    uint256 public constant DEFAULT_EXPIRE_GRACE = 7 days;

    /**
     * F2b: expire 可用时点 = `claimableAt(e)` + `expireGrace`。
     * 为什么是可调状态变量而不是硬常量: 不同 paymentAsset/任务类型的"多久算彻底放弃"不同,
     * 写死成常量会让未来的参数治理只能靠重部署。也不做构造参数 —— 改构造签名会让
     * 已部署实例与 deployment manifest 的 constructorArgs 失配并逼迫重部署。
     * 默认 7 天由构造函数写入, 之后由 owner 用 `setExpireGrace` 调整 (必须 > 0, 否则 expire 永不触发)。
     * 全局口径: 调整对已存在的 ACTIVE escrow 立即生效 (不做 per-task 快照)。
     */
    uint256 public expireGrace;

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address _token, uint256 _releaseTimeout) {
        require(_token != address(0), "token cannot be zero");
        require(_releaseTimeout <= type(uint32).max, "releaseTimeout too large");
        token = IERC20(_token);
        owner = msg.sender;
        releaseTimeout = _releaseTimeout;                   // e.g. 7 days
        expireGrace = DEFAULT_EXPIRE_GRACE;                 // F2b: 默认 7 天, 后可用 setExpireGrace 调
    }

    /**
     * F2b: 调整 expire 缓冲 (owner)。要求 > 0 —— 0 会让 expire 在 claimableAt 就可用,
     * 等于取消 agent 的超时 claim 窗口; 设 0 应被显式拒绝而不是静默生效。
     */
    function setExpireGrace(uint256 newGrace) external onlyOwner {
        require(newGrace > 0, "expireGrace must be > 0");
        require(newGrace <= type(uint32).max, "expireGrace too large");
        emit ExpireGraceUpdated(expireGrace, newGrace);
        expireGrace = newGrace;
    }

    // ══════════════════════════════════════════════════════════════════════
    //  v1 路径 (保留, 只多两件事: F2 proof 门槛 + 附带 v2 事件)
    // ══════════════════════════════════════════════════════════════════════

    /**
     * buyer 创建托管 (存款 USDC)。
     * v1 口径: deadline = block.timestamp, confirmationWindow = releaseTimeout
     * → 超时 claim 时点 == 旧行为 createdAt + releaseTimeout (行为保持不变)。
     * v2 字段缺省: termsHash/quoteHash/inputHash/manifestHash = 0, proofVersion = 0。
     */
    function createEscrow(address agent, uint256 amount, string calldata taskId)
        external
        returns (bytes32 taskKey)
    {
        taskKey = _taskHash(taskId);
        _create(CreateParams({
            taskKey: taskKey,
            agent: agent,
            amount: amount,
            paymentAsset: address(token),
            termsHash: bytes32(0),
            quoteHash: bytes32(0),
            inputHash: bytes32(0),
            manifestHash: bytes32(0),
            deadline: uint64(block.timestamp),
            confirmationWindow: uint32(releaseTimeout),
            proofVersion: PROOF_VERSION_LEGACY
        }));
    }

    /**
     * agent 提交完成证明 (v1: proofHash 由调用方给, 语义 = 结果 CID hash)。
     * 保留原顺序 (E3: 0 不是有效证明 → 状态 → 只有 agent 可提交), 同时发 v2 事件:
     * resultHash = 0 / proofVersion = 0 表示"legacy 未版本化证明"。
     */
    function submitProof(bytes32 taskId, bytes32 proofHash) external {
        require(proofHash != bytes32(0), "invalid proof"); // E3: 0 不是有效证明
        Escrow storage e = _escrows[taskId];
        require(e.state == EscrowState.ACTIVE, "not active");
        require(msg.sender == e.agent, "only agent");
        e.proofHash = proofHash;
        e.resultHash = bytes32(0);                       // v1 口径不带 resultHash
        e.proofVersion = PROOF_VERSION_LEGACY;           // 0 = 未版本化 (不冒称 bolloon.proof.v1)
        emit ProofSubmitted(taskId, proofHash);
        emit ProofSubmittedV2(taskId, bytes32(0), e.manifestHash, proofHash, PROOF_VERSION_LEGACY);
    }

    /** buyer 确认完成 → 释放给 agent (by = 0) */
    function release(bytes32 taskId) external {
        _releaseByBuyer(_escrows[taskId]);
    }

    /**
     * E1 修复: 超时 claim — buyer 超时不确认/不 dispute 时, agent 可主动领取。
     * 防止 buyer 恶意/丢失导致资金永久锁定。
     * F2 修复: **必须先有 proof** (proofHash != 0), 否则 revert "no proof submitted"。
     * 检查顺序: 状态 → 调用者 → 超时 → proof 门槛 (先时序后资格, 顺序固化以便测试/审计)。
     */
    function claimAfterTimeout(bytes32 taskId) external {
        _claimAfterTimeout(_escrows[taskId]);
    }

    /** 争议: 冻结资金 (buyer/agent 均可发起), v1 口径无 reasonHash (= 0) */
    function dispute(bytes32 taskId) external {
        _dispute(_escrows[taskId], bytes32(0));
    }

    /** 仲裁/退款 (owner 仲裁后), v1 口径无 reasonHash (= 0) */
    function refund(bytes32 taskId) external onlyOwner {
        _refundToBuyer(_escrows[taskId], bytes32(0));
    }

    /** 仲裁后释放给 agent (owner 仲裁: 任务确实完成), by = 1 */
    function releaseAfterArbitration(bytes32 taskId) external onlyOwner {
        _releaseDisputedToAgent(_escrows[taskId], BY_ARBITRATION);
    }

    /**
     * F2b (v1 路径): permissionless 逃生出口 —— **任何人都可调**。
     * 条件: ACTIVE ∧ 无 proof ∧ `block.timestamp >= claimableAt + expireGrace`。
     * 效果: 全额退回 buyer, 状态 → EXPIRED, 发 `ExpiredV2` (caller 记进事件, 便于溯源谁触发的)。
     * v1 有此洞: F2 之后 v1 claim 要有 proof, 而 v1 `refund` 只在 DISPUTED 且 onlyOwner,
     * owner 又不能代替发起 dispute → agent 不交 proof + buyer 不 dispute = 永久锁死。
     */
    function expire(bytes32 taskId) external {
        _expire(_escrows[taskId]);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  v2 路径 (F1 字段 + F3 事件 + 冻结 hash 口径)
    // ══════════════════════════════════════════════════════════════════════

    /**
     * buyer 创建 v2 托管。taskKey 由链下按 `computeTaskKey(taskId)` 口径算好后传入
     * (原始 taskId 字符串不上链)。
     * 要求: taskKey != 0; agent != 0; amount > 0; paymentAsset == address(token);
     *       termsHash != 0; quoteHash != 0; deadline >= block.timestamp; confirmationWindow > 0。
     * 注: paymentAsset 只支持本合约 immutable token —— 多资产需要新部署, 不能在这里假装支持。
     */
    function createEscrowV2(
        bytes32 taskKey,
        address agent,
        uint256 amount,
        address paymentAsset,
        bytes32 termsHash,
        bytes32 quoteHash,
        bytes32 inputHash,
        bytes32 manifestHash,
        uint64 deadline,
        uint32 confirmationWindow,
        uint16 proofVersion
    ) external returns (bytes32) {
        require(quoteHash != bytes32(0), "quoteHash required");
        require(termsHash != bytes32(0), "termsHash required");
        _create(CreateParams({
            taskKey: taskKey,
            agent: agent,
            amount: amount,
            paymentAsset: paymentAsset,
            termsHash: termsHash,
            quoteHash: quoteHash,
            inputHash: inputHash,
            manifestHash: manifestHash,
            deadline: deadline,
            confirmationWindow: confirmationWindow,
            proofVersion: proofVersion
        }));
        return taskKey;
    }

    /**
     * agent 提交 v2 完成证明。
     * proofHash **在链上按冻结口径计算**: keccak256(abi.encode("bolloon.proof.v1", resultHash, proofVersion))。
     * 要求: resultHash != 0; proofVersion != 0 (0 保留给 legacy)。
     */
    function submitProofV2(bytes32 taskKey, bytes32 resultHash, bytes32 manifestHash, uint16 proofVersion)
        external
        returns (bytes32 proofHash)
    {
        require(resultHash != bytes32(0), "resultHash required");
        require(proofVersion != PROOF_VERSION_LEGACY, "proofVersion required");
        Escrow storage e = _escrows[taskKey];
        require(e.state == EscrowState.ACTIVE, "not active");
        require(msg.sender == e.agent, "only agent");
        proofHash = _computeProofHash(resultHash, proofVersion);
        e.proofHash = proofHash;
        e.resultHash = resultHash;
        e.manifestHash = manifestHash;
        e.proofVersion = proofVersion;
        emit ProofSubmitted(taskKey, proofHash);
        emit ProofSubmittedV2(taskKey, resultHash, manifestHash, proofHash, proofVersion);
    }

    /** v2: buyer 确认完成 → 释放给 agent (by = 0) */
    function releaseV2(bytes32 taskKey) external {
        _releaseByBuyer(_escrows[taskKey]);
    }

    /** v2: 超时 claim (by = 2) —— 同样带 F2 proof 门槛 */
    function claimAfterTimeoutV2(bytes32 taskKey) external {
        _claimAfterTimeout(_escrows[taskKey]);
    }

    /** v2: 争议 (带 reasonHash), 调用者 = 发起人 (F3: DisputedV2.by) */
    function disputeV2(bytes32 taskKey, bytes32 reasonHash) external {
        _dispute(_escrows[taskKey], reasonHash);
    }

    /** v2: 仲裁退款 (带 reasonHash) */
    function refundV2(bytes32 taskKey, bytes32 reasonHash) external onlyOwner {
        _refundToBuyer(_escrows[taskKey], reasonHash);
    }

    /** v2: 仲裁释放给 agent (by = 1) */
    function releaseAfterArbitrationV2(bytes32 taskKey) external onlyOwner {
        _releaseDisputedToAgent(_escrows[taskKey], BY_ARBITRATION);
    }

    /**
     * F2b (v2 路径): permissionless 逃生出口 —— **任何人都可调**, 无需是 buyer/agent/owner。
     * 条件: ACTIVE ∧ 无 proof (`proofHash == 0`) ∧ `block.timestamp >= expireAt(taskKey)`。
     * 效果: 全额退回 **buyer** (不是卖家), 状态 → EXPIRED, 发 `ExpiredV2`。
     * 与 F2 的分工: 有 proof → 本函数 revert "proof exists", 必须走 claimAfterTimeoutV2。
     * 与 dispute 的分工: 已 DISPUTED → revert "not active", 走 owner 仲裁。
     * 检查顺序与 `_claimAfterTimeout` 同构 (先状态, 再时序, 最后资格), 顺序固化以便测试/审计:
     *   not active → grace not elapsed → proof exists
     */
    function expireV2(bytes32 taskKey) external {
        _expire(_escrows[taskKey]);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  hash 口径: 链上可复算入口 (与 MODEL_FREEZE.md §4 逐字一致)
    // ══════════════════════════════════════════════════════════════════════

    /** taskKey = keccak256(abi.encode(bytes32("bolloon.task.v1"), taskIdString)) */
    function computeTaskKey(string calldata taskId) public pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TASK, taskId));
    }

    /** v1 过渡兼容键 = keccak256(abi.encodePacked(taskIdString)) (= keccak256(bytes(utf8))) */
    function computeLegacyTaskKey(string calldata taskId) public pure returns (bytes32) {
        return _taskHash(taskId);
    }

    /** resultHash/inputHash/manifestHash = keccak256(bytes(utf8("sha256:<hex>"))) */
    function computeResultHash(string calldata sha256Digest) public pure returns (bytes32) {
        bytes memory d = bytes(sha256Digest);
        bytes memory p = bytes("sha256:");
        require(d.length > p.length, "expected sha256:<hex>");
        for (uint256 i = 0; i < p.length; i++) {
            require(d[i] == p[i], "expected sha256:<hex>");
        }
        return keccak256(d);
    }

    /** proofHash = keccak256(abi.encode(bytes32("bolloon.proof.v1"), resultHash, proofVersion)) */
    function computeProofHash(bytes32 resultHash, uint16 proofVersion) public pure returns (bytes32) {
        return _computeProofHash(resultHash, proofVersion);
    }

    /** 超时 claim 的可用时间戳 = deadline + confirmationWindow (0 = 未知任务/未设) */
    function claimableAt(bytes32 taskKey) external view returns (uint256) {
        return _claimableAt(_escrows[taskKey]);
    }

    /**
     * F2b: permissionless expire 的可用时间戳 = deadline + confirmationWindow + expireGrace。
     * 与 `claimableAt` 一样是只读复算入口 —— 任何人都能在链下核对"现在能不能 expire"。
     */
    function expireAt(bytes32 taskKey) external view returns (uint256) {
        return _expireAt(_escrows[taskKey]);
    }

    /** 余额 (审计) */
    function balance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    // ══════════════════════════════════════════════════════════════════════
    //  internals
    // ══════════════════════════════════════════════════════════════════════

    struct CreateParams {
        bytes32 taskKey;
        address agent;
        uint256 amount;
        address paymentAsset;
        bytes32 termsHash;
        bytes32 quoteHash;
        bytes32 inputHash;
        bytes32 manifestHash;
        uint64 deadline;
        uint32 confirmationWindow;
        uint16 proofVersion;
    }

    /// 创建共用逻辑 (v1/v2 同一份, 避免两条路径行为漂移)。11 个参数走 memory struct 防 stack-too-deep。
    function _create(CreateParams memory p) private {
        require(p.taskKey != bytes32(0), "taskKey cannot be zero");
        require(p.agent != address(0), "agent cannot be zero"); // E2: 防资金黑洞
        require(p.amount > 0, "amount must be > 0");
        require(p.paymentAsset == address(token), "unsupported payment asset");
        require(p.confirmationWindow > 0, "confirmationWindow must be > 0");
        require(p.deadline >= block.timestamp, "deadline in past");
        require(_escrows[p.taskKey].buyer == address(0), "task exists");
        require(token.transferFrom(msg.sender, address(this), p.amount), "deposit failed");

        Escrow storage e = _escrows[p.taskKey];
        e.buyer = msg.sender;
        e.agent = p.agent;
        e.amount = p.amount;
        e.state = EscrowState.ACTIVE;
        e.createdAt = block.timestamp;
        e.proofHash = bytes32(0);
        e.taskKey = p.taskKey;
        e.termsHash = p.termsHash;
        e.quoteHash = p.quoteHash;
        e.inputHash = p.inputHash;
        e.resultHash = bytes32(0);
        e.manifestHash = p.manifestHash;
        e.chainId = block.chainid;
        e.contractVersion = CONTRACT_VERSION;
        e.createdBlock = uint64(block.number);
        e.deadline = p.deadline;
        e.confirmationWindow = p.confirmationWindow;
        e.paymentAsset = p.paymentAsset;
        e.proofVersion = p.proofVersion;

        taskIds.push(p.taskKey);
        _emitCreated(p, msg.sender);
    }

    /// 单独一个函数发事件: 10 个参数 + memory 指针放一个栈帧里会 stack-too-deep, 这里只传 struct 指针
    function _emitCreated(CreateParams memory p, address buyer) private {
        emit EscrowCreated(p.taskKey, buyer, p.agent, p.amount);
        emit EscrowCreatedV2(p.taskKey, p.quoteHash, buyer, p.agent, p.paymentAsset, p.amount,
                             uint256(p.deadline), p.confirmationWindow, p.proofVersion, CONTRACT_VERSION);
    }

    /// v1/v2 共用: buyer 确认释放 (requires 顺序与旧 release 逐字一致)
    function _releaseByBuyer(Escrow storage e) private {
        require(e.state == EscrowState.ACTIVE, "not active");
        require(msg.sender == e.buyer, "only buyer");
        require(e.proofHash != bytes32(0), "no proof submitted");
        _settleToAgent(e);
        emit Released(e.taskKey, e.agent, e.amount);
        emit ReleasedV2(e.taskKey, e.agent, e.amount, BY_BUYER);
    }

    /**
     * v1/v2 共用: 超时 claim。
     * 顺序: not active → only agent → timeout not reached → **no proof submitted (F2)**。
     * F2 之前这里没有最后一道 require → 卖家超时无 proof 也能领钱。
     */
    function _claimAfterTimeout(Escrow storage e) private {
        require(e.state == EscrowState.ACTIVE, "not active");
        require(msg.sender == e.agent, "only agent");
        require(block.timestamp >= _claimableAt(e), "timeout not reached");
        require(e.proofHash != bytes32(0), "no proof submitted"); // ← F2 修复
        _settleToAgent(e);
        emit ClaimedAfterTimeout(e.taskKey, e.agent, e.amount);
        emit ReleasedV2(e.taskKey, e.agent, e.amount, BY_TIMEOUT);
    }

    /**
     * F2b: permissionless expire 共用逻辑 (v1 `expire` / v2 `expireV2` 同一份, 避免两条路径漂移)。
     * 顺序: unknown task → not active → grace not elapsed → proof exists
     * (与 _claimAfterTimeout 同构, 只在最前面多一道"存在性"检查)。
     * 为什么要先判存在: 没有 caller 门槛时, 未创建任务的记录是**缺省值**
     * (buyer = 0, state = ACTIVE(0), amount = 0, deadline = 0) —— 不先判存在,
     * 一个随机 taskKey 在 grace 后会"成功 expire"并把幻觉状态写成 EXPIRED (真 USDC 还会
     * 因为 to == address(0) 回滚)。有 caller 门槛的旧方法天然不受影响 (e.buyer/e.agent 是 0 就 revert)。
     * checks-effects-interactions: 先落状态再转账 (IERC20 有回调风险时不会重入重复出金)。
     */
    function _expire(Escrow storage e) private {
        require(e.buyer != address(0), "unknown task");
        require(e.state == EscrowState.ACTIVE, "not active");
        require(block.timestamp >= _expireAt(e), "grace not elapsed");
        require(e.proofHash == bytes32(0), "proof exists"); // 有 proof → 只能走 claim 路径 (F2 互补)
        e.state = EscrowState.EXPIRED;
        require(token.transfer(e.buyer, e.amount), "expire refund failed");
        emit ExpiredV2(e.taskKey, msg.sender, e.buyer, e.amount);
    }

    function _dispute(Escrow storage e, bytes32 reasonHash) private {
        require(e.state == EscrowState.ACTIVE, "not active");
        require(msg.sender == e.buyer || msg.sender == e.agent, "not party");
        e.state = EscrowState.DISPUTED;
        emit Disputed(e.taskKey);
        emit DisputedV2(e.taskKey, msg.sender, reasonHash);
    }

    function _refundToBuyer(Escrow storage e, bytes32 reasonHash) private {
        require(e.state == EscrowState.DISPUTED, "not disputed");
        e.state = EscrowState.REFUNDED;
        require(token.transfer(e.buyer, e.amount), "refund failed");
        emit Refunded(e.taskKey, e.buyer, e.amount);
        emit RefundedV2(e.taskKey, e.buyer, e.amount, reasonHash);
    }

    function _releaseDisputedToAgent(Escrow storage e, uint8 by) private {
        require(e.state == EscrowState.DISPUTED, "not disputed");
        _settleToAgent(e);
        emit Released(e.taskKey, e.agent, e.amount);
        emit ReleasedV2(e.taskKey, e.agent, e.amount, by);
    }

    /// 状态置 RELEASED + 出金 (不含事件, 事件由调用方按路径发, 避免旧 Released 语义被污染)
    function _settleToAgent(Escrow storage e) private {
        e.state = EscrowState.RELEASED;
        require(token.transfer(e.agent, e.amount), "release failed");
    }

    function _claimableAt(Escrow storage e) private view returns (uint256) {
        return uint256(e.deadline) + uint256(e.confirmationWindow);
    }

    /// F2b: expire 可用时点 = claimableAt + expireGrace (全局 grace, 见 expireGrace 注释)
    function _expireAt(Escrow storage e) private view returns (uint256) {
        return _claimableAt(e) + expireGrace;
    }

    /// v1 过渡兼容: keccak256(abi.encodePacked(taskIdString))
    function _taskHash(string calldata taskId) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(taskId));
    }

    function _computeProofHash(bytes32 resultHash, uint16 proofVersion) private pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_PROOF, resultHash, proofVersion));
    }
}
