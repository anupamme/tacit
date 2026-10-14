// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TacBlockOracle} from "../src/TacBlockOracle.sol";
import {TacAmmOracle} from "../src/TacAmmOracle.sol";
import {TacPairOracle} from "../src/TacPairOracle.sol";

interface IVenuesPrecision {
    function quoteExactIn(address sender, address tokenIn, uint256 amountIn)
        external
        view
        returns (uint256 amountOut, bool fits);
    function swapExactIn(address tokenIn, uint256 amountIn, uint256 minOut, address to)
        external
        payable
        returns (uint256 amountOut);
    function sqrtPriceCurrent() external view returns (uint256);
    function sqrtPHigh() external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function reserve0() external view returns (uint128);
    function fee() external view returns (uint256);
    function hook() external view returns (address);
    function feeRecipient() external view returns (address);
}

interface IVenuesAmm {
    function quoteSwap(bytes32 assetIn, bytes32 assetOut, uint32 feeBps, uint256 amountIn)
        external
        view
        returns (uint256);
    function swapPublic(
        bytes32 assetIn,
        bytes32 assetOut,
        uint32 feeBps,
        uint256 amountIn,
        uint256 minAmountOut,
        uint64 deadline,
        address to
    ) external payable returns (uint256 amountOut);
}

interface IVenuesPool {
    function pools(bytes32 poolId)
        external
        view
        returns (bool, bytes32, bytes32, uint256 reserveA, uint256 reserveB, uint32 feeBps, uint256 totalShares);
    function successor() external view returns (address);
}

interface IVenuesErc20 {
    function approve(address, uint256) external returns (bool);
}

/// The two TAC/ETH venues' oracles against the real pools on a mainnet fork at block 26,183,554. Every test here needs
/// the fork and is skipped without FORK_URL:
///   FORK_URL=https://eth.drpc.org FORK_BLOCK=26183554 forge test --match-path test/TacVenuesFork.t.sol -j 1
contract TacVenuesForkTest is Test {
    address constant V1 = 0x000000000Ed1eabD231Be41d93b719056F7febFC;
    address constant AMM = 0x00000000E36C7EC997CC59DCda9E03673B448119;
    address constant PRECISION = 0x0155358241411dB868BA714aE7c83A27087e3D6E;
    address constant TAC = 0xA1313eb9f3A445606D9583bcAc3ebeB56a858279;
    bytes32 constant ETH_ASSET = 0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34;
    bytes32 constant TAC_ASSET = 0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b;
    bytes32 constant POOL_ID = 0x248497bf6f943cd2b39a04bf5841056c58dfd7ef196188cb4f0ac1fd11dc7c00;
    uint256 constant MAPPING_SLOT = 74;
    uint256 constant FORK_BLOCK = 26183554;

    TacBlockOracle prec;
    TacAmmOracle amm;
    TacPairOracle pair;

    struct Fixture {
        bytes header;
        bytes next;
        bytes[] account;
        bytes[] a;
        bytes[] b;
    }

    function _fork() internal {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) vm.skip(true);
        vm.createSelectFork(url, FORK_BLOCK);
        prec = new TacBlockOracle(PRECISION, TAC, 50, 7_200, 10_800, 21_600, 6_600);
        amm = new TacAmmOracle(V1, POOL_ID, ETH_ASSET, TAC_ASSET, TAC, MAPPING_SLOT, 50, 7_200, 10_800, 21_600, 6_600);
        pair = new TacPairOracle(address(prec), address(amm));
    }

    function _record(address oracle, string memory dir, uint256 interval) internal {
        string memory json = vm.readFile(string.concat("test/fixtures/", dir, "/", vm.toString(interval), ".json"));
        Fixture memory f;
        f.header = vm.parseJsonBytes(json, ".header");
        f.next = vm.parseJsonBytes(json, ".next");
        f.account = vm.parseJsonBytesArray(json, ".accountProof");
        if (vm.keyExistsJson(json, ".proofA")) {
            f.a = vm.parseJsonBytesArray(json, ".proofA");
            f.b = vm.parseJsonBytesArray(json, ".proofB");
        } else {
            f.a = vm.parseJsonBytesArray(json, ".reservesProof");
            f.b = vm.parseJsonBytesArray(json, ".supplyProof");
        }
        TacBlockOracle(oracle).record(f.header, f.next, f.account, f.a, f.b);
    }

    // ───────────── each venue's price and depth are the pool's own ─────────────

    /// The Precision venue's `spot()` is the pool's `sqrtPriceCurrent()` squared and the marginal price of its quote in
    /// both directions after the 0.30% fee; a recorded sample has the same price and the ETH side (real plus virtual)
    /// as its depth.
    function test_precisionSpotIsThePoolsMarginalPrice() public {
        _fork();
        IVenuesPrecision p = IVenuesPrecision(PRECISION);
        assertEq(p.hook(), address(0), "no hook: nothing is owed outside the reserves");
        assertEq(p.feeRecipient(), address(0), "no creator fee");
        uint256 spot = prec.spot();
        uint256 s = p.sqrtPriceCurrent(); // sqrt(TAC per ETH) * 1e18, so ETH per TAC (wad) = 1e54 / s^2
        assertApproxEqRel(spot, uint256(1e54) / (s * s), 1e-9 * 1e18);

        uint256 fee = p.fee();
        (uint256 outTac, bool fits) = p.quoteExactIn(address(this), address(0), 1e12);
        assertTrue(fits);
        assertApproxEqRel(outTac, uint256(1e12) * 1e18 / spot * (1_000_000 - fee) / 1_000_000, 5e-5 * 1e18);
        (uint256 outEth, bool fits2) = p.quoteExactIn(address(this), TAC, 1e16);
        assertTrue(fits2);
        assertApproxEqRel(outEth, uint256(1e16) * spot / 1e18 * (1_000_000 - fee) / 1_000_000, 5e-5 * 1e18);

        uint256 depth = p.totalSupply() * 1e18 / p.sqrtPHigh() + p.reserve0();
        TacBlockOracle p25 = new TacBlockOracle(PRECISION, TAC, 25, 30 minutes, 1 hours, 1 hours, 6_600);
        _record(address(p25), "tac-block-oracle", 1047341);
        (uint256 samplePrice, uint256 sampleDepth) = p25.sampleOf(1047341);
        assertEq(samplePrice, spot, "recorded price = spot (the pool is unchanged since the sample block)");
        assertEq(sampleDepth, depth, "recorded depth = real + virtual ETH");
    }

    /// The AMM venue's `spot()` is the pool's reserve ratio and the marginal price of the periphery's quote in both
    /// directions after the 0.30% fee; a recorded sample has the ETH reserve in wei as its depth.
    function test_ammSpotIsThePoolsMarginalPrice() public {
        _fork();
        uint256 spot = amm.spot();
        IVenuesAmm a = IVenuesAmm(AMM);
        uint256 outTac = a.quoteSwap(ETH_ASSET, TAC_ASSET, 30, 1e14); // a multiple of the 1e10 unit scale
        assertApproxEqRel(outTac, uint256(1e14) * 1e18 / spot * 9970 / 10_000, 2e-4 * 1e18);
        uint256 outEth = a.quoteSwap(TAC_ASSET, ETH_ASSET, 30, 1e18);
        assertApproxEqRel(outEth, uint256(1e18) * spot / 1e18 * 9970 / 10_000, 2e-4 * 1e18);
        (,,, uint256 rA, uint256 rB,,) = IVenuesPool(V1).pools(POOL_ID);
        assertEq(spot, rA * 1e10 * 1e18 / (rB * 1e10));
        TacAmmOracle a25 = new TacAmmOracle(
            V1, POOL_ID, ETH_ASSET, TAC_ASSET, TAC, MAPPING_SLOT, 25, 30 minutes, 1 hours, 1 hours, 6_600
        );
        _record(address(a25), "tac-amm-oracle", 1047341);
        (uint256 samplePrice, uint256 sampleDepth) = a25.sampleOf(1047341);
        assertEq(samplePrice, spot);
        assertEq(sampleDepth, rA * 1e10, "depth is the ETH reserve in wei");
    }

    /// The slots the AMM venue proves are the `pools` entry's reserveA and reserveB; `successor` is slot 175.
    function test_ammSlotsAreThePoolEntrysReserves() public {
        _fork();
        (bytes32 a, bytes32 b) = amm.slots();
        (,,, uint256 rA, uint256 rB,, uint256 shares) = IVenuesPool(V1).pools(POOL_ID);
        assertEq(uint256(vm.load(V1, a)), rA);
        assertEq(uint256(vm.load(V1, b)), rB);
        uint256 base = uint256(keccak256(abi.encode(POOL_ID, MAPPING_SLOT)));
        assertEq(uint256(vm.load(V1, bytes32(base + 6))), shares, "+6 is totalShares");
        assertEq(IVenuesPool(V1).successor(), address(0));
        assertEq(uint256(vm.load(V1, bytes32(uint256(175)))), 0, "successor is slot 175");
    }

    // ───────────── a retired pool ─────────────

    /// Once the confidential pool has a successor it refuses public swaps, so the AMM venue keeps reading its last
    /// price while the Precision venue follows the market; the pair's `spot` is the lower of the two.
    function test_aRetiredAmmPoolKeepsItsLastPrice() public {
        _fork();
        uint256 last = amm.spot();
        vm.store(V1, bytes32(uint256(175)), bytes32(uint256(uint160(address(0xBEEF)))));
        assertEq(IVenuesPool(V1).successor(), address(0xBEEF));
        address trader = makeAddr("trader");
        vm.deal(trader, 100 ether);
        vm.prank(trader);
        (bool ok, bytes memory ret) =
            AMM.call{value: 1e15}(abi.encodeCall(IVenuesAmm.swapPublic, (ETH_ASSET, TAC_ASSET, 30, 1e15, 0, 0, trader)));
        assertFalse(ok, "the swap is refused");
        assertEq(bytes4(ret), bytes4(keccak256("PoolRetired()")));
        assertEq(amm.spot(), last);

        deal(TAC, trader, 20_000e18);
        vm.startPrank(trader);
        IVenuesErc20(TAC).approve(PRECISION, type(uint256).max);
        IVenuesPrecision(PRECISION).swapExactIn(TAC, 20_000e18, 0, trader);
        vm.stopPrank();
        uint256 live = prec.spot();
        assertLt(live, last * 70 / 100, "the Precision venue fell by more than 30%");
        assertEq(amm.spot(), last);
        assertEq(pair.spot(), live);
    }

    // ───────────── gas of `record` ─────────────

    /// One `record` with real proofs costs under 1.2M gas on either venue.
    function test_gasOfRecord() public {
        _fork();
        TacBlockOracle p25 = new TacBlockOracle(PRECISION, TAC, 25, 30 minutes, 1 hours, 1 hours, 6_600);
        TacAmmOracle a25 = new TacAmmOracle(
            V1, POOL_ID, ETH_ASSET, TAC_ASSET, TAC, MAPPING_SLOT, 25, 30 minutes, 1 hours, 1 hours, 6_600
        );
        uint256 g = gasleft();
        _record(address(p25), "tac-block-oracle", 1047340);
        assertLt(g - gasleft(), 1_200_000);
        g = gasleft();
        _record(address(a25), "tac-amm-oracle", 1047340);
        assertLt(g - gasleft(), 1_200_000);
    }
}
