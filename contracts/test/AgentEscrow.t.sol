// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * AgentEscrow Foundry 测试 (v1 legacy + v2 口径)
 *
 * 覆盖: F2 漏洞修复 (无 proof 不得超时取款) / F1 十二个 v2 字段 + bytes32 taskKey /
 *       F3 v2 事件 (ReleasedV2.by 0/1/2, DisputedV2.by+reasonHash, RefundedV2.reasonHash) /
 *       冻结 hash 切径 (链上 keccak256+abi.encode+域标签 vs 链下 "sha256:<hex>")。
 *
 * 冻结口径 (MODEL_FREEZE.md §4):
 *   taskKey    = keccak256(abi.encode(bytes32("bolloon.task.v1"), taskIdString))
 *   resultHash = keccak256(bytes(utf8("sha256:<hex>")))
 *   proofHash  = keccak256(abi.encode(bytes32("bolloon.proof.v1"), resultHash, proofVersion))
 */
import {Test} from "forge-std/Test.sol";
import {AgentEscrow} from "../evm/contracts/AgentEscrow.sol";
import {MockERC20} from "../evm/contracts/mocks/MockERC20.sol";

contract AgentEscrowTest is Test {
    AgentEscrow escrow;
    MockERC20 token;

    address buyer = address(0xB0B);
    address agent = address(0xA6E47);
    address other = address(0xC0FFEE);

    uint256 constant RELEASE_TIMEOUT = 7 days;
    uint256 constant AMOUNT = 100e6; // USDC, 6 decimals
    uint32 constant CONF_WINDOW = 3600;
    uint16 constant PROOF_VERSION = 1;

    bytes32 constant TAG_TASK = "bolloon.task.v1";
    bytes32 constant TAG_PROOF = "bolloon.proof.v1";

    // sha256("test") 的 hex —— 链下内容摘要口径固定为 "sha256:<hex>"
    string constant DIGEST = "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    string constant MANIFEST_DIGEST = "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae";

    bytes32 constant QUOTE_HASH = keccak256("quote:q-1");
    bytes32 constant TERMS_HASH = keccak256("terms:t-1");
    bytes32 constant INPUT_HASH = keccak256("input:i-1");

    string constant TASK_ID = "task-v2-001";

    function setUp() public {
        token = new MockERC20("USDC", 6);
        escrow = new AgentEscrow(address(token), RELEASE_TIMEOUT);
        token.mint(buyer, 10_000e6);
        vm.prank(buyer);
        token.approve(address(escrow), type(uint256).max);
    }

    // ── 本地独立复算 (不调用被测合约) ──────────────────────────────
    function _taskKey(string memory id) internal pure returns (bytes32) {
        return keccak256(abi.encode(TAG_TASK, id));
    }

    function _legacyKey(string memory id) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(id));
    }

    function _contentHash(string memory digest) internal pure returns (bytes32) {
        return keccak256(bytes(digest));
    }

    function _proofHash(bytes32 resultHash, uint16 version) internal pure returns (bytes32) {
        return keccak256(abi.encode(TAG_PROOF, resultHash, version));
    }

    function _resultHash() internal pure returns (bytes32) {
        return _contentHash(DIGEST);
    }

    function _deadline() internal view returns (uint64) {
        return uint64(block.timestamp + 1 hours);
    }

    /// 默认合法参数的 v2 建仓
    function _createV2() internal returns (bytes32) {
        vm.prank(buyer);
        return escrow.createEscrowV2(
            _taskKey(TASK_ID), agent, AMOUNT, address(token),
            TERMS_HASH, QUOTE_HASH, INPUT_HASH, _contentHash(MANIFEST_DIGEST),
            _deadline(), CONF_WINDOW, PROOF_VERSION
        );
    }

    // ═════════════════════════════════════════════════════════════
    //  F1: 12 个 v2 字段 + bytes32 taskKey
    // ═════════════════════════════════════════════════════════════
    function testCreateEscrowV2StoresAllFields() public {
        bytes32 key = _taskKey(TASK_ID);
        uint64 dl = _deadline();
        vm.prank(buyer);
        escrow.createEscrowV2(key, agent, AMOUNT, address(token), TERMS_HASH, QUOTE_HASH,
                              INPUT_HASH, _contentHash(MANIFEST_DIGEST), dl, CONF_WINDOW, PROOF_VERSION);

        AgentEscrow.Escrow memory e = escrow.escrows(key);
        assertEq(e.buyer, buyer, "buyer");
        assertEq(e.agent, agent, "agent");
        assertEq(e.amount, AMOUNT, "amount");
        assertEq(uint256(e.state), 0, "ACTIVE");
        assertEq(e.taskKey, key, "taskKey");
        assertEq(e.termsHash, TERMS_HASH, "termsHash");
        assertEq(e.quoteHash, QUOTE_HASH, "quoteHash");
        assertEq(e.inputHash, INPUT_HASH, "inputHash");
        assertEq(e.manifestHash, _contentHash(MANIFEST_DIGEST), "manifestHash");
        assertEq(e.chainId, block.chainid, "chainId");
        assertEq(uint256(e.contractVersion), 1, "contractVersion");
        assertEq(uint256(e.createdBlock), uint256(block.number), "createdBlock");
        assertEq(uint256(e.deadline), uint256(dl), "deadline");
        assertEq(uint256(e.confirmationWindow), CONF_WINDOW, "confirmationWindow");
        assertEq(e.paymentAsset, address(token), "paymentAsset");
        assertEq(uint256(e.proofVersion), PROOF_VERSION, "proofVersion");
        assertEq(e.resultHash, bytes32(0), "resultHash zero before proof");
        assertEq(e.proofHash, bytes32(0), "proofHash zero before proof");
        assertEq(escrow.claimableAt(key), uint256(dl) + CONF_WINDOW, "claimableAt");
        assertEq(token.balanceOf(address(escrow)), AMOUNT, "funds deposited in escrow");
    }

    function testCreateEscrowV2EmitsV2Event() public {
        bytes32 key = _taskKey(TASK_ID);
        uint64 dl = _deadline();
        vm.expectEmit(true, true, true, true);
        emit AgentEscrow.EscrowCreated(key, buyer, agent, AMOUNT);
        vm.expectEmit(true, true, true, true);
        emit AgentEscrow.EscrowCreatedV2(key, QUOTE_HASH, buyer, agent, address(token), AMOUNT,
                                        uint256(dl), CONF_WINDOW, PROOF_VERSION, 1);
        vm.prank(buyer);
        escrow.createEscrowV2(key, agent, AMOUNT, address(token), TERMS_HASH, QUOTE_HASH,
                              INPUT_HASH, _contentHash(MANIFEST_DIGEST), dl, CONF_WINDOW, PROOF_VERSION);
    }

    function testCreateEscrowV2Requires() public {
        bytes32 key = _taskKey(TASK_ID);
        uint64 dl = _deadline();

        vm.startPrank(buyer);
        vm.expectRevert(bytes("taskKey cannot be zero"));
        escrow.createEscrowV2(bytes32(0), agent, AMOUNT, address(token), TERMS_HASH, QUOTE_HASH, INPUT_HASH, bytes32(0), dl, CONF_WINDOW, PROOF_VERSION);

        vm.expectRevert(bytes("agent cannot be zero"));
        escrow.createEscrowV2(key, address(0), AMOUNT, address(token), TERMS_HASH, QUOTE_HASH, INPUT_HASH, bytes32(0), dl, CONF_WINDOW, PROOF_VERSION);

        vm.expectRevert(bytes("amount must be > 0"));
        escrow.createEscrowV2(key, agent, 0, address(token), TERMS_HASH, QUOTE_HASH, INPUT_HASH, bytes32(0), dl, CONF_WINDOW, PROOF_VERSION);

        vm.expectRevert(bytes("quoteHash required"));
        escrow.createEscrowV2(key, agent, AMOUNT, address(token), TERMS_HASH, bytes32(0), INPUT_HASH, bytes32(0), dl, CONF_WINDOW, PROOF_VERSION);

        vm.expectRevert(bytes("termsHash required"));
        escrow.createEscrowV2(key, agent, AMOUNT, address(token), bytes32(0), QUOTE_HASH, INPUT_HASH, bytes32(0), dl, CONF_WINDOW, PROOF_VERSION);

        vm.expectRevert(bytes("unsupported payment asset"));
        escrow.createEscrowV2(key, agent, AMOUNT, other, TERMS_HASH, QUOTE_HASH, INPUT_HASH, bytes32(0), dl, CONF_WINDOW, PROOF_VERSION);

        vm.expectRevert(bytes("confirmationWindow must be > 0"));
        escrow.createEscrowV2(key, agent, AMOUNT, address(token), TERMS_HASH, QUOTE_HASH, INPUT_HASH, bytes32(0), dl, 0, PROOF_VERSION);

        vm.expectRevert(bytes("deadline in past"));
        escrow.createEscrowV2(key, agent, AMOUNT, address(token), TERMS_HASH, QUOTE_HASH, INPUT_HASH, bytes32(0), uint64(block.timestamp - 1), CONF_WINDOW, PROOF_VERSION);
        vm.stopPrank();

        _createV2();
        vm.prank(buyer);
        vm.expectRevert(bytes("task exists"));
        escrow.createEscrowV2(key, agent, AMOUNT, address(token), TERMS_HASH, QUOTE_HASH, INPUT_HASH, bytes32(0), _deadline(), CONF_WINDOW, PROOF_VERSION);
    }

    function testHashPathMatchesFrozenRecipe() public view {
        assertEq(escrow.computeTaskKey(TASK_ID), _taskKey(TASK_ID), "taskKey");
        assertEq(escrow.computeLegacyTaskKey(TASK_ID), _legacyKey(TASK_ID), "legacyKey");
        assertTrue(_legacyKey(TASK_ID) != _taskKey(TASK_ID), "v1 key != v2 key (both into manifest)");
        assertEq(escrow.computeResultHash(DIGEST), _contentHash(DIGEST), "resultHash");
        assertEq(escrow.computeProofHash(_resultHash(), PROOF_VERSION),
                 _proofHash(_resultHash(), PROOF_VERSION), "proofHash");
        assertTrue(_proofHash(_resultHash(), PROOF_VERSION) != _proofHash(_resultHash(), 2),
                   "proofVersion bound into proofHash");
        // DIGEST 里那段 hex 是真 sha256("test"), 不是随便凑的
        assertEq(sha256(bytes("test")),
                 bytes32(hex"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"));
        assertEq(escrow.DOMAIN_TASK(), TAG_TASK);
        assertEq(escrow.DOMAIN_PROOF(), TAG_PROOF);
        assertEq(uint256(escrow.CONTRACT_VERSION()), 1);
    }

    function testComputeResultHashRejectsNonSha256() public {
        vm.expectRevert(bytes("expected sha256:<hex>"));
        escrow.computeResultHash("deadbeef");
        vm.expectRevert(bytes("expected sha256:<hex>"));
        escrow.computeResultHash("sha256:");
    }

    // ═════════════════════════════════════════════════════════════
    //  prooftwork · 事件
    // ═════════════════════════════════════════════════════════════
    function testSubmitProofV2ComputesProofHashOnChain() public {
        bytes32 key = _createV2();
        bytes32 expected = _proofHash(_resultHash(), PROOF_VERSION);
        bytes32 manifestHash = _contentHash(MANIFEST_DIGEST);

        vm.expectEmit(true, true, true, true);
        emit AgentEscrow.ProofSubmitted(key, expected);
        vm.expectEmit(true, true, true, true);
        emit AgentEscrow.ProofSubmittedV2(key, _resultHash(), manifestHash, expected, PROOF_VERSION);
        vm.prank(agent);
        bytes32 got = escrow.submitProofV2(key, _resultHash(), manifestHash, PROOF_VERSION);
        assertEq(got, expected, "return value == offchain recompute");

        AgentEscrow.Escrow memory e = escrow.escrows(key);
        assertEq(e.proofHash, expected, "onchain proofHash == offchain recompute");
        assertEq(e.resultHash, _resultHash(), "resultHash");
        assertEq(e.manifestHash, manifestHash, "manifestHash");
        assertEq(uint256(e.proofVersion), PROOF_VERSION, "proofVersion");
    }

    function testSubmitProofV2Requires() public {
        bytes32 key = _createV2();
        vm.startPrank(agent);
        vm.expectRevert(bytes("resultHash required"));
        escrow.submitProofV2(key, bytes32(0), bytes32(0), PROOF_VERSION);
        vm.expectRevert(bytes("proofVersion required"));
        escrow.submitProofV2(key, _resultHash(), bytes32(0), 0);
        vm.stopPrank();
        vm.prank(other);
        vm.expectRevert(bytes("only agent"));
        escrow.submitProofV2(key, _resultHash(), bytes32(0), PROOF_VERSION);
    }

    // ═════════════════════════════════════════════════════════════
    //  F2: 无 proof 不得超时取款 (真漏洞)
    // ═════════════════════════════════════════════════════════════
    function testF2_NoProofTimeoutClaimReverts_V1() public {
        vm.prank(buyer);
        escrow.createEscrow(agent, AMOUNT, "task-f2-noproof");
        bytes32 key = _legacyKey("task-f2-noproof");

        vm.warp(block.timestamp + 8 days); // 超时已到, 但零证明
        vm.prank(agent);
        vm.expectRevert(bytes("no proof submitted"));
        escrow.claimAfterTimeout(key);

        assertEq(token.balanceOf(agent), 0, "agent got nothing");
        assertEq(token.balanceOf(address(escrow)), AMOUNT, "funds stay in escrow contract");
        assertEq(uint256(escrow.escrows(key).state), 0, "still ACTIVE");
    }

    function testF2_NoProofTimeoutClaimReverts_V2() public {
        bytes32 key = _createV2();
        vm.warp(block.timestamp + 1 hours + CONF_WINDOW + 1);
        vm.prank(agent);
        vm.expectRevert(bytes("no proof submitted"));
        escrow.claimAfterTimeoutV2(key);
        assertEq(token.balanceOf(agent), 0, "agent got nothing");
        assertEq(token.balanceOf(address(escrow)), AMOUNT, "funds stay in escrow contract");
    }

    function testF2_WithProofTimeoutClaimSucceeds_V1() public {
        vm.prank(buyer);
        escrow.createEscrow(agent, AMOUNT, "task-f2-proof");
        bytes32 key = _legacyKey("task-f2-proof");
        vm.prank(agent);
        escrow.submitProof(key, keccak256("cid:result")); // ← 与无 proof 用例唯一差别

        vm.warp(block.timestamp + 8 days);
        vm.expectEmit(true, true, true, true);
        emit AgentEscrow.ClaimedAfterTimeout(key, agent, AMOUNT);
        vm.expectEmit(true, true, true, true);
        emit AgentEscrow.ReleasedV2(key, agent, AMOUNT, 2); // by=2 timeout
        vm.prank(agent);
        escrow.claimAfterTimeout(key);

        assertEq(token.balanceOf(agent), AMOUNT, "claim with proof works after timeout");
        assertEq(uint256(escrow.escrows(key).state), 1, "RELEASED");
    }

    function testF2_WithProofTimeoutClaimSucceeds_V2() public {
        bytes32 key = _createV2();
        vm.prank(agent);
        escrow.submitProofV2(key, _resultHash(), bytes32(0), PROOF_VERSION);
        vm.warp(block.timestamp + 1 hours + CONF_WINDOW + 1);
        vm.expectEmit(true, true, true, true);
        emit AgentEscrow.ReleasedV2(key, agent, AMOUNT, 2);
        vm.prank(agent);
        escrow.claimAfterTimeoutV2(key);
        assertEq(token.balanceOf(agent), AMOUNT);
    }

    function testF2_TimeoutOrderStillChecksTimeFirst() public {
        vm.prank(buyer);
        escrow.createEscrow(agent, AMOUNT, "task-f2-order");
        bytes32 key = _legacyKey("task-f2-order");
        vm.prank(agent); // 未超时 + 无 proof → 报未超时 (时序在前)
        vm.expectRevert(bytes("timeout not reached"));
        escrow.claimAfterTimeout(key);
    }

    function testF2_DisputedCannotClaim() public {
        vm.prank(buyer);
        escrow.createEscrow(agent, AMOUNT, "task-f2-disputed");
        bytes32 key = _legacyKey("task-f2-disputed");
        vm.prank(agent);
        escrow.submitProof(key, keccak256("cid:r"));
        vm.prank(buyer);
        escrow.dispute(key);
        vm.warp(block.timestamp + 8 days);
        vm.prank(agent);
        vm.expectRevert(bytes("not active"));
        escrow.claimAfterTimeout(key);
    }

    // ═════════════════════════════════════════════════════════════
    //  F3: 事件 (by = 0/1/2, reasonHash)
    // ═════════════════════════════════════════════════════════════
    function testReleaseV2ByBuyerEmitsByZero() public {
        bytes32 key = _createV2();
        vm.prank(agent);
        escrow.submitProofV2(key, _resultHash(), bytes32(0), PROOF_VERSION);
        vm.expectEmit(true, true, true, true);
        emit AgentEscrow.Released(key, agent, AMOUNT);
        vm.expectEmit(true, true, true, true);
        emit AgentEscrow.ReleasedV2(key, agent, AMOUNT, 0);
        vm.prank(buyer);
        escrow.releaseV2(key);
        assertEq(token.balanceOf(agent), AMOUNT);
        assertEq(uint256(escrow.escrows(key).state), 1);
    }

    function testArbitrationReleaseEmitsByOne() public {
        bytes32 key = _createV2();
        vm.prank(agent);
        escrow.submitProofV2(key, _resultHash(), bytes32(0), PROOF_VERSION);
        vm.prank(buyer);
        escrow.disputeV2(key, keccak256("reason:bad"));
        vm.expectEmit(true, true, true, true);
        emit AgentEscrow.ReleasedV2(key, agent, AMOUNT, 1); // by=1 仲裁
        escrow.releaseAfterArbitrationV2(key);
        assertEq(token.balanceOf(agent), AMOUNT);
    }

    function testRefundV2CarriesReasonHash() public {
        bytes32 key = _createV2();
        bytes32 reason = keccak256("reason:task-failed");
        vm.prank(buyer);
        escrow.disputeV2(key, reason);
        vm.expectEmit(true, true, true, true);
        emit AgentEscrow.Refunded(key, buyer, AMOUNT);
        vm.expectEmit(true, true, true, true);
        emit AgentEscrow.RefundedV2(key, buyer, AMOUNT, reason);
        escrow.refundV2(key, reason);
        assertEq(token.balanceOf(buyer), 10_000e6, "refund back to buyer");
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function testDisputeV2RecordsSenderAndReason() public {
        bytes32 key = _createV2();
        bytes32 reason = keccak256("reason:not-delivered");
        vm.expectEmit(true, true, true, true);
        emit AgentEscrow.Disputed(key);
        vm.expectEmit(true, true, true, true);
        emit AgentEscrow.DisputedV2(key, buyer, reason);
        vm.prank(buyer);
        escrow.disputeV2(key, reason);
        assertEq(uint256(escrow.escrows(key).state), 2, "DISPUTED");

        vm.prank(other); // 同一任务已被 dispute → 状态优先 ("not active")
        vm.expectRevert(bytes("not active"));
        escrow.disputeV2(key, reason);

        // 另开一个 ACTIVE escrow 验"非当事人"
        vm.startPrank(buyer);
        bytes32 key2 = escrow.createEscrowV2(_taskKey("task-other"), agent, AMOUNT, address(token),
            TERMS_HASH, QUOTE_HASH, bytes32(0), bytes32(0), _deadline(), CONF_WINDOW, PROOF_VERSION);
        vm.stopPrank();
        vm.prank(other);
        vm.expectRevert(bytes("not party"));
        escrow.disputeV2(key2, reason);
    }

    function testV1RefundEmitsZeroReasonHash() public {
        bytes32 key = _createV2();
        vm.prank(buyer);
        escrow.dispute(key);
        vm.expectEmit(true, true, true, true);
        emit AgentEscrow.RefundedV2(key, buyer, AMOUNT, bytes32(0));
        escrow.refund(key);
    }

    function testOnlyOwnerCanRefundOrArbitrate() public {
        bytes32 key = _createV2();
        vm.prank(buyer);
        escrow.disputeV2(key, bytes32(0));
        vm.startPrank(buyer);
        vm.expectRevert(bytes("not owner"));
        escrow.refundV2(key, bytes32(0));
        vm.expectRevert(bytes("not owner"));
        escrow.releaseAfterArbitrationV2(key);
        vm.stopPrank();
    }

    function testNotDisputedCannotRefund() public {
        bytes32 key = _createV2();
        vm.expectRevert(bytes("not disputed"));
        escrow.refundV2(key, bytes32(0));
    }

    function testNoProofCannotRelease() public {
        bytes32 key = _createV2();
        vm.prank(buyer);
        vm.expectRevert(bytes("no proof submitted"));
        escrow.releaseV2(key);
        vm.prank(other);
        vm.expectRevert(bytes("only buyer"));
        escrow.releaseV2(key);
    }

    // ═════════════════════════════════════════════════════════════
    //  v1 legacy: 完全保留
    // ═════════════════════════════════════════════════════════════
    function testV1CreateEscrowStillWorksWithHonestDefaults() public {
        vm.prank(buyer);
        escrow.createEscrow(agent, AMOUNT, "task-v1");
        bytes32 key = _legacyKey("task-v1");
        AgentEscrow.Escrow memory e = escrow.escrows(key);
        assertEq(e.taskKey, key, "v1 key = abi.encodePacked key");
        assertEq(e.termsHash, bytes32(0), "legacy has no terms");
        assertEq(e.quoteHash, bytes32(0), "legacy has no quote");
        assertEq(uint256(e.proofVersion), 0, "legacy = unversioned");
        assertEq(uint256(e.contractVersion), 1);
        assertEq(e.paymentAsset, address(token));
        assertEq(e.chainId, block.chainid);
        assertEq(e.deadline, uint64(block.timestamp), "v1: deadline = createdAt");
        assertEq(uint256(e.confirmationWindow), RELEASE_TIMEOUT);
        assertEq(escrow.claimableAt(key), block.timestamp + RELEASE_TIMEOUT, "claimableAt = createdAt + releaseTimeout");

        vm.expectEmit(true, true, true, true);
        emit AgentEscrow.ProofSubmitted(key, keccak256("cid:r"));
        vm.prank(agent);
        escrow.submitProof(key, keccak256("cid:r"));
        vm.prank(buyer);
        escrow.release(key);
        assertEq(token.balanceOf(agent), AMOUNT, "legacy release ok");
    }

    function testV1ZeroProofRejected() public {
        vm.prank(buyer);
        escrow.createEscrow(agent, AMOUNT, "task-v1-zero");
        bytes32 key = _legacyKey("task-v1-zero");
        vm.prank(agent);
        vm.expectRevert(bytes("invalid proof"));
        escrow.submitProof(key, bytes32(0));
    }

    function testLegacyAndV2KeysAreIndependent() public {
        // 同一个 taskId 字符串: v1 键 (encodePacked) 与 v2 键 (域标签 + abi.encode) 是两个值
        assertTrue(_legacyKey(TASK_ID) != _taskKey(TASK_ID));
        // 两个键各自独立建仓, 互不覆盖 (deployment manifest 两个都要记)
        vm.prank(buyer);
        escrow.createEscrow(agent, AMOUNT, TASK_ID);
        bytes32 v2Key = _createV2();
        assertEq(escrow.escrows(_legacyKey(TASK_ID)).amount, AMOUNT);
        assertEq(escrow.escrows(v2Key).amount, AMOUNT);
        assertEq(token.balanceOf(address(escrow)), AMOUNT * 2);
    }

    // ═════════════════════════════════════════════════════════════
    //  F2b: permissionless expire —— 修「agent 不交 proof 且 buyer 不 dispute → 永久锁死」
    //      条件: ACTIVE ∧ 无 proof ∧ now >= claimableAt + expireGrace
    //      效果: 全额退 buyer, 状态 → EXPIRED(4), 事件 ExpiredV2(taskKey, caller, buyer, amount)
    // ═════════════════════════════════════════════════════════════

    uint256 constant EXPIRE_GRACE = 7 days;

    /// 指定 taskId 建 v2 仓 (多仓场景用, 避免撞 "task exists")
    function _createV2With(string memory id) internal returns (bytes32) {
        vm.prank(buyer);
        return escrow.createEscrowV2(
            _taskKey(id), agent, AMOUNT, address(token),
            TERMS_HASH, QUOTE_HASH, INPUT_HASH, _contentHash(MANIFEST_DIGEST),
            _deadline(), CONF_WINDOW, PROOF_VERSION
        );
    }

    /// 主用例: 无 proof + 过 grace → **任何第三方**可调, buyer 全额, 状态 EXPIRED, 余额守恒
    function testF2b_ExpireV2_NoProofAfterGrace_AnyThirdPartyRefundsBuyer() public {
        bytes32 key = _createV2();
        uint256 buyerBefore = token.balanceOf(buyer);

        assertEq(uint256(escrow.escrows(key).state), 0, "ACTIVE");
        assertEq(escrow.escrows(key).proofHash, bytes32(0), "no proof");
        assertEq(escrow.expireGrace(), EXPIRE_GRACE, "default grace = 7 days");
        assertEq(escrow.expireAt(key), escrow.claimableAt(key) + EXPIRE_GRACE, "expireAt recipe");

        // 超时点已过但 grace 内 → 还不能 expire (agent 仍有机会交 proof 后 claim)
        vm.warp(escrow.claimableAt(key));
        vm.prank(other);
        vm.expectRevert(bytes("grace not elapsed"));
        escrow.expireV2(key);
        assertEq(uint256(escrow.escrows(key).state), 0, "still ACTIVE");

        // 恰好到 expireAt (边界含等号)
        vm.warp(escrow.expireAt(key));
        vm.expectEmit(true, true, true, true);
        emit AgentEscrow.ExpiredV2(key, other, buyer, AMOUNT);
        vm.prank(other); // 第三个无关地址: 不是 buyer / 不是 agent / 不是 owner
        escrow.expireV2(key);

        assertEq(token.balanceOf(buyer), buyerBefore + AMOUNT, "buyer refunded full amount (not agent)");
        assertEq(token.balanceOf(agent), 0, "agent got nothing (no proof)");
        assertEq(token.balanceOf(address(escrow)), 0, "escrow drained (conservation)");
        assertEq(token.totalSupply(), 10_000e6, "total supply conserved");
        assertEq(uint256(escrow.escrows(key).state), 4, "EXPIRED");
    }

    /// 与 F2 互补: 有 proof 时 expire 必须 revert, 资金走 claim 路径
    function testF2b_ExpireV2_WithProofReverts_ClaimPathStillWorks() public {
        bytes32 key = _createV2();
        vm.prank(agent);
        escrow.submitProofV2(key, _resultHash(), bytes32(0), PROOF_VERSION);

        vm.warp(escrow.expireAt(key) + 30 days); // 即使远超 grace 也不行
        vm.prank(other);
        vm.expectRevert(bytes("proof exists"));
        escrow.expireV2(key);

        assertEq(uint256(escrow.escrows(key).state), 0, "still ACTIVE, expire had no side effect");
        assertEq(token.balanceOf(buyer), 10_000e6 - AMOUNT, "buyer got no refund");
        assertEq(token.balanceOf(address(escrow)), AMOUNT, "funds still in escrow");

        // 有 proof → 合法出口是 claimAfterTimeoutV2 (by=2 timeout)
        vm.expectEmit(true, true, true, true);
        emit AgentEscrow.ReleasedV2(key, agent, AMOUNT, 2);
        vm.prank(agent);
        escrow.claimAfterTimeoutV2(key);
        assertEq(token.balanceOf(agent), AMOUNT, "agent claim ok");
        assertEq(uint256(escrow.escrows(key).state), 1, "RELEASED");
    }

    /// 未超期 (含 grace 内最后一秒) → revert "grace not elapsed"
    function testF2b_ExpireV2_TimeGatesAreStrict() public {
        bytes32 key = _createV2();
        uint256 expAt = escrow.expireAt(key);

        vm.prank(other); // 连 claimableAt 都还没到
        vm.expectRevert(bytes("grace not elapsed"));
        escrow.expireV2(key);

        vm.warp(expAt - 1); // grace 内最后 1 秒仍不许
        vm.prank(other);
        vm.expectRevert(bytes("grace not elapsed"));
        escrow.expireV2(key);

        vm.warp(expAt); // 到点即许 (边界)
        vm.prank(other);
        escrow.expireV2(key);
        assertEq(uint256(escrow.escrows(key).state), 4, "EXPIRED");
    }

    /// 已 RELEASED / REFUNDED / DISPUTED → "not active"; 已 EXPIRED 重复调用 → "not active"
    function testF2b_ExpireV2_NonActiveStatesRevert() public {
        bytes32 keyReleased = _createV2With("f2b-released");
        vm.prank(agent);
        escrow.submitProofV2(keyReleased, _resultHash(), bytes32(0), PROOF_VERSION);
        vm.prank(buyer);
        escrow.releaseV2(keyReleased);

        bytes32 keyRefunded = _createV2With("f2b-refunded");
        vm.prank(buyer);
        escrow.disputeV2(keyRefunded, keccak256("reason:x"));
        escrow.refundV2(keyRefunded, keccak256("reason:x"));

        bytes32 keyDisputed = _createV2With("f2b-disputed");
        vm.prank(buyer);
        escrow.disputeV2(keyDisputed, bytes32(0));

        bytes32 keyExpired = _createV2With("f2b-expired");
        vm.warp(escrow.expireAt(keyExpired));
        vm.prank(other);
        escrow.expireV2(keyExpired);

        assertEq(uint256(escrow.escrows(keyReleased).state), 1, "RELEASED");
        assertEq(uint256(escrow.escrows(keyRefunded).state), 3, "REFUNDED");
        assertEq(uint256(escrow.escrows(keyDisputed).state), 2, "DISPUTED");
        assertEq(uint256(escrow.escrows(keyExpired).state), 4, "EXPIRED");

        vm.startPrank(other);
        vm.expectRevert(bytes("not active"));
        escrow.expireV2(keyReleased);
        vm.expectRevert(bytes("not active"));
        escrow.expireV2(keyRefunded);
        vm.expectRevert(bytes("not active"));
        escrow.expireV2(keyDisputed); // 已 dispute → 走 owner 仲裁, 不走 expire
        vm.expectRevert(bytes("not active"));
        escrow.expireV2(keyExpired); // 重复调用
        vm.stopPrank();
    }

    /// 未知 taskKey (从未创建) → "unknown task" (不会把幻觉状态写成 EXPIRED, 也不会向 address(0) 转账)
    function testF2b_ExpireV2_UnknownTaskReverts() public {
        bytes32 key = _taskKey("never-created");
        vm.warp(block.timestamp + 30 days); // 时间再怎么过都不该"成功"
        vm.prank(other);
        vm.expectRevert(bytes("unknown task"));
        escrow.expireV2(key);
        assertEq(uint256(escrow.escrows(key).state), 0, "default record not dirtied");
        assertEq(escrow.escrows(key).buyer, address(0), "no fabricated buyer");
        assertEq(token.balanceOf(address(escrow)), 0, "no funds moved");
    }

    /// expireGrace 可配置 (默认 7 天, 不是写死的常量) + 权限/边界校验
    function testF2b_ExpireGraceConfigurable() public {
        assertEq(escrow.expireGrace(), EXPIRE_GRACE, "default 7 days");
        assertEq(escrow.DEFAULT_EXPIRE_GRACE(), EXPIRE_GRACE, "constant default 7 days");
        bytes32 key = _createV2();
        uint256 expAtDefault = escrow.expireAt(key);

        vm.prank(other);
        vm.expectRevert(bytes("not owner"));
        escrow.setExpireGrace(1 hours);

        vm.expectRevert(bytes("expireGrace must be > 0"));
        escrow.setExpireGrace(0);
        vm.expectRevert(bytes("expireGrace too large"));
        escrow.setExpireGrace(uint256(type(uint32).max) + 1);

        vm.expectEmit(true, true, true, true);
        emit AgentEscrow.ExpireGraceUpdated(EXPIRE_GRACE, 1 hours);
        escrow.setExpireGrace(1 hours);
        assertEq(escrow.expireGrace(), 1 hours, "applied");
        assertEq(escrow.expireAt(key), expAtDefault - EXPIRE_GRACE + 1 hours, "expireAt follows config");

        // 缩短 grace 后立刻可 expire → 证明生效值是状态变量, 不是编译期常量
        vm.warp(escrow.expireAt(key));
        vm.prank(other);
        escrow.expireV2(key);
        assertEq(uint256(escrow.escrows(key).state), 4, "EXPIRED");
        assertEq(token.balanceOf(buyer), 10_000e6, "buyer made whole");
    }

    /// v1 路径: 同一个洞同样修 (claim 需 proof ∧ refund 仅 DISPUTED+onlyOwner → 无 proof 时死锁)
    function testF2b_Expire_LegacyPathAlsoUnlocks() public {
        vm.prank(buyer);
        escrow.createEscrow(agent, AMOUNT, "task-expire-v1");
        bytes32 key = _legacyKey("task-expire-v1");
        uint256 claimAt = escrow.claimableAt(key);

        assertEq(claimAt, block.timestamp + RELEASE_TIMEOUT, "v1 claimableAt unchanged");
        assertEq(escrow.expireAt(key), claimAt + EXPIRE_GRACE, "v1 expireAt = claimableAt + grace");

        vm.prank(other); // 未超期
        vm.expectRevert(bytes("grace not elapsed"));
        escrow.expire(key);

        // F2 之后 v1 无 proof 也不能 claim → 这正是"永久锁死"的那条路
        vm.warp(claimAt + 1);
        vm.prank(agent);
        vm.expectRevert(bytes("no proof submitted"));
        escrow.claimAfterTimeout(key);

        // v1 逃生出口: 过 grace 后任何人可把全额退回 buyer
        vm.warp(escrow.expireAt(key));
        vm.expectEmit(true, true, true, true);
        emit AgentEscrow.ExpiredV2(key, other, buyer, AMOUNT);
        vm.prank(other);
        escrow.expire(key);

        assertEq(token.balanceOf(buyer), 10_000e6, "buyer fully refunded");
        assertEq(token.balanceOf(address(escrow)), 0, "conservation");
        assertEq(token.totalSupply(), 10_000e6, "total supply conserved");
        assertEq(uint256(escrow.escrows(key).state), 4, "EXPIRED");

        vm.prank(other);
        vm.expectRevert(bytes("not active")); // 重复调用
        escrow.expire(key);
    }

    /// 不变式: 枚举只在末尾追加 (旧数值冻结) + 旧方法选择器不变 + 新方法选择器冻结
    function testF2b_EnumAppendedAndSelectorsFrozen() public pure {
        assertEq(uint256(AgentEscrow.EscrowState.ACTIVE), 0, "ACTIVE=0");
        assertEq(uint256(AgentEscrow.EscrowState.RELEASED), 1, "RELEASED=1");
        assertEq(uint256(AgentEscrow.EscrowState.DISPUTED), 2, "DISPUTED=2");
        assertEq(uint256(AgentEscrow.EscrowState.REFUNDED), 3, "REFUNDED=3");
        assertEq(uint256(AgentEscrow.EscrowState.EXPIRED), 4, "EXPIRED=4 appended at end");

        // v1 七个方法 + v2 七个方法: 选择器逐个冻结 (改一个就是破坏旧客户端)
        assertEq(uint32(AgentEscrow.createEscrow.selector), uint32(0xe334e8dd), "createEscrow");
        assertEq(uint32(AgentEscrow.submitProof.selector), uint32(0x968e72bd), "submitProof");
        assertEq(uint32(AgentEscrow.release.selector), uint32(0x67d42a8b), "release");
        assertEq(uint32(AgentEscrow.claimAfterTimeout.selector), uint32(0x22399f5d), "claimAfterTimeout");
        assertEq(uint32(AgentEscrow.dispute.selector), uint32(0xadd98c70), "dispute");
        assertEq(uint32(AgentEscrow.refund.selector), uint32(0x7249fbb6), "refund");
        assertEq(uint32(AgentEscrow.releaseAfterArbitration.selector), uint32(0x8b15b891), "releaseAfterArbitration");
        assertEq(uint32(AgentEscrow.createEscrowV2.selector), uint32(0x152215b8), "createEscrowV2");
        assertEq(uint32(AgentEscrow.submitProofV2.selector), uint32(0x9037b29b), "submitProofV2");
        assertEq(uint32(AgentEscrow.releaseV2.selector), uint32(0xa7997ba4), "releaseV2");
        assertEq(uint32(AgentEscrow.claimAfterTimeoutV2.selector), uint32(0xa53cf2b0), "claimAfterTimeoutV2");
        assertEq(uint32(AgentEscrow.disputeV2.selector), uint32(0x484f5d07), "disputeV2");
        assertEq(uint32(AgentEscrow.refundV2.selector), uint32(0xf32b1e51), "refundV2");
        assertEq(uint32(AgentEscrow.releaseAfterArbitrationV2.selector), uint32(0x673765b0), "releaseAfterArbitrationV2");
        // 本次新增 (与上面任何旧选择器都不相同 → 没撞选择器)
        assertEq(uint32(AgentEscrow.expire.selector), uint32(0xc6441798), "expire");
        assertEq(uint32(AgentEscrow.expireV2.selector), uint32(0x02c58a63), "expireV2");
        assertEq(uint32(AgentEscrow.expireAt.selector), uint32(0x12d89732), "expireAt");
        assertEq(uint32(AgentEscrow.setExpireGrace.selector), uint32(0x5c9442f1), "setExpireGrace");
    }
}