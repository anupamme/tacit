// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacSynth} from "../src/TacSynth.sol";
import {TestTac, MockFeed, VaultConfig} from "./TacVaultMocks.sol";
import {TacVaultCampaignOracle} from "./TacVaultCampaign.t.sol";

abstract contract TacVaultPropsBase is Test {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;
    TestTac tac;
    TacVaultCampaignOracle oracle;
    MockFeed feed;
    TacVault vault;
    TacSynth synth;
    address bob = address(0xB0B);

    function _newVault() internal returns (TacVault v) {
        TacVault.Config memory c = VaultConfig.defaults(address(tac), address(oracle), address(feed), address(0x0123));
        c.mintRatioBps = 35_000;
        c.liqRatioBps = 20_000;
        c.liqBonusBps = 2_500;
        c.auctionDuration = 5_400;
        c.ownerWindow = 1_200;
        c.liqWindow = 6 hours;
        c.borrowFeeBps = 0;
        c.redemptionFeeBps = 50;
        c.feedMaxStaleness = 3_900;
        c.depthBps = 500;
        c.minDebt = 100e18;
        c.debtCeiling = 5_000_000e18;
        v = new TacVault(c);
    }

    function _base() internal {
        vm.warp(1_800_000_000);
        tac = new TestTac();
        oracle = new TacVaultCampaignOracle();
        oracle.setDepth(1_000_000e18);
        feed = new MockFeed();
        feed.set(4000e8);
        vault = _newVault();
        synth = vault.SYNTH();
        _fund(bob);
    }

    function _fund(address u) internal {
        tac.mint(u, 100_000_000e18);
        vm.startPrank(u);
        tac.approve(address(vault), type(uint256).max);
        synth.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    function _open(address u, uint256 coll, uint256 debt) internal {
        vm.startPrank(u);
        vault.deposit(coll);
        vault.borrow(debt, 0);
        vm.stopPrank();
    }

    function _pFor(uint256 coll, uint256 debt, uint256 ratioBps) internal pure returns (uint256) {
        return (debt * ratioBps / BPS * WAD / coll) * 1e8 / 4000e8;
    }
}

/// Rounding and fairness of partial bids, partial absorbs and redemption, by fuzzing.
contract TacVaultRoundingProps is TacVaultPropsBase {
    address alice = address(0xA11CE);
    address carol = address(0xCA201);

    function setUp() public {
        _base();
        _fund(alice);
        _fund(carol);
        // bob is the deep pocket that holds SYNTH
        _open(bob, 50_000_000e18, 300_000e18);
    }

    function _twinVaults(uint256 coll, uint256 debtFrac, uint256 ratioBps) internal returns (uint256 debt) {
        coll = bound(coll, 2_500e18, 400_000e18);
        uint256 maxDebt = vault.valueOf(coll, true) * BPS / vault.MINT_RATIO_BPS();
        debt = maxDebt * bound(debtFrac, 4_500, 10_000) / BPS;
        if (debt < 100e18) debt = 100e18;
        _open(alice, coll, debt);
        _open(carol, coll, debt);
        oracle.setAll(_pFor(coll, debt, bound(ratioBps, 3_000, 19_900)), 0);
        vault.liquidate(alice);
        vault.liquidate(carol);
    }

    /// Any number of partial bids at one moment never take more TAC than one full bid, and the owner is never worse
    /// off for the split.
    function testFuzz_splitBidsNeverBeatOneBid(
        uint256 coll,
        uint256 debtFrac,
        uint256 ratioBps,
        uint256 wait_,
        uint256 f1,
        uint256 f2,
        uint256 f3
    ) public {
        uint256 debt = _twinVaults(coll, debtFrac, ratioBps);
        (uint256 c0,,) = vault.vaults(alice);
        skip(vault.OWNER_WINDOW() + bound(wait_, 0, 2 hours)); // outsiders bid after the owner's window
        feed.set(4000e8);
        // one SYNTH wei of rounding in the offer is WAD / price TAC wei
        uint256 unit = WAD / vault.offerPrice() + 2;

        address bidderA = address(0xB1A);
        address bidderB = address(0xB1B);
        vm.startPrank(bob);
        synth.transfer(bidderA, debt);
        synth.transfer(bidderB, debt);
        vm.stopPrank();
        for (uint256 i; i < 2; ++i) {
            address b = i == 0 ? bidderA : bidderB;
            vm.prank(b);
            synth.approve(address(vault), type(uint256).max);
        }

        vm.prank(bidderA);
        uint256 full = vault.bid(alice, type(uint256).max, 0);

        uint256 split;
        uint256 n;
        uint256[3] memory fs = [f1, f2, f3];
        for (uint256 i; i < 3; ++i) {
            (, uint256 d,) = vault.vaults(carol);
            uint256 amt = d * bound(fs[i], 1, 9_999) / BPS;
            vm.prank(bidderB);
            try vault.bid(carol, amt, 0) returns (uint256 t) {
                split += t;
                ++n;
            } catch {}
        }
        // a partial bid at the offer can lift the vault over the line; then only the owner may bid, so the last
        // piece is not always possible for an outsider
        vm.prank(bidderB);
        try vault.bid(carol, type(uint256).max, 0) returns (uint256 t) {
            split += t;
            ++n;
        } catch {}
        uint256 paidB = debt - synth.balanceOf(bidderB);
        assertEq(paidB, debt - synth.balanceOf(bidderB));
        (uint256 cA,,) = vault.vaults(alice);
        (uint256 cC,,) = vault.vaults(carol);

        // per SYNTH paid, the pieces never took more TAC than the one bid did (at most a wei per piece lost)
        // the offer floors the debt (with its bonus) to a SYNTH wei, worth `unit` TAC wei: pieces can gain a few such
        // wei over one bid, nothing more
        assertLe(split * debt, full * paidB + (n + 1) * unit * debt, "splitting a bid never takes more per unit paid");
        assertEq(synth.balanceOf(bidderA), 0, "the full bid paid exactly the debt");
        assertEq(cA, c0 - full);
        assertEq(cC, c0 - split);
        if (paidB == debt) {
            assertLe(split, full + (n + 1) * unit, "splitting a bid gains at most a few TAC wei");
            assertLe(full, split + (n + 1) * unit, "and loses at most a few");
            assertGe(cC + (n + 1) * unit, cA);
        }
    }

    /// Partial absorbs from a growing reserve burn the same debt and send at most the same TAC as one absorb.
    function testFuzz_splitAbsorbNeverBeatsOne(uint256 coll, uint256 debtFrac, uint256 f1, uint256 f2) public {
        uint256 debt = _twinVaults(coll, debtFrac, 4_000); // 40% of the line: well under water
        (uint256 c0,,) = vault.vaults(alice);
        skip(5_400);
        feed.set(4000e8);
        // one reserve of the whole debt for alice
        vm.prank(bob);
        synth.transfer(address(vault), debt);
        vault.absorb(alice);
        (uint256 cA, uint256 dA, uint256 sA) = vault.vaults(alice);
        assertEq(dA, 0);
        assertEq(sA, 0);
        uint256 toSinkOne = c0 - cA;
        assertEq(toSinkOne, c0, "an underwater vault's whole collateral goes to the sink");
        // carol: the reserve arrives in pieces (each absorbs what it covers, leaving at least MIN_DEBT)
        uint256 sink0 = tac.balanceOf(address(0xdEaD));
        uint256[2] memory fs = [f1, f2];
        for (uint256 i; i < 2; ++i) {
            (, uint256 d,) = vault.vaults(carol);
            uint256 piece = d * bound(fs[i], 1, 9_000) / BPS;
            if (piece == 0) continue;
            vm.prank(bob);
            synth.transfer(address(vault), piece);
            try vault.absorb(carol) {} catch {}
        }
        (, uint256 dLeft, uint256 sLeft) = vault.vaults(carol);
        if (sLeft != 0) {
            vm.prank(bob);
            synth.transfer(address(vault), dLeft);
            vault.absorb(carol);
        }
        (uint256 cC, uint256 dC,) = vault.vaults(carol);
        assertEq(dC, 0);
        assertLe(tac.balanceOf(address(0xdEaD)) - sink0, c0);
        assertEq(cC + (tac.balanceOf(address(0xdEaD)) - sink0), c0, "TAC is conserved");
    }

    /// A redemption never lowers a vault's collateral per unit of debt, and never takes more than the debt repaid
    /// less the base fee, at the liquidation view; the fee runs from 0.5% at 200% to 2% at 400%.
    function testFuzz_redeemNeverLowersTheRatio(uint256 coll, uint256 ratioBps, uint256 amtSel, uint256 rise) public {
        coll = bound(coll, 3_000e18, 400_000e18);
        address alice_ = alice;
        uint256 debt = vault.valueOf(coll, true) * BPS / vault.MINT_RATIO_BPS() * 9_900 / BPS;
        if (debt < 100e18) debt = 100e18;
        _open(alice_, coll, debt);
        // move the price so the vault sits between the liquidation ratio and twice that
        ratioBps = bound(ratioBps, 20_000, 39_990);
        uint256 p = _pFor(coll, debt, ratioBps);
        vm.assume(p > 0);
        // the spot may sit above the medians (a rally): redemption takes the higher
        oracle.setViews(p, p, p, p, 0);
        oracle.setLatest(p + p * bound(rise, 0, 5_000) / BPS); // the newest recorded interval is above the medians
        (uint256 c0, uint256 d0,) = vault.vaults(alice_);
        uint256 actual = vault.valueOf(c0, false) * BPS / d0;
        if (actual < 20_000 || actual >= 40_000) return;
        uint256 amt = bound(amtSel, 1, d0);
        if (d0 - amt != 0 && d0 - amt < 100e18) amt = d0; // respect the minimum
        vm.prank(bob);
        uint256 got = vault.redeem(alice_, amt, 0);
        (uint256 c1, uint256 d1,) = vault.vaults(alice_);
        if (d1 != 0) assertGe(c1 * d0, c0 * d1, "collateral per debt never falls");
        assertLe(vault.valueOf(got, false), amt * (BPS - 50) / BPS, "never more than the debt less the base fee");
        assertEq(c1, c0 - got);
        assertEq(d1, d0 - amt);
    }
}

/// What the owner can and cannot do: set the borrow fee and the debt ceiling, hand over the role.
contract TacVaultOwnerProps is TacVaultPropsBase {
    address alice = address(0xA11CE);
    address other = address(0xBAD);

    function setUp() public {
        _base();
        _fund(alice);
    }

    function test_theOwnerCanOnlySetTheFeeTheCeilingTheFeeAddressTheSinkAndHandOver() public {
        _open(alice, 100_000e18, 5_000e18);
        (uint256 c0, uint256 d0,) = vault.vaults(alice);
        vm.startPrank(address(0x0123));
        vault.setDebtCeiling(type(uint256).max);
        vault.setBorrowFee(500);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.setBorrowFee(501);
        vault.setFeeTo(other);
        vault.setTacSink(other);
        vault.transferOwnership(other);
        vm.stopPrank();
        vm.startPrank(other);
        vault.setBorrowFee(0);
        vault.renounceOwnership();
        vm.stopPrank();
        // nothing of alice's changed
        (uint256 c1, uint256 d1, uint256 s1) = vault.vaults(alice);
        assertEq(c1, c0);
        assertEq(d1, d0);
        assertEq(s1, 0);
        // the owner role moves no collateral and mints or burns nothing
        vm.startPrank(other);
        vm.expectRevert(Ownable.Unauthorized.selector);
        vault.setBorrowFee(1);
        vm.expectRevert(TacSynth.NotMinter.selector);
        synth.mint(other, 1);
        vm.expectRevert(TacSynth.NotMinter.selector);
        synth.burnFrom(alice, 1);
        vm.stopPrank();
        // a vault's own user is not the owner
        vm.startPrank(alice);
        vm.expectRevert(Ownable.Unauthorized.selector);
        vault.setBorrowFee(0);
        vm.stopPrank();
    }

    /// With the ceiling at zero only new borrowing stops: repay and withdraw still work.
    function test_ceilingZeroStrandsNoOne() public {
        _open(alice, 100_000e18, 5_000e18);
        vm.prank(address(0x0123));
        vault.setDebtCeiling(0);
        vm.startPrank(alice);
        vm.expectRevert(TacVault.OverCeiling.selector);
        vault.borrow(100e18, 0);
        vault.repay(alice, type(uint256).max);
        vault.withdraw(type(uint256).max);
        vm.stopPrank();
    }

    /// The owner-set fee applies to the amount the signature authorises; a signature bounds it.
    function test_theFeeIsBoundedBySignatureAndCall() public {
        vm.prank(address(0x0123));
        vault.setBorrowFee(500);
        vm.startPrank(alice);
        vault.deposit(100_000e18);
        vm.expectRevert(TacVault.FeeTooHigh.selector);
        vault.borrow(1_000e18, 499);
        vault.borrow(1_000e18, 500);
        vm.stopPrank();
        (, uint256 d,) = vault.vaults(alice);
        assertEq(d, 1_050e18);
    }

    /// The setters and the ownership functions are owner-only.
    function test_nobodyElseCanCallTheSetters() public {
        vm.startPrank(other);
        vm.expectRevert(Ownable.Unauthorized.selector);
        vault.setBorrowFee(0);
        vm.expectRevert(Ownable.Unauthorized.selector);
        vault.setDebtCeiling(0);
        vm.expectRevert(Ownable.Unauthorized.selector);
        vault.transferOwnership(other);
        vm.expectRevert(Ownable.Unauthorized.selector);
        vault.renounceOwnership();
        vm.stopPrank();
    }
}

contract TacVaultWallet1271 {
    bytes32 public approved;

    function approve(bytes32 h) external {
        approved = h;
    }

    function isValidSignature(bytes32 h, bytes calldata) external view returns (bytes4) {
        return h == approved ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

/// An owner contract that burns all the gas it is given.
contract TacVaultGasBomb {
    fallback() external {
        assembly {
            for {} 1 {} {}
        }
    }
}

/// Signatures (EIP-712, ERC-1271, EIP-2098), nonces, deadlines, and multicall.
contract TacVaultSignatureProps is TacVaultPropsBase {
    uint256 constant KEY = 0xBEEF;
    address alice = address(0xA11CE);

    function setUp() public {
        _base();
        _fund(alice);
    }

    function _borrowSig(
        TacVault v,
        uint256 key,
        address owner,
        uint256 amt,
        uint256 maxFee,
        uint256 minColl,
        address to,
        uint256 nonce,
        uint256 dl
    ) internal view returns (bytes memory sig) {
        bytes32 sh = keccak256(abi.encode(v.BORROW(), owner, amt, maxFee, minColl, to, nonce, dl));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(key, v.digest(sh));
        sig = abi.encodePacked(r, s, vv);
    }

    function test_replayAcrossVaultsAndChainsFails() public {
        address owner = vm.addr(KEY);
        TacVault other = _newVault();
        tac.mint(alice, 1_000_000e18);
        vm.startPrank(alice);
        tac.approve(address(vault), type(uint256).max);
        tac.approve(address(other), type(uint256).max);
        vault.depositFor(owner, 100_000e18);
        other.depositFor(owner, 100_000e18);
        vm.stopPrank();
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _borrowSig(vault, KEY, owner, 500e18, 0, 100_000e18, bob, 0, dl);
        vm.expectRevert(TacVault.BadSignature.selector);
        other.borrowFor(owner, 500e18, 0, 100_000e18, bob, dl, sig);
        vm.chainId(5);
        vm.expectRevert(TacVault.BadSignature.selector);
        vault.borrowFor(owner, 500e18, 0, 100_000e18, bob, dl, sig);
        vm.chainId(31337); // Foundry's default
        vault.borrowFor(owner, 500e18, 0, 100_000e18, bob, dl, sig);
    }

    function test_borrowSignatureCannotBeUsedAsAWithdrawal() public {
        address owner = vm.addr(KEY);
        vm.prank(alice);
        vault.depositFor(owner, 100_000e18);
        uint256 dl = block.timestamp + 1 hours;
        // a Borrow signature over (owner, amount, ..., to, nonce, deadline) is not a valid Withdraw signature
        bytes memory sig = _borrowSig(vault, KEY, owner, 100_000e18, 0, 0, bob, 0, dl);
        vm.expectRevert(TacVault.BadSignature.selector);
        vault.withdrawFor(owner, 100_000e18, bob, dl, sig);
    }

    function test_deadlineIsInclusiveAndAnExpiredSignatureFails() public {
        address owner = vm.addr(KEY);
        vm.prank(alice);
        vault.depositFor(owner, 100_000e18);
        uint256 dl = block.timestamp + 100;
        bytes memory sig = _borrowSig(vault, KEY, owner, 500e18, 0, 0, bob, 0, dl);
        skip(101);
        feed.set(4000e8);
        vm.expectRevert(TacVault.Expired.selector);
        vault.borrowFor(owner, 500e18, 0, 0, bob, dl, sig);
        // a fresh one at exactly the deadline works
        dl = block.timestamp;
        sig = _borrowSig(vault, KEY, owner, 500e18, 0, 0, bob, 0, dl);
        vault.borrowFor(owner, 500e18, 0, 0, bob, dl, sig);
    }

    function test_zeroAddressesAreRefused() public {
        address owner = vm.addr(KEY);
        vm.prank(alice);
        vault.depositFor(owner, 100_000e18);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _borrowSig(vault, KEY, owner, 500e18, 0, 0, address(0), 0, dl);
        vm.expectRevert(TacVault.BadAmount.selector);
        vault.borrowFor(owner, 500e18, 0, 0, address(0), dl, sig);
        vm.expectRevert(TacVault.BadAmount.selector);
        vault.borrowFor(address(0), 500e18, 0, 0, bob, dl, hex"");
    }

    /// A 64-byte (EIP-2098) signature is accepted; a nonce is spent once, whatever the encoding.
    function test_compactSignatureAndOneShotNonce() public {
        address owner = vm.addr(KEY);
        vm.prank(alice);
        vault.depositFor(owner, 100_000e18);
        uint256 dl = block.timestamp + 1 hours;
        bytes32 sh =
            keccak256(abi.encode(vault.BORROW(), owner, uint256(500e18), uint256(0), uint256(0), bob, uint256(0), dl));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, vault.digest(sh));
        bytes32 vs = bytes32(uint256(s) | (uint256(v - 27) << 255));
        vault.borrowFor(owner, 500e18, 0, 0, bob, dl, abi.encodePacked(r, vs));
        // the high-s twin of the same signature (malleated) recovers the same signer but the nonce is spent
        bytes32 sHigh = bytes32(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141 - uint256(s));
        vm.expectRevert(TacVault.BadSignature.selector);
        vault.borrowFor(owner, 500e18, 0, 0, bob, dl, abi.encodePacked(r, sHigh, v == 27 ? uint8(28) : uint8(27)));
    }

    /// A contract owner is checked through ERC-1271 (no key needed), and only for the approved digest.
    function test_contractOwnerThroughErc1271() public {
        TacVaultWallet1271 w = new TacVaultWallet1271();
        vm.prank(alice);
        vault.depositFor(address(w), 100_000e18);
        uint256 dl = block.timestamp + 1 hours;
        bytes32 sh = keccak256(
            abi.encode(vault.BORROW(), address(w), uint256(500e18), uint256(0), uint256(0), bob, uint256(0), dl)
        );
        vm.expectRevert(TacVault.BadSignature.selector);
        vault.borrowFor(address(w), 500e18, 0, 0, bob, dl, hex"1234");
        w.approve(vault.digest(sh));
        vault.borrowFor(address(w), 500e18, 0, 0, bob, dl, hex"1234");
        assertEq(synth.balanceOf(bob), 500e18);
        // and a different amount is a different digest
        vm.expectRevert(TacVault.BadSignature.selector);
        vault.borrowFor(address(w), 501e18, 0, 0, bob, dl, hex"1234");
    }

    /// An EOA, a precompile or a non-answering contract as `owner` never validates a random signature.
    function test_noOwnerValidatesAGarbageSignature() public {
        uint256 dl = block.timestamp + 1 hours;
        address[6] memory owners =
            [address(0x1), address(0x2), address(0x4), address(0x5), address(0xdead), address(tac)];
        for (uint256 i; i < owners.length; ++i) {
            vm.expectRevert(TacVault.BadSignature.selector);
            vault.borrowFor(
                owners[i], 500e18, 0, 0, bob, dl, abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), uint8(27))
            );
        }
        // a gas bomb as owner burns the caller's own gas only (63/64 forwarded), then reverts BadSignature or OOG
        TacVaultGasBomb bomb = new TacVaultGasBomb();
        vm.expectRevert();
        vault.borrowFor{gas: 1_000_000}(address(bomb), 500e18, 0, 0, bob, dl, hex"");
    }

    /// A signature naming a recipient moves SYNTH only there; the relayer gains nothing.
    function test_relayerCannotRedirectASignedBorrowOrWithdraw() public {
        address owner = vm.addr(KEY);
        vm.prank(alice);
        vault.depositFor(owner, 100_000e18);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _borrowSig(vault, KEY, owner, 500e18, 0, 0, bob, 0, dl);
        vm.expectRevert(TacVault.BadSignature.selector);
        vault.borrowFor(owner, 500e18, 0, 0, address(this), dl, sig);
        vm.expectRevert(TacVault.BadSignature.selector);
        vault.borrowFor(owner, 501e18, 0, 0, bob, dl, sig);
        vm.expectRevert(TacVault.BadSignature.selector);
        vault.borrowFor(owner, 500e18, 0, 1, bob, dl, sig);
        vm.expectRevert(TacVault.BadSignature.selector);
        vault.borrowFor(owner, 500e18, 1, 0, bob, dl, sig);
    }

    /// multicall keeps the sender, and refuses any ETH value.
    function test_multicallKeepsTheSenderAndValueHandling() public {
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(TacVault.deposit, (1_000e18));
        calls[1] = abi.encodeCall(TacVault.borrow, (100e18, 0));
        vm.prank(alice);
        vault.multicall(calls);
        (uint256 c, uint256 d,) = vault.vaults(alice);
        assertEq(c, 1_000e18);
        assertEq(d, 100e18);
        // the sender is preserved: bob cannot be debited through alice's call, and alice's call never credits bob
        (c, d,) = vault.vaults(bob);
        assertEq(d, 0);

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert();
        vault.multicall{value: 1}(calls); // non-payable members reject value
        bytes[] memory none = new bytes[](0);
        vm.prank(alice);
        vm.expectRevert(); // Solady's multicall refuses any msg.value, so ETH cannot be stranded by it
        vault.multicall{value: 1}(none);
        assertEq(address(vault).balance, 0);
    }

    function test_multicallCannotCallOwnerFunctionsForAnotherCaller() public {
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(TacVault.setDebtCeiling, (0));
        vm.prank(alice);
        vm.expectRevert(Ownable.Unauthorized.selector);
        vault.multicall(calls);
        // nested multicalls keep the sender too
        bytes[] memory inner = new bytes[](1);
        inner[0] = abi.encodeCall(TacVault.deposit, (1_000e18));
        bytes[] memory outer = new bytes[](1);
        outer[0] = abi.encodeCall(vault.multicall, (inner));
        vm.prank(alice);
        vault.multicall(outer);
        (uint256 c,,) = vault.vaults(alice);
        assertEq(c, 1_000e18);
    }
}
