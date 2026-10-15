// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IEvmPool, IEvmPoolRouter, IZapRouter} from "./EvmPoolFace.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacSynth} from "../src/TacSynth.sol";
import {MockOracle, MockFeed, VaultConfig} from "./TacVaultMocks.sol";
import {AcceptAllVerifier} from "./TacVaultShielded.t.sol";

interface IV1 {
    function registerWrappedAuto(address underlying, bytes32 crossChainLink) external returns (bytes32);
    function assets(bytes32 assetId) external view returns (bool, address, uint256, bytes32, bool, uint8);
}

interface IErc20Supply {
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

/// Moving between the live confidential pool (V1) and the TAC and synth TacitEvmPools, using only the router's
/// existing wrap boxes, call escrows and deposit boxes. Runs on a mainnet fork against the real V1 pool and TAC:
///   FORK_URL=https://eth.drpc.org FORK_BLOCK=26183554 forge test --match-path test/TacVaultV1Bridge.t.sol -vv -j 1
contract TacVaultV1BridgeTest is Test {
    uint256 constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    address constant V1 = 0x000000000Ed1eabD231Be41d93b719056F7febFC;
    address constant TAC = 0xA1313eb9f3A445606D9583bcAc3ebeB56a858279;
    bytes32 constant TAC_ASSET = 0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b;
    uint256 constant COLL = 15_000e18;
    uint256 constant DEBT = 2_000e18;

    IEvmPool tacPool;
    IEvmPoolRouter tacRouter;
    IEvmPool usdPool;
    IEvmPoolRouter usdRouter;
    TacVault vault;
    TacSynth usd;
    address alice = makeAddr("alice");
    uint256 ownerKey = 0x7AC5EC12E7B0A7D;
    address owner;
    uint256 nfSeq = 1;

    function _fork() internal {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) vm.skip(true, "needs FORK_URL");
        uint256 blockNumber = vm.envOr("FORK_BLOCK", uint256(0));
        if (blockNumber == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, blockNumber);
        owner = vm.addr(ownerKey);
        address verifier = address(new AcceptAllVerifier());
        tacPool = IEvmPool(deployCode("TacitEvmPool.sol:TacitEvmPool", abi.encode(verifier, TAC)));
        tacRouter = IEvmPoolRouter(
            deployCode(
                "TacitEvmPoolRouter.sol:TacitEvmPoolRouter",
                abi.encode(address(tacPool), address(0), address(0), V1, address(0))
            )
        );

        MockOracle oracle = new MockOracle();
        oracle.set(1e14); // 0.40 USD per TAC at 4000 USD per ETH
        MockFeed feed = new MockFeed();
        feed.set(4000e8);
        vault = new TacVault(VaultConfig.defaults(TAC, address(oracle), address(feed), address(0x0123)));
        usd = vault.SYNTH();
        usdPool = IEvmPool(deployCode("TacitEvmPool.sol:TacitEvmPool", abi.encode(verifier, address(usd))));
        usdRouter = IEvmPoolRouter(
            deployCode(
                "TacitEvmPoolRouter.sol:TacitEvmPoolRouter",
                abi.encode(address(usdPool), address(0), address(0), V1, address(0))
            )
        );

        deal(TAC, alice, 100_000e18);
        vm.startPrank(alice);
        IErc20Supply(TAC).approve(address(tacPool), type(uint256).max);
        _transact(tacPool, _tx(tacPool, address(0), int256(100_000e18), address(0), 0, 11));
        vm.stopPrank();
    }

    function _tx(IEvmPool pool, address recipient, int256 extAmount, address rel, uint256 fee, uint256 out0)
        internal
        returns (IZapRouter.Tx memory t)
    {
        (bytes32 root, uint256 size) = pool.head();
        t.recipient = recipient;
        t.extAmount = extAmount;
        t.relayer = rel;
        t.fee = fee;
        t.publicInputs[0] = uint256(root);
        t.publicInputs[1] = uint256(root);
        t.publicInputs[2] = uint256(keccak256(abi.encode(root, out0, nfSeq))) % FIELD;
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
    }

    function _transact(IEvmPool pool, IZapRouter.Tx memory t) internal {
        pool.transact(t.pA, t.pB, t.pC, t.publicInputs, t.recipient, t.extAmount, t.relayer, t.fee, t.memo0, t.memo1);
    }

    function _wrapIntent(bytes32 assetId, uint256 amount) internal view returns (IEvmPoolRouter.WrapIntent memory) {
        return IEvmPoolRouter.WrapIntent({
            assetId: assetId,
            amount: amount,
            tip: 0,
            tipTo: address(0),
            commit: keccak256("v1-note"),
            refund: alice,
            deadline: uint64(block.timestamp + 1 days),
            nonce: 1
        });
    }

    /// Shielded TAC in the TAC pool moves into a V1 note commitment in one transaction (V1 burns the pool-minted
    /// TAC into a pending deposit its settle turns into the note, or into a wrap-and-swap / wrap-and-LP).
    function test_shieldedTacIntoV1InOneTransaction() public {
        _fork();
        uint256 supplyBefore = IErc20Supply(TAC).totalSupply();
        IEvmPoolRouter.WrapIntent memory intent = _wrapIntent(TAC_ASSET, 1_000e18);
        IZapRouter.Tx memory t = _tx(tacPool, tacRouter.wrapBoxOf(intent), -int256(1_000e18), address(0), 0, 0);
        tacRouter.withdrawToV1(t, intent);
        assertEq(supplyBefore - IErc20Supply(TAC).totalSupply(), 1_000e18, "V1 took the TAC into a pending deposit");
        assertEq(IErc20Supply(TAC).balanceOf(tacRouter.wrapBoxOf(intent)), 0);
    }

    /// A V1 exit of TAC paid to a TAC-router call escrow: anyone runs the escrow, which opens a vault for a key that
    /// only signs and borrows dollars into the dollar pool's deposit box, completed into a shielded note.
    function test_v1TacExitOpensAVaultAndMintsShieldedDollars() public {
        _fork();
        IZapRouter.DepositIntent memory box = IZapRouter.DepositIntent({
            amount: DEBT,
            outLeaf0: 21,
            outLeaf1: 0,
            memo0Hash: keccak256(""),
            memo1Hash: keccak256(""),
            refund: alice,
            deadline: uint64(block.timestamp + 1 days),
            nonce: 21
        });
        address usdBox = usdRouter.depositBoxOf(box);
        uint256 dl = block.timestamp + 1 hours;
        bytes32 sh = keccak256(abi.encode(vault.BORROW(), owner, DEBT, uint256(0), COLL, usdBox, uint256(0), dl));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, vault.digest(sh));

        IEvmPoolRouter.Call[] memory calls = new IEvmPoolRouter.Call[](2);
        calls[0] = IEvmPoolRouter.Call({
            target: address(vault),
            value: 0,
            token: TAC,
            amount: COLL,
            push: false,
            data: abi.encodeCall(TacVault.depositFor, (owner, COLL))
        });
        calls[1] = IEvmPoolRouter.Call({
            target: address(vault),
            value: 0,
            token: address(0),
            amount: 0,
            push: false,
            data: abi.encodeCall(
                TacVault.borrowFor, (owner, DEBT, uint256(0), COLL, usdBox, dl, abi.encodePacked(r, s, v))
            )
        });
        IEvmPoolRouter.CallIntent memory intent = IEvmPoolRouter.CallIntent({
            calls: calls,
            outTokens: new address[](0),
            minOuts: new uint256[](0),
            to: address(0),
            refund: alice,
            deadline: uint64(block.timestamp + 1 hours),
            nonce: 7
        });

        // V1 pays a withdrawal to any address its proof names: here, the escrow.
        deal(TAC, address(this), COLL);
        IErc20Supply(TAC).transfer(tacRouter.callEscrowOf(intent), COLL);
        tacRouter.executeCall(intent);

        (uint256 coll, uint256 debt,) = vault.vaults(owner);
        assertEq(coll, COLL);
        assertEq(debt, DEBT);
        usdRouter.completeDeposit(box, _tx(usdPool, address(0), int256(DEBT), address(0), 0, 21));
        assertEq(usd.balanceOf(address(usdPool)), DEBT, "the dollars are a shielded note");
    }

    /// Dollars from the dollar pool move into V1, where they pair with TAC in its AMM, once the dollar is
    /// registered there.
    function test_shieldedDollarsIntoV1() public {
        _fork();
        bytes32 usdAsset = IV1(V1).registerWrappedAuto(address(usd), bytes32(0));
        (bool registered,,,,,) = IV1(V1).assets(usdAsset);
        assertTrue(registered);
        // Mint some dollars into the dollar pool.
        vm.startPrank(alice);
        IErc20Supply(TAC).approve(address(vault), type(uint256).max);
        deal(TAC, alice, COLL);
        vault.deposit(COLL);
        vault.borrow(DEBT, 0);
        usd.approve(address(usdPool), DEBT);
        _transact(usdPool, _tx(usdPool, address(0), int256(DEBT), address(0), 0, 31));
        vm.stopPrank();

        IEvmPoolRouter.WrapIntent memory intent = _wrapIntent(usdAsset, 500e18);
        usdRouter.withdrawToV1(_tx(usdPool, usdRouter.wrapBoxOf(intent), -int256(500e18), address(0), 0, 0), intent);
        assertEq(usd.balanceOf(V1), 500e18, "V1 escrows the dollars for the note");
    }
}
