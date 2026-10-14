// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacitEvmPool} from "../src/TacitEvmPool.sol";
import {TacitEvmPoolRouter} from "../src/TacitEvmPoolRouter.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacSynth} from "../src/TacSynth.sol";
import {TacVaultZap} from "../src/TacVaultZap.sol";
import {TestTac, MockOracle, MockFeed, VaultConfig} from "./TacVaultMocks.sol";

/// Accepts every proof: the circuit is the ceremony's and unchanged; this exercises the contracts around it.
contract AcceptAllVerifier {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[11] calldata)
        external
        pure
        returns (bool)
    {
        return true;
    }
}

/// The vault driven from shielded pools and from public TAC in one transaction: TacitEvmPool and its router are
/// the deployed contracts, unchanged; only the Groth16 verifier is replaced.
contract TacVaultShieldedTest is Test {
    uint256 constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 constant COLL = 15_000e18;
    uint256 constant DEBT = 2_000e18;

    TestTac tac;
    TacVault vault;
    TacSynth dollar;
    TacitEvmPool tacPool;
    TacitEvmPoolRouter tacRouter;
    TacitEvmPool dollarPool;
    TacitEvmPoolRouter dollarRouter;
    TacVaultZap zap;
    uint256 ownerKey = 0xA11CE;
    address owner;
    address alice = address(0xA1);
    address relayer = address(0x7E1A);
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

        address verifier = address(new AcceptAllVerifier());
        tacPool = new TacitEvmPool(verifier, address(tac));
        tacRouter = new TacitEvmPoolRouter(address(tacPool), address(0), address(0), address(0), address(0));
        dollarPool = new TacitEvmPool(verifier, address(dollar));
        dollarRouter = new TacitEvmPoolRouter(address(dollarPool), address(0), address(0), address(0), address(0));
        zap = new TacVaultZap(address(vault), address(dollarRouter));

        // Alice shields 100,000 public TAC.
        tac.mint(alice, 100_000e18);
        vm.startPrank(alice);
        tac.approve(address(tacPool), type(uint256).max);
        _transact(tacPool, _tx(tacPool, address(0), int256(100_000e18), address(0), 0, 11, 0));
        vm.stopPrank();
    }

    // ───────────── building transactions (the proof itself is accepted) ─────────────

    function _tx(
        TacitEvmPool pool,
        address recipient,
        int256 extAmount,
        address rel,
        uint256 fee,
        uint256 out0,
        uint256 out1
    ) internal returns (TacitEvmPoolRouter.Tx memory t) {
        (bytes32 root, uint256 size) = pool.head();
        t.recipient = recipient;
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
                abi.encode(block.chainid, address(pool), recipient, extAmount, rel, fee, keccak256(""), keccak256(""))
            )
        ) % FIELD;
        t.publicInputs[6] = pool.ASSET_FIELD();
        t.publicInputs[7] = extAmount < 0 ? nfSeq++ : 0;
        t.publicInputs[9] = out0;
        t.publicInputs[10] = out1;
    }

    function _transact(TacitEvmPool pool, TacitEvmPoolRouter.Tx memory t) internal {
        pool.transact(t.pA, t.pB, t.pC, t.publicInputs, t.recipient, t.extAmount, t.relayer, t.fee, t.memo0, t.memo1);
    }

    function _signBorrow(uint256 amount, address to) internal view returns (bytes memory) {
        bytes32 sh = keccak256(
            abi.encode(
                vault.BORROW(), owner, amount, uint256(0), COLL, to, vault.nonces(owner), block.timestamp + 1 hours
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, vault.digest(sh));
        return abi.encodePacked(r, s, v);
    }

    function _signWithdraw(uint256 amount, address to) internal view returns (bytes memory) {
        bytes32 sh =
            keccak256(abi.encode(vault.WITHDRAW(), owner, amount, to, vault.nonces(owner), block.timestamp + 1 hours));
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

    function _call(address token, uint256 amount, bytes memory data)
        internal
        view
        returns (TacitEvmPoolRouter.Call memory)
    {
        return TacitEvmPoolRouter.Call({
            target: address(vault), value: 0, token: token, amount: amount, push: false, data: data
        });
    }

    function _callIntent(TacitEvmPoolRouter.Call[] memory calls, uint256 nonce)
        internal
        view
        returns (TacitEvmPoolRouter.CallIntent memory)
    {
        return TacitEvmPoolRouter.CallIntent({
            calls: calls,
            outTokens: new address[](0),
            minOuts: new uint256[](0),
            to: address(0),
            refund: alice,
            deadline: uint64(block.timestamp + 1 hours),
            nonce: nonce
        });
    }

    // ───────────── shielded TAC in, shielded dollars out ─────────────

    function _open() internal {
        TacitEvmPoolRouter.DepositIntent memory box = _intent(DEBT, 21);
        address dollarBox = dollarRouter.depositBoxOf(box);
        TacitEvmPoolRouter.Call[] memory calls = new TacitEvmPoolRouter.Call[](2);
        calls[0] = _call(address(tac), COLL, abi.encodeCall(TacVault.depositFor, (owner, COLL)));
        calls[1] = _call(
            address(0),
            0,
            abi.encodeCall(
                TacVault.borrowFor,
                (owner, DEBT, uint256(0), COLL, dollarBox, block.timestamp + 1 hours, _signBorrow(DEBT, dollarBox))
            )
        );
        TacitEvmPoolRouter.CallIntent memory intent = _callIntent(calls, 1);
        TacitEvmPoolRouter.Tx memory t =
            _tx(tacPool, tacRouter.callEscrowOf(intent), -int256(COLL), relayer, 10e18, 12, 0);
        vm.prank(relayer);
        tacRouter.withdrawAndCall(t, intent);
        assertEq(dollar.balanceOf(dollarBox), DEBT, "dollars waiting in the deposit box");
        dollarRouter.completeDeposit(box, _tx(dollarPool, address(0), int256(DEBT), address(0), 0, 21, 0));
    }

    function test_openFromShieldedTacAndMintIntoShieldedDollars() public {
        _open();
        (uint256 coll, uint256 debt,) = vault.vaults(owner);
        assertEq(coll, COLL);
        assertEq(debt, DEBT);
        assertEq(dollar.balanceOf(address(dollarPool)), DEBT, "the dollars are shielded");
        assertEq(tac.balanceOf(relayer), 10e18, "the relayer was paid from the pool");
        assertEq(owner.balance, 0, "the owner never held gas");
    }

    /// Shielded TAC to a shielded dollar note in ONE transaction: the escrow's last call completes the dollar
    /// pool's deposit box that the borrow has just filled.
    function test_shieldedTacToShieldedDollarsInOneTransaction() public {
        TacitEvmPoolRouter.DepositIntent memory box = _intent(DEBT, 21);
        address dollarBox = dollarRouter.depositBoxOf(box);
        TacitEvmPoolRouter.Tx memory deposit = _tx(dollarPool, address(0), int256(DEBT), address(0), 0, 21, 0);
        TacitEvmPoolRouter.Call[] memory calls = new TacitEvmPoolRouter.Call[](3);
        calls[0] = _call(address(tac), COLL, abi.encodeCall(TacVault.depositFor, (owner, COLL)));
        calls[1] = _call(
            address(0),
            0,
            abi.encodeCall(
                TacVault.borrowFor,
                (owner, DEBT, uint256(0), COLL, dollarBox, block.timestamp + 1 hours, _signBorrow(DEBT, dollarBox))
            )
        );
        calls[2] = TacitEvmPoolRouter.Call({
            target: address(dollarRouter),
            value: 0,
            token: address(0),
            amount: 0,
            push: false,
            data: abi.encodeCall(TacitEvmPoolRouter.completeDeposit, (box, deposit))
        });
        TacitEvmPoolRouter.CallIntent memory intent = _callIntent(calls, 1);
        TacitEvmPoolRouter.Tx memory t =
            _tx(tacPool, tacRouter.callEscrowOf(intent), -int256(COLL), relayer, 10e18, 12, 0);
        vm.prank(relayer);
        tacRouter.withdrawAndCall(t, intent);
        assertEq(dollar.balanceOf(dollarBox), 0, "the box is emptied");
        assertEq(dollar.balanceOf(address(dollarPool)), DEBT, "the dollars are a shielded note");
        (uint256 coll, uint256 debt,) = vault.vaults(owner);
        assertEq(coll, COLL);
        assertEq(debt, DEBT);
    }

    function test_closeFromShieldedDollarsBackIntoShieldedTac() public {
        _open();
        TacitEvmPoolRouter.DepositIntent memory tacBox = _intent(COLL, 31);
        address tacBoxAddr = tacRouter.depositBoxOf(tacBox);
        TacitEvmPoolRouter.Call[] memory calls = new TacitEvmPoolRouter.Call[](2);
        calls[0] = _call(address(dollar), DEBT, abi.encodeCall(TacVault.repay, (owner, DEBT)));
        calls[1] = _call(
            address(0),
            0,
            abi.encodeCall(
                TacVault.withdrawFor,
                (owner, COLL, tacBoxAddr, block.timestamp + 1 hours, _signWithdraw(COLL, tacBoxAddr))
            )
        );
        TacitEvmPoolRouter.CallIntent memory intent = _callIntent(calls, 2);
        dollarRouter.withdrawAndCall(
            _tx(dollarPool, dollarRouter.callEscrowOf(intent), -int256(DEBT), address(0), 0, 22, 0), intent
        );
        (uint256 coll, uint256 debt,) = vault.vaults(owner);
        assertEq(coll + debt, 0);
        assertEq(dollar.totalSupply(), 0, "every dollar repaid");
        tacRouter.completeDeposit(tacBox, _tx(tacPool, address(0), int256(COLL), address(0), 0, 31, 0));
        assertEq(tac.balanceOf(address(tacPool)), 100_000e18 - 10e18, "the TAC is shielded again");
    }

    // ───────────── permits and batching ─────────────

    function _permit(uint256 key, address spender, uint256 value)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s, uint256 dl)
    {
        dl = block.timestamp + 1 hours;
        address holder = vm.addr(key);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                holder,
                spender,
                value,
                tac.nonces(holder),
                dl
            )
        );
        (v, r, s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", tac.DOMAIN_SEPARATOR(), structHash)));
    }

    /// One transaction from TAC never approved: permit, then mint into a shielded note, through the zap's multicall.
    function test_permitAndShieldedMintInOneZapTransaction() public {
        uint256 payerKey = 0xCAFE;
        address payer = vm.addr(payerKey);
        tac.mint(payer, COLL);
        (uint8 v, bytes32 r, bytes32 s_, uint256 dl) = _permit(payerKey, address(zap), COLL);
        TacitEvmPoolRouter.DepositIntent memory intent = _intent(DEBT, 51);
        bytes memory sig = _signBorrow(DEBT, dollarRouter.depositBoxOf(intent));
        TacitEvmPoolRouter.Tx memory t = _tx(dollarPool, address(0), int256(DEBT), address(0), 0, 51, 0);
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(TacVaultZap.permitTac, (COLL, dl, v, r, s_));
        calls[1] =
            abi.encodeCall(TacVaultZap.mintShielded, (owner, COLL, 0, COLL, block.timestamp + 1 hours, sig, intent, t));
        vm.prank(payer);
        zap.multicall(calls);
        (uint256 coll, uint256 debt,) = vault.vaults(owner);
        assertEq(coll, COLL);
        assertEq(debt, DEBT);
        assertEq(dollar.balanceOf(address(dollarPool)), DEBT);
    }

    /// The vault directly: permit, deposit and borrow for oneself in one multicall; a permit already used is ignored.
    function test_permitDepositAndBorrowInOneVaultTransaction() public {
        uint256 key = 0xD00D;
        address user = vm.addr(key);
        tac.mint(user, COLL);
        (uint8 v, bytes32 r, bytes32 s_, uint256 dl) = _permit(key, address(vault), COLL);
        tac.permit(user, address(vault), COLL, dl, v, r, s_); // someone submitted it first
        bytes[] memory calls = new bytes[](3);
        calls[0] = abi.encodeCall(TacVault.permitTac, (COLL, dl, v, r, s_));
        calls[1] = abi.encodeCall(TacVault.deposit, (COLL));
        calls[2] = abi.encodeCall(TacVault.borrow, (DEBT, 0));
        vm.prank(user);
        vault.multicall(calls);
        assertEq(dollar.balanceOf(user), DEBT);
    }

    // ───────────── public TAC in one transaction ─────────────

    function test_publicTacToAShieldedDollarNoteInOneTransaction() public {
        address payer = address(0xCA11);
        tac.mint(payer, COLL);
        TacitEvmPoolRouter.DepositIntent memory intent = _intent(DEBT, 41);
        bytes memory sig = _signBorrow(DEBT, dollarRouter.depositBoxOf(intent));
        TacitEvmPoolRouter.Tx memory t = _tx(dollarPool, address(0), int256(DEBT), address(0), 0, 41, 0);
        vm.startPrank(payer);
        tac.approve(address(zap), COLL);
        zap.mintShielded(owner, COLL, 0, COLL, block.timestamp + 1 hours, sig, intent, t);
        vm.stopPrank();
        (uint256 coll, uint256 debt,) = vault.vaults(owner);
        assertEq(coll, COLL);
        assertEq(debt, DEBT);
        assertEq(dollar.balanceOf(address(dollarPool)), DEBT, "the dollars are a shielded note");
        assertEq(dollar.balanceOf(address(zap)) + tac.balanceOf(address(zap)), 0, "the zap keeps nothing");
    }

    function test_publicTacToDollarsAtAnAddressInOneTransaction() public {
        address payer = address(0xCA11);
        address recipient = address(0xD0D0);
        tac.mint(payer, COLL);
        bytes memory sig = _signBorrow(DEBT, recipient);
        vm.startPrank(payer);
        tac.approve(address(zap), COLL);
        zap.mint(owner, COLL, DEBT, 0, COLL, recipient, block.timestamp + 1 hours, sig);
        vm.stopPrank();
        assertEq(dollar.balanceOf(recipient), DEBT);
    }

    /// A signature only funds the deposit it names.
    function test_aCopiedSignatureCannotFundAnotherDeposit() public {
        // The vault already holds collateral, so a borrow needs no TAC from the caller.
        vm.prank(alice);
        tac.approve(address(vault), COLL);
        tac.mint(alice, COLL);
        vm.prank(alice);
        vault.depositFor(owner, COLL);

        TacitEvmPoolRouter.DepositIntent memory intent = _intent(DEBT, 41);
        bytes memory sig = _signBorrow(DEBT, dollarRouter.depositBoxOf(intent));

        // Another intent (another note, another refund) has a different box: the signature fails.
        TacitEvmPoolRouter.DepositIntent memory evil = _intent(DEBT, 666);
        evil.refund = address(0xBAD);
        TacitEvmPoolRouter.Tx memory evilTx =
            _tx(dollarPool, address(0), int256(DEBT), address(0xBAD), DEBT - 1, 666, 0);
        vm.prank(address(0xBAD));
        vm.expectRevert(TacVault.BadSignature.selector);
        zap.mintShielded(owner, 0, 0, COLL, block.timestamp + 1 hours, sig, evil, evilTx);

        // The owner's intent with a different proof (paying a relayer fee) does not match the intent.
        TacitEvmPoolRouter.Tx memory feeTx = _tx(dollarPool, address(0), int256(DEBT), address(0xBAD), DEBT - 1, 666, 0);
        vm.prank(address(0xBAD));
        vm.expectRevert(TacitEvmPoolRouter.BadIntent.selector);
        zap.mintShielded(owner, 0, 0, COLL, block.timestamp + 1 hours, sig, intent, feeTx);

        // Run as signed, by anyone, the dollars land only in the owner's note.
        TacitEvmPoolRouter.Tx memory t = _tx(dollarPool, address(0), int256(DEBT), address(0), 0, 41, 0);
        vm.prank(address(0xBAD));
        zap.mintShielded(owner, 0, 0, COLL, block.timestamp + 1 hours, sig, intent, t);
        assertEq(dollar.balanceOf(address(dollarPool)), DEBT);
        assertEq(dollar.balanceOf(address(0xBAD)), 0);
    }

    /// The zap is never the recipient, so nothing is left in it.
    function test_theZapCannotBeARecipient() public {
        bytes memory sig = _signBorrow(DEBT, address(zap));
        vm.expectRevert(TacVaultZap.BadRecipient.selector);
        zap.mint(owner, 0, DEBT, 0, COLL, address(zap), block.timestamp + 1 hours, sig);
    }
}
