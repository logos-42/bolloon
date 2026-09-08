// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ResourceERC721 完备性测试 (Foundry/forge-std)。
// 覆盖: mint 成功/重复 mint/零地址; ownerOf 未铸; approve 仅 owner;
//       safeTransferFrom 成功/非 owner/非授权/零地址/授权被清除; tokenURI; 事件断言。
import {Test} from "forge-std/Test.sol";
import {ResourceERC721} from "../ResourceERC721.sol";

contract ResourceERC721Test is Test {
    ResourceERC721 erc;
    address constant alice = address(0xA11CE);
    address constant bob = address(0xB0B);
    address constant carol = address(0xCA0);

    function setUp() public {
        erc = new ResourceERC721();
    }

    // ── mint ─────────────────────────────────────────────
    function testMintSetsOwnerBalanceTokenURI() public {
        erc.mint(alice, 1, "cid-abc");
        assertEq(erc.ownerOf(1), alice, "owner");
        assertEq(erc.balanceOf(alice), 1, "balance");
        assertEq(erc.tokenURI(1), "cid-abc", "tokenURI");
    }

    function testMintMultipleTokensDistinctOwners() public {
        erc.mint(alice, 1, "a");
        erc.mint(bob, 2, "b");
        assertEq(erc.ownerOf(1), alice);
        assertEq(erc.ownerOf(2), bob);
        assertEq(erc.balanceOf(alice), 1);
        assertEq(erc.balanceOf(bob), 1);
    }

    function testMintDuplicateTokenIdReverts() public {
        erc.mint(alice, 1, "a");
        vm.expectRevert(bytes("exists"));
        erc.mint(bob, 1, "b");
    }

    function testMintZeroAddressReverts() public {
        vm.expectRevert(bytes("zero to"));
        erc.mint(address(0), 1, "a");
    }

    // ── ownerOf / balanceOf ───────────────────────────────
    function testOwnerOfUnmintedReverts() public {
        vm.expectRevert(bytes("not minted"));
        erc.ownerOf(999);
    }

    function testBalanceOfZeroForUnminted() public {
        assertEq(erc.balanceOf(alice), 0);
    }

    // ── approve ───────────────────────────────────────────
    function testApproveByOwner() public {
        erc.mint(alice, 1, "a");
        vm.prank(alice);
        erc.approve(carol, 1);
    }

    function testApproveNonOwnerReverts() public {
        erc.mint(alice, 1, "a");
        vm.prank(bob);
        vm.expectRevert(bytes("not owner"));
        erc.approve(bob, 1);
    }

    // ── safeTransferFrom ──────────────────────────────────
    function testTransferByOwnerMovesOwnership() public {
        erc.mint(alice, 1, "a");
        vm.prank(alice);
        erc.safeTransferFrom(alice, bob, 1);
        assertEq(erc.ownerOf(1), bob);
        assertEq(erc.balanceOf(alice), 0);
        assertEq(erc.balanceOf(bob), 1);
    }

    function testTransferByApprovedOperator() public {
        erc.mint(alice, 1, "a");
        vm.prank(alice);
        erc.approve(carol, 1);
        vm.prank(carol);
        erc.safeTransferFrom(alice, bob, 1);
        assertEq(erc.ownerOf(1), bob);
    }

    function testTransferApprovalClearedAfterTransfer() public {
        erc.mint(alice, 1, "a");
        vm.prank(alice);
        erc.approve(carol, 1);
        vm.prank(carol);
        erc.safeTransferFrom(alice, bob, 1);
        // 授权已清除: carol 不再有权转 alice 的 (已属 bob)
        vm.prank(carol);
        vm.expectRevert(bytes("not from"));
        erc.safeTransferFrom(alice, bob, 1);
    }

    function testTransferNotFromReverts() public {
        erc.mint(alice, 1, "a");
        vm.prank(bob);
        vm.expectRevert(bytes("not from"));
        erc.safeTransferFrom(alice, bob, 1);
    }

    function testTransferUnauthorizedReverts() public {
        erc.mint(alice, 1, "a");
        // 未授权第三方 (carol 未 approve)
        vm.prank(carol);
        vm.expectRevert(bytes("not authorized"));
        erc.safeTransferFrom(alice, bob, 1);
    }

    function testTransferZeroAddressReverts() public {
        erc.mint(alice, 1, "a");
        vm.prank(alice);
        vm.expectRevert(bytes("zero to"));
        erc.safeTransferFrom(alice, address(0), 1);
    }

    // ── tokenURI ──────────────────────────────────────────
    function testTokenURIUnmintedEmpty() public {
        assertEq(erc.tokenURI(777), "");
    }

    function testTokenURIPersistsAcrossTransfer() public {
        erc.mint(alice, 1, "cid-x");
        vm.prank(alice);
        erc.safeTransferFrom(alice, bob, 1);
        assertEq(erc.tokenURI(1), "cid-x", "CID 随 token 流转, 不可变");
    }

    // ── 事件 ──────────────────────────────────────────────
    function testMintEmitsTransfer() public {
        vm.expectEmit(true, true, true, true);
        emit ResourceERC721.Transfer(address(0), alice, uint256(7));
        erc.mint(alice, 7, "c");
    }

    function testTransferEmitsTransfer() public {
        erc.mint(alice, 1, "a");
        vm.expectEmit(true, true, true, true);
        emit ResourceERC721.Transfer(alice, bob, uint256(1));
        vm.prank(alice);
        erc.safeTransferFrom(alice, bob, 1);
    }
}
