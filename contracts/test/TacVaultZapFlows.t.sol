// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacitEvmPool} from "../src/TacitEvmPool.sol";
import {TacitEvmPoolRouter} from "../src/TacitEvmPoolRouter.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacSynth} from "../src/TacSynth.sol";
import {TacVaultZap} from "../src/TacVaultZap.sol";
import {TestTac, MockOracle, MockFeed, VaultConfig} from "./TacVaultMocks.sol";

/// Accepts every proof: the circuit is the ceremony's and unchanged; these tests exercise the contracts around it.
contract TacVaultZapFlowsVerifier {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[11] calldata)
        external
        pure
        returns (bool)
    {
        return true;
    }
}

/// The zap and the SYNTH pool's deposit boxes with other parties in the picture: who can complete a box, where an
/// unfinished box refunds, and what the zap keeps. TacitEvmPool and its router are the deployed contracts, unchanged;
/// only the Groth16 verifier is replaced.
contract TacVaultZapFlows is Test {
    uint256 constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 constant COLL = 15_000e18;
    uint256 constant DEBT = 2_000e18;

    TestTac tac;
    TacVault vault;
    TacSynth dollar;
    TacitEvmPool dollarPool;
    TacitEvmPoolRouter dollarRouter;
    TacVaultZap zap;
    uint256 ownerKey = 0xA11CE;
    address owner;
    address alice = address(0xA1);
    address stranger = address(0xBAD);
    uint256 nfSeq = 1;

    function setUp() public {
        vm.warp(1_800_000_000);
        owner = vm.addr(ownerKey);
        tac = new TestTac();
        MockOracle oracle = new MockOracle();
        oracle.set(1e14); // 0.40 USD per TAC
        MockFeed feed = new MockFeed();
        feed.set(4000e8);
        vault = new TacVault(VaultConfig.defaults(address(tac), address(oracle), address(feed), address(0x0123)));
        dollar = vault.SYNTH();
        address verifier = address(new TacVaultZapFlowsVerifier());
        dollarPool = new TacitEvmPool(verifier, address(dollar));
        dollarRouter = new TacitEvmPoolRouter(address(dollarPool), address(0), address(0), address(0), address(0));
        zap = new TacVaultZap(address(vault), address(dollarRouter));
    }

    // ───────────── helpers (the proof itself is accepted) ─────────────

    function _tx(int256 extAmount, address rel, uint256 fee, uint256 out0, uint256 out1)
        internal
        returns (TacitEvmPoolRouter.Tx memory t)
    {
        (bytes32 root, uint256 size) = dollarPool.head();
        t.recipient = address(0);
        t.extAmount = extAmount;
        t.relayer = rel;
        t.fee = fee;
        t.publicInputs[0] = uint256(root);
        t.publicInputs[1] = uint256(root);
        t.publicInputs[2] = uint256(keccak256(abi.encode(root, out0, out1, nfSeq))) % FIELD;
        t.publicInputs[3] = size;
        int256 pa = (extAmount - int256(fee)) % int256(FIELD);
        if (pa < 0) pa += int256(FIELD);
        t.publicInputs[4] = uint256(pa);
        t.publicInputs[5] = uint256(
            keccak256(
                abi.encode(
                    block.chainid, address(dollarPool), address(0), extAmount, rel, fee, keccak256(""), keccak256("")
                )
            )
        ) % FIELD;
        t.publicInputs[6] = dollarPool.ASSET_FIELD();
        t.publicInputs[7] = 0;
        t.publicInputs[9] = out0;
        t.publicInputs[10] = out1;
    }

    function _signBorrow(uint256 amount, address to, uint256 minCollateral) internal view returns (bytes memory) {
        bytes32 sh = keccak256(
            abi.encode(
                vault.BORROW(),
                owner,
                amount,
                uint256(0),
                minCollateral,
                to,
                vault.nonces(owner),
                block.timestamp + 1 hours
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, vault.digest(sh));
        return abi.encodePacked(r, s, v);
    }

    function _intent(uint256 amount, uint256 leaf) internal view returns (TacitEvmPoolRouter.DepositIntent memory) {
        return TacitEvmPoolRouter.DepositIntent({
            amount: amount,
            outLeaf0: leaf,
            outLeaf1: 0,
            memo0Hash: keccak256(""),
            memo1Hash: keccak256(""),
            refund: alice,
            deadline: uint64(block.timestamp + 1 days),
            nonce: leaf
        });
    }

    function _giveOwnerCollateral(uint256 amount) internal {
        tac.mint(alice, amount);
        vm.startPrank(alice);
        tac.approve(address(vault), amount);
        vault.depositFor(owner, amount);
        vm.stopPrank();
    }

    // ───────────── deposit boxes ─────────────

    /// Someone who sees the signature submits only its borrow, ahead of the zap: the dollars still land in the signed
    /// deposit box, the zap transaction fails and costs its sender nothing, and anyone can finish the deposit, which
    /// funds only the owner's notes.
    function test_aBorrowSubmittedAheadOfTheZapStillFundsOnlyTheOwnersNotes() public {
        _giveOwnerCollateral(COLL);
        TacitEvmPoolRouter.DepositIntent memory intent = _intent(DEBT, 41);
        address box = dollarRouter.depositBoxOf(intent);
        bytes memory sig = _signBorrow(DEBT, box, COLL);
        uint256 dl = block.timestamp + 1 hours;

        vm.prank(stranger);
        vault.borrowFor(owner, DEBT, 0, COLL, box, dl, sig);
        assertEq(dollar.balanceOf(box), DEBT, "the SYNTH went to the box the owner signed");
        assertEq(dollar.balanceOf(stranger), 0);

        address payer = address(0xCA11);
        tac.mint(payer, COLL);
        TacitEvmPoolRouter.Tx memory t = _tx(int256(DEBT), address(0), 0, 41, 0);
        vm.startPrank(payer);
        tac.approve(address(zap), COLL);
        vm.expectRevert(TacVault.BadSignature.selector);
        zap.mintShielded(owner, COLL, 0, COLL, dl, sig, intent, t);
        vm.stopPrank();
        assertEq(tac.balanceOf(payer), COLL, "the payer's TAC never moved");

        vm.prank(stranger);
        dollarRouter.completeDeposit(intent, t);
        assertEq(dollar.balanceOf(address(dollarPool)), DEBT);
        assertEq(dollar.balanceOf(box), 0);
        assertEq(dollar.balanceOf(stranger), 0);
    }

    /// If nobody completes the box, the SYNTH is not lost: after the deadline anyone can send it to the refund address
    /// in the intent the owner signed, and to no other.
    function test_anUnfinishedBoxRefundsToTheSignedAddressAfterTheDeadline() public {
        _giveOwnerCollateral(COLL);
        TacitEvmPoolRouter.DepositIntent memory intent = _intent(DEBT, 42);
        address box = dollarRouter.depositBoxOf(intent);
        bytes memory sig = _signBorrow(DEBT, box, COLL);
        vm.prank(stranger);
        vault.borrowFor(owner, DEBT, 0, COLL, box, block.timestamp + 1 hours, sig);

        vm.prank(stranger);
        vm.expectRevert(TacitEvmPoolRouter.NotExpired.selector);
        dollarRouter.reclaimDeposit(intent, address(dollar));

        skip(1 days + 1);
        vm.prank(stranger);
        dollarRouter.reclaimDeposit(intent, address(dollar));
        assertEq(dollar.balanceOf(intent.refund), DEBT, "to the refund address in the intent");
        assertEq(dollar.balanceOf(stranger), 0);

        // an intent with another refund is another box with nothing in it
        TacitEvmPoolRouter.DepositIntent memory other = intent;
        other.refund = stranger;
        vm.prank(stranger);
        vm.expectRevert(TacitEvmPoolRouter.NothingToReclaim.selector);
        dollarRouter.reclaimDeposit(other, address(dollar));
    }

    // ───────────── the zap's balance sheet ─────────────

    /// The zap keeps nothing and leaves no allowance, whatever is sent through it, and TAC given to the zap is not
    /// spent by anyone's `mint`.
    function testFuzz_theZapKeepsNothing(uint256 tacIn, uint256 donated, address to) public {
        tacIn = bound(tacIn, 0, COLL);
        donated = bound(donated, 0, 1_000e18);
        vm.assume(to != address(0) && to != address(zap) && to != address(vault) && to.code.length == 0);
        address payer = address(0xCA11);
        tac.mint(payer, COLL + donated);
        if (tacIn < COLL) _giveOwnerCollateral(COLL - tacIn);
        vm.startPrank(payer);
        tac.transfer(address(zap), donated);
        tac.approve(address(zap), tacIn);
        bytes memory sig = _signBorrow(DEBT, to, COLL);
        zap.mint(owner, tacIn, DEBT, 0, COLL, to, block.timestamp + 1 hours, sig);
        vm.stopPrank();
        assertEq(tac.balanceOf(address(zap)), donated, "mint never spends the zap's own TAC");
        assertEq(dollar.balanceOf(address(zap)), 0);
        assertEq(tac.allowance(address(zap), address(vault)), 0);
        assertGe(dollar.balanceOf(to), DEBT);
        (uint256 coll,,) = vault.vaults(owner);
        assertEq(coll, COLL);
    }

    /// The signature names the collateral the vault must hold: the zap cannot borrow with TAC that is not there.
    function test_aSignatureNeedsTheCollateralItNames() public {
        address payer = address(0xCA11);
        tac.mint(payer, COLL);
        bytes memory sig = _signBorrow(DEBT, payer, COLL);
        vm.startPrank(payer);
        tac.approve(address(zap), COLL);
        vm.expectRevert(TacVault.TooLittleCollateral.selector);
        zap.mint(owner, COLL / 2, DEBT, 0, COLL, payer, block.timestamp + 1 hours, sig);
        vm.stopPrank();
        assertEq(tac.balanceOf(payer), COLL);
        (uint256 coll,,) = vault.vaults(owner);
        assertEq(coll, 0);
    }
}
