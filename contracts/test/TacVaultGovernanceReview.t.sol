// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {stdError} from "forge-std/StdError.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {TacVault} from "../src/TacVault.sol";
import {TacSynth} from "../src/TacSynth.sol";
import {TestTac, MockOracle, MockFeed, VaultConfig} from "./TacVaultMocks.sol";
import {TacPairOracle} from "../src/TacPairOracle.sol";

/// An oracle with windows of its own (a copy of the one the governance tests use, so this file stands alone).
contract RevWindowed {
    uint256 public immutable SHORT_WINDOW;
    uint256 public immutable WINDOW;
    uint256 public immutable MAX_WINDOW;
    uint256 public price;
    uint256 public ethDepth = 1e30;

    constructor(uint256 s, uint256 w, uint256 m, uint256 p) {
        (SHORT_WINDOW, WINDOW, MAX_WINDOW, price) = (s, w, m, p);
    }

    function setPrice(uint256 p) external {
        price = p;
    }

    function prices(uint256) external view returns (uint256, uint256) {
        return (price, price);
    }

    function recovery(uint256) external view returns (uint256) {
        return price;
    }

    function depthMin(uint256) external view returns (uint256) {
        return ethDepth;
    }

    function latest() external view returns (uint256) {
        return price;
    }

    function spot() external view returns (uint256) {
        return price;
    }
}

/// An oracle that answers sanely while the vault is still sanity-checking it (the vault's ORACLE() is still the old
/// one) and `lie` once it is in place.
contract RevChameleon {
    TacVault immutable vault;
    uint256 immutable honest;
    uint256 immutable lie;
    uint256 public constant SHORT_WINDOW = 30 minutes;
    uint256 public constant WINDOW = 2 hours;
    uint256 public constant MAX_WINDOW = 8 hours;

    constructor(TacVault v, uint256 h, uint256 l) {
        (vault, honest, lie) = (v, h, l);
    }

    function _p() internal view returns (uint256) {
        return address(vault.ORACLE()) == address(this) ? lie : honest;
    }

    function prices(uint256) external view returns (uint256, uint256) {
        return (_p(), _p());
    }

    function recovery(uint256) external view returns (uint256) {
        return _p();
    }

    function depthMin(uint256) external pure returns (uint256) {
        return 1e30;
    }

    function latest() external view returns (uint256) {
        return _p();
    }

    function spot() external view returns (uint256) {
        return _p();
    }
}

/// An oracle with a bug the vault's checks do not look for: the SHORT_WINDOW price and every recovery price are zero.
contract RevHalfBroken {
    uint256 public constant SHORT_WINDOW = 30 minutes;
    uint256 public constant WINDOW = 2 hours;
    uint256 public constant MAX_WINDOW = 8 hours;
    uint256 public price;

    constructor(uint256 p) {
        price = p;
    }

    function setPrice(uint256 p) external {
        price = p;
    }

    function prices(uint256 w) external view returns (uint256, uint256) {
        if (w == SHORT_WINDOW) return (0, 0);
        return (price, price);
    }

    function recovery(uint256) external pure returns (uint256) {
        return 0;
    }

    function depthMin(uint256) external pure returns (uint256) {
        return 1e30;
    }

    function latest() external view returns (uint256) {
        return price;
    }

    function spot() external view returns (uint256) {
        return price;
    }
}

/// The synth as it was at HEAD (only the vault mints), for a gas comparison.
contract RevOldSynth is ERC20 {
    address public immutable MINTER;
    error NotMinter();

    constructor() {
        MINTER = msg.sender;
    }

    function name() public pure override returns (string memory) {
        return "o";
    }

    function symbol() public pure override returns (string memory) {
        return "o";
    }

    function _givePermit2InfiniteAllowance() internal pure override returns (bool) {
        return false;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != MINTER) revert NotMinter();
        _mint(to, amount);
    }

    function burnFrom(address from, uint256 amount) external {
        if (msg.sender != MINTER) revert NotMinter();
        _spendAllowance(from, msg.sender, amount);
        _burn(from, amount);
    }
}

/// Deploys and drives a synth the way the vault does.
contract RevGasMinter {
    RevOldSynth public oldS;
    TacSynth public newS;

    constructor() {
        oldS = new RevOldSynth();
        newS = new TacSynth("n", "n");
    }

    function gasOld() external returns (uint256 mintGas, uint256 burnGas) {
        oldS.mint(address(this), 2);
        uint256 g = gasleft();
        oldS.mint(address(this), 1);
        mintGas = g - gasleft();
        oldS.approve(address(this), 1);
        g = gasleft();
        oldS.burnFrom(address(this), 1);
        burnGas = g - gasleft();
    }

    function gasNew() external returns (uint256 mintGas, uint256 burnGas) {
        newS.mint(address(this), 2);
        uint256 g = gasleft();
        newS.mint(address(this), 1);
        mintGas = g - gasleft();
        newS.approve(address(this), 1);
        g = gasleft();
        newS.burnFrom(address(this), 1);
        burnGas = g - gasleft();
    }
}

contract RevBase is Test {
    uint256 constant P = 1e14;
    address constant OWNER = address(0x0123);

    TestTac tac;
    MockOracle oracle;
    MockFeed feed;
    TacVault vault;
    TacSynth dollar;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        tac = new TestTac();
        oracle = new MockOracle();
        oracle.set(P);
        feed = new MockFeed();
        feed.set(4000e8);
        TacVault.Config memory c = VaultConfig.defaults(address(tac), address(oracle), address(feed), OWNER);
        c.depthBps = 100;
        vault = new TacVault(c);
        dollar = vault.SYNTH();
        tac.mint(alice, 10_000_000e18);
        tac.mint(bob, 10_000_000e18);
        vm.startPrank(alice);
        tac.approve(address(vault), type(uint256).max);
        dollar.approve(address(vault), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(bob);
        tac.approve(address(vault), type(uint256).max);
        dollar.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    function _wait(uint256 t) internal {
        skip(t);
        feed.set(4000e8);
    }

    function _apply(TacVault.Param id, uint256 v) internal {
        vm.prank(OWNER);
        vault.queueParam(id, v);
        _wait(vault.PARAM_DELAY());
        vm.prank(OWNER);
        vault.executeParam(id);
    }

    function _open(address who, uint256 coll, uint256 debt) internal {
        vm.startPrank(who);
        vault.deposit(coll);
        vault.borrow(debt, 0);
        vm.stopPrank();
    }
}

contract RevGovernanceTest is RevBase {
    // ───────── replacing an oracle that is frozen, zero or being moved ─────────

    /// A venue frozen low pins the pair's spot (the lower of the venues') 10x under the market, so borrowers cannot
    /// withdraw. A healthy replacement is still accepted: its price is within three times the old oracle's high
    /// median, which follows the market.
    function test_aFrozenLowSpotDoesNotBlockReplacement() public {
        _open(alice, 15_000e18, 2_000e18); // 300% at the market price
        oracle.setPrices(P, P, P / 10); // the frozen venue's spot
        vm.prank(alice);
        vm.expectRevert(TacVault.Undercollateralized.selector);
        vault.withdraw(1);

        RevWindowed good = new RevWindowed(30 minutes, 2 hours, 8 hours, P); // the market
        vm.prank(OWNER);
        vault.queueOracle(address(good));
        _wait(vault.ORACLE_DELAY());
        vm.prank(OWNER);
        vault.executeOracle();
        assertEq(address(vault.ORACLE()), address(good));
        assertEq(vault.valueOf(15_000e18, true), 15_000e18 * P * 4000 / 1e18, "the borrow view reads the market again");
    }

    /// An old oracle whose spot rounds to zero (without reverting) can be replaced too, but not by a price far from
    /// what its medians still say.
    function test_aZeroSpotDoesNotBlockReplacement() public {
        oracle.setPrices(P, P, 0);
        RevWindowed good = new RevWindowed(30 minutes, 2 hours, 8 hours, P);
        vm.prank(OWNER);
        vault.queueOracle(address(good));
        _wait(vault.ORACLE_DELAY());
        good.setPrice(1);
        vm.prank(OWNER);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.executeOracle();
        good.setPrice(P);
        vm.prank(OWNER);
        vault.executeOracle();
        assertEq(address(vault.ORACLE()), address(good));
    }

    /// An old oracle that says nothing at all (reverts) leaves no anchor: any price that answers every view is taken.
    function test_aBrokenOldOracleLeavesNothingToCompareWith() public {
        oracle.setBroken(true);
        RevWindowed good = new RevWindowed(30 minutes, 2 hours, 8 hours, 1);
        vm.prank(OWNER);
        vault.queueOracle(address(good));
        _wait(vault.ORACLE_DELAY());
        vm.prank(OWNER);
        vault.executeOracle();
        assertEq(address(vault.ORACLE()), address(good));
    }

    /// Moving the old oracle's spot for the block the owner executes in does not stop the execution (its medians do
    /// not move in a block), and a new price far from every anchor still does.
    function test_aMovedSpotDoesNotStopTheExecution() public {
        RevWindowed next = new RevWindowed(30 minutes, 2 hours, 8 hours, P);
        vm.prank(OWNER);
        vault.queueOracle(address(next));
        _wait(vault.ORACLE_DELAY());
        oracle.setPrices(P, P, P / 4);
        vm.prank(OWNER);
        vault.executeOracle();
        assertEq(address(vault.ORACLE()), address(next));
    }

    function test_aNewPriceFarFromEveryAnchorIsRefused() public {
        RevWindowed next = new RevWindowed(30 minutes, 2 hours, 8 hours, P * 4);
        vm.prank(OWNER);
        vault.queueOracle(address(next));
        _wait(vault.ORACLE_DELAY());
        vm.prank(OWNER);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.executeOracle();
        next.setPrice(P * 3);
        vm.prank(OWNER);
        vault.executeOracle();
    }

    // ───────── what the oracle swap checks (accidents, not a deliberate oracle) ─────────

    /// An oracle that can tell it is being checked (vault.ORACLE() is still the old one) passes every check and then
    /// prices TAC 100x higher; a borrower takes the ceiling against collateral worth far less.
    function test_aChameleonOraclePassesTheChecksAndThenLies() public {
        _open(alice, 15_000e18, 2_000e18);
        RevChameleon c = new RevChameleon(vault, P, P * 100);
        vm.prank(OWNER);
        vault.queueOracle(address(c));
        _wait(vault.ORACLE_DELAY());
        vm.prank(OWNER);
        vault.executeOracle();
        assertEq(address(vault.ORACLE()), address(c));
        vm.prank(alice);
        vault.borrow(8_000e18, 0); // to the 10,000 ceiling on $6,000 of TAC
        (, uint256 debt,) = vault.vaults(alice);
        assertEq(debt, 10_000e18);
    }

    /// An oracle with a zero price on a view the vault reads (the short window's, or recovery) is refused when
    /// executed, as is one whose windows are out of order.
    function test_anOracleWithAZeroViewIsRefused() public {
        RevHalfBroken h = new RevHalfBroken(P);
        vm.prank(OWNER);
        vault.queueOracle(address(h));
        _wait(vault.ORACLE_DELAY());
        vm.prank(OWNER);
        vm.expectRevert(TacVault.NoPrice.selector);
        vault.executeOracle();
    }

    // ───────── raising the minimum debt over existing vaults ─────────

    /// Partial absorb works at the old minimum and underflows (Panic 0x11) once the minimum is over the vault's debt:
    /// a state the old immutable vault could not reach.
    function _underwaterAuction(uint256 reserve) internal {
        _open(alice, 15_000e18, 1_000e18);
        _open(bob, 15_000e18, reserve);
        vm.prank(bob);
        dollar.transfer(address(vault), reserve);
    }

    function test_aPartialAbsorbWorksAtTheOldMinimum() public {
        _underwaterAuction(400e18);
        oracle.set(P / 10);
        vault.liquidate(alice);
        _wait(vault.AUCTION_DURATION());
        vault.absorb(alice);
        (, uint256 debt,) = vault.vaults(alice);
        assertEq(debt, 600e18);
    }

    function test_aPartialAbsorbOfAVaultUnderTheRaisedMinimumIsRefused() public {
        _underwaterAuction(400e18);
        _apply(TacVault.Param.MinDebt, 1_500e18); // alice's 1,000 is now under the minimum
        oracle.set(P / 10);
        vault.liquidate(alice);
        _wait(vault.AUCTION_DURATION());
        vm.expectRevert(TacVault.BadAmount.selector);
        vault.absorb(alice);
    }

    /// A borrower under the raised minimum can repay everything or nothing: a part-repay is refused, also while
    /// she is in an auction and a part-repay is what would end it.
    function test_aVaultUnderTheRaisedMinimumRepaysWholeOrNothing() public {
        _open(alice, 15_000e18, 1_000e18);
        _apply(TacVault.Param.MinDebt, 1_500e18);
        vm.prank(alice);
        vm.expectRevert(TacVault.BadAmount.selector);
        vault.repay(alice, 200e18);
        vm.prank(alice);
        vault.repay(alice, type(uint256).max);
    }

    // ───────── the gas of the vault's mint/burn path ─────────

    function test_gasOfTheVaultPath() public {
        RevGasMinter g = new RevGasMinter();
        (uint256 mo, uint256 bo) = g.gasOld();
        (uint256 mn, uint256 bn) = g.gasNew();
        emit log_named_uint("mint old", mo);
        emit log_named_uint("mint new", mn);
        emit log_named_uint("burn old", bo);
        emit log_named_uint("burn new", bn);
        assertLe(mn, mo + 100);
        assertLe(bn, bo + 100);
    }

    // ───────── locking ─────────

    function test_lockParamsCancelsWhatIsAnnounced() public {
        vm.startPrank(OWNER);
        vault.queueParam(TacVault.Param.LiqRatioBps, 15_000);
        vault.queueParam(TacVault.Param.MinDebt, 50e18);
        vault.lockParams();
        vm.stopPrank();
        (uint192 value, uint64 eta) = vault.queuedParam(TacVault.Param.LiqRatioBps);
        assertEq(value, 0);
        assertEq(eta, 0);
        (value, eta) = vault.queuedParam(TacVault.Param.MinDebt);
        assertEq(eta, 0);
        _wait(3 days);
        vm.prank(OWNER);
        vm.expectRevert(TacVault.Locked.selector);
        vault.executeParam(TacVault.Param.LiqRatioBps);
    }

    // ───────── the owner's immediate lane ─────────

    /// Lowering the depth share to 0 in an emergency makes the way back 0 -> 25 -> 75 -> 175 -> 375: four waits.
    function test_afterLoweringToZeroTheWayBackIsEightDays() public {
        vm.prank(OWNER);
        vault.lowerDepthBps(0);
        vm.prank(OWNER);
        vm.expectRevert(TacVault.BadConfig.selector);
        vault.queueParam(TacVault.Param.DepthBps, 26);
        _apply(TacVault.Param.DepthBps, 25);
        _apply(TacVault.Param.DepthBps, 75);
        _apply(TacVault.Param.DepthBps, 175);
        _apply(TacVault.Param.DepthBps, 375);
        assertEq(vault.DEPTH_BPS(), 375);
    }

    /// The bonus and the liquidation ratio apply to an auction that is already running, as the NatSpec says: a bid
    /// afterwards takes the new bonus' share at once.
    function test_bonusRaisedMidAuctionAppliesAtOnce() public {
        _open(alice, 15_000e18, 2_000e18);
        _open(bob, 1_000_000e18, 5_000e18);
        oracle.set(P * 45 / 100); // 135%
        vault.liquidate(alice);
        // Queue the higher bonus before the auction (a 2-day wait), then let it take effect mid-auction.
        vm.prank(OWNER);
        vault.queueParam(TacVault.Param.LiqBonusBps, 1_500);
        _wait(vault.PARAM_DELAY());
        vm.prank(OWNER);
        vault.executeParam(TacVault.Param.LiqBonusBps);
        // 2 days in, the auction has run past its 2 hours: full (new) bonus.
        uint256 price = vault.offerPrice();
        (uint256 coll, uint256 debt,) = vault.vaults(alice);
        uint256 expect = debt * 11_500 / 10_000 * 1e18 / price;
        if (expect > coll) expect = coll;
        assertEq(vault.onOffer(alice), expect);
    }

    // ───────── enum bounds, renounce ─────────

    function test_enumOutOfRangeRevertsEverywhere() public {
        vm.startPrank(OWNER);
        (bool ok,) = address(vault).call(abi.encodeWithSelector(vault.queueParam.selector, uint256(7), uint256(1)));
        assertFalse(ok);
        (ok,) = address(vault).call(abi.encodeWithSelector(vault.executeParam.selector, uint256(7)));
        assertFalse(ok);
        (ok,) = address(vault).call(abi.encodeWithSelector(vault.cancelParam.selector, uint256(7)));
        assertFalse(ok);
        (ok,) = address(vault).call(abi.encodeWithSelector(vault.queuedParam.selector, uint256(7)));
        assertFalse(ok);
        vm.stopPrank();
    }

    /// Renouncing the vault's ownership freezes the synth's minters too: a further minter added before cannot be
    /// removed afterwards, and a pending one can never be executed or cancelled.
    function test_renounceFreezesTheMintersWhereTheyAre() public {
        vm.startPrank(OWNER);
        address m1 = address(new RevGasMinter());
        address m2 = address(new RevGasMinter());
        dollar.queueMinter(m1);
        vm.stopPrank();
        _wait(dollar.MINTER_DELAY());
        vm.startPrank(OWNER);
        dollar.executeMinter();
        dollar.queueMinter(m2);
        vault.renounceOwnership();
        vm.expectRevert(TacSynth.NotOwner.selector);
        dollar.removeMinter(m1);
        vm.expectRevert(TacSynth.NotOwner.selector);
        dollar.cancelMinter();
        vm.stopPrank();
        assertTrue(dollar.isMinter(m1));
        assertEq(dollar.pendingMinter(), m2);
    }
}

/// A venue oracle with settable answers (the TacPairOracle's input surface).
contract RevMockVenue {
    uint256 public constant STEP = 50;
    uint256 public constant SHORT_WINDOW = 10 minutes;
    uint256 public constant WINDOW = 1 hours;
    uint256 public constant MAX_WINDOW = 4 hours;
    uint256 public px;

    constructor(uint256 p) {
        px = p;
    }

    function set(uint256 p) external {
        px = p;
    }

    function POOL() external view returns (address) {
        return address(this);
    }

    function prices(uint256) external view returns (uint256, uint256) {
        return (px, px);
    }

    function recovery(uint256) external view returns (uint256) {
        return px;
    }

    function depth(uint256) external pure returns (uint256) {
        return 1e30;
    }

    function depthMin(uint256) external pure returns (uint256) {
        return 1e30;
    }

    function latest() external view returns (uint256) {
        return px;
    }

    function spot() external view returns (uint256) {
        return px;
    }
}

contract RevPairTest is RevBase {
    /// With the real TacPairOracle: one venue frozen 10x low (the other tracks the market) pins the pair's spot,
    /// low median and latest price low. Borrowers cannot withdraw; the liquidation view (the higher of the highs)
    /// still reads the market. A new pair on healthy venues is accepted at the market price.
    function test_aPairWithOneFrozenVenueIsReplacedAtTheMarketPrice() public {
        RevMockVenue a = new RevMockVenue(P);
        RevMockVenue b = new RevMockVenue(P);
        TacPairOracle pair = new TacPairOracle(address(a), address(b));
        TacVault.Config memory c = VaultConfig.defaults(address(tac), address(pair), address(feed), OWNER);
        c.depthBps = 100;
        TacVault v = new TacVault(c);
        vm.startPrank(alice);
        tac.approve(address(v), type(uint256).max);
        v.deposit(15_000e18);
        v.borrow(2_000e18, 0);
        vm.stopPrank();

        a.set(P / 10); // frozen low
        assertEq(
            v.valueOf(15_000e18, true), 15_000e18 * (P / 10) * 4000 / 1e18, "borrow view pinned to the frozen venue"
        );
        assertEq(v.liquidationPrice(), P * 4000, "liquidation view reads the market");
        vm.prank(alice);
        vm.expectRevert(TacVault.Undercollateralized.selector);
        v.withdraw(1);

        RevMockVenue a2 = new RevMockVenue(P);
        RevMockVenue b2 = new RevMockVenue(P);
        TacPairOracle healthy = new TacPairOracle(address(a2), address(b2));
        vm.prank(OWNER);
        v.queueOracle(address(healthy));
        skip(v.ORACLE_DELAY());
        feed.set(4000e8);
        vm.prank(OWNER);
        v.executeOracle();
        assertEq(address(v.ORACLE()), address(healthy));
        assertEq(v.valueOf(15_000e18, true), 15_000e18 * P * 4000 / 1e18, "the borrow view reads the market again");
    }
}

/// Random sequences of every owner action on the terms: the rails hold, nothing applies before its wait or with a
/// value other than the last one announced, and the depth share cannot climb faster than 2x + 25 per wait.
contract RevFuzz is RevBase {
    uint256 t0;
    uint256 d0;
    uint256[7] queuedAt;
    uint256[7] queuedVal;
    uint256 okQ;
    uint256 okE;
    uint256 bump;

    function _get(TacVault.Param id) internal view returns (uint256) {
        if (id == TacVault.Param.DepthBps) return vault.DEPTH_BPS();
        if (id == TacVault.Param.MintRatioBps) return vault.MINT_RATIO_BPS();
        if (id == TacVault.Param.LiqRatioBps) return vault.LIQ_RATIO_BPS();
        if (id == TacVault.Param.LiqBonusBps) return vault.LIQ_BONUS_BPS();
        if (id == TacVault.Param.OwnerWindow) return vault.OWNER_WINDOW();
        if (id == TacVault.Param.AuctionDuration) return vault.AUCTION_DURATION();
        return vault.MIN_DEBT();
    }

    function _candidate(TacVault.Param id, uint256 r) internal view returns (uint256) {
        uint256 cur = _get(id);
        uint256 mode = r % 4;
        uint256 x = r >> 8;
        if (id == TacVault.Param.DepthBps) {
            if (mode == 0) return 2 * cur + 25;
            if (mode == 1) return x % 1_100;
            if (mode == 2) return cur + x % 30;
            return cur > 5 ? cur - x % 5 : 0;
        }
        if (id == TacVault.Param.MintRatioBps || id == TacVault.Param.LiqRatioBps || id == TacVault.Param.LiqBonusBps) {
            uint256 span = id == TacVault.Param.LiqBonusBps ? 5_100 : 100_001;
            if (mode == 0) return x % span;
            if (mode == 1) return cur + x % 3_000;
            if (mode == 2) return cur > 3_000 ? cur - x % 3_000 : 1;
            return
                id == TacVault.Param.LiqBonusBps
                    ? 5_000
                    : id == TacVault.Param.LiqRatioBps ? 12_000 + x % 18_001 : 100_000;
        }
        if (id == TacVault.Param.OwnerWindow || id == TacVault.Param.AuctionDuration) {
            if (mode == 0) return x % (4 days);
            if (mode == 1) return cur + x % 1 hours;
            if (mode == 2) return cur > 1 hours ? cur - x % 1 hours : 1;
            return id == TacVault.Param.OwnerWindow ? 10 minutes + x % 1 days : 30 minutes + x % 3 days;
        }
        if (mode == 0) return x % 2e24;
        if (mode == 1) return cur + x % 1e21;
        if (mode == 2) return cur > 1e21 ? cur - x % 1e21 : 1;
        return 1e24;
    }

    function _rails() internal view {
        uint256 liq = vault.LIQ_RATIO_BPS();
        uint256 mint = vault.MINT_RATIO_BPS();
        uint256 bonus = vault.LIQ_BONUS_BPS();
        uint256 ow = vault.OWNER_WINDOW();
        uint256 ad = vault.AUCTION_DURATION();
        uint256 md = vault.MIN_DEBT();
        assertGe(liq, 12_000);
        assertLe(liq, 30_000);
        assertGe(mint, liq + 2_000);
        assertLe(mint, 100_000);
        assertGt(bonus, 0);
        assertLe(bonus, 5_000);
        assertLt(10_000 + bonus, liq);
        assertGe(ow, 10 minutes);
        assertLe(ow, 1 days);
        assertGe(ad, 30 minutes);
        assertLe(ad, 3 days);
        assertLt(ow, ad);
        assertGt(md, 0);
        assertLe(md, 1e24);
        assertLe(vault.DEPTH_BPS(), 1_000);
        // The depth share's envelope: at most (d0 + 25) * 2^k - 25 after k waits, and never past the hard share.
        uint256 k = (block.timestamp - t0) / 2 days;
        if (k > 12) k = 12;
        uint256 bound = (d0 + 25) * (1 << k) - 25;
        if (bound > 1_000) bound = 1_000;
        if (bound < d0) bound = d0;
        assertLe(vault.DEPTH_BPS(), bound, "depth share climbed faster than 2x + 25 per wait");
    }

    function test_coverageOfTheFuzz() public {
        for (uint256 j = 1; j <= 40; ++j) {
            _run(j * 7919);
        }
        emit log_named_uint("queued ok", okQ);
        emit log_named_uint("executed ok", okE);
        emit log_named_uint("executed and changed", bump);
        assertGt(bump, 50);
    }

    function testFuzz_railsAndDelaysHoldUnderAnySequence(uint256 seed) public {
        _run(seed);
    }

    function _run(uint256 seed) internal {
        t0 = block.timestamp;
        d0 = vault.DEPTH_BPS();
        vm.startPrank(OWNER);
        for (uint256 i; i < 80; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            TacVault.Param id = TacVault.Param((r >> 4) % 7);
            uint256 op = r % 10;
            if (op <= 2) {
                uint256 v = _candidate(id, r >> 16);
                try vault.queueParam(id, v) {
                    ++okQ;
                    queuedAt[uint256(id)] = block.timestamp;
                    queuedVal[uint256(id)] = v;
                } catch {}
            } else if (op <= 5) {
                uint256 before = _get(id);
                try vault.executeParam(id) {
                    ++okE;
                    if (_get(id) != before) ++bump;
                    assertGe(block.timestamp, queuedAt[uint256(id)] + 2 days, "applied before its wait");
                    assertEq(_get(id), queuedVal[uint256(id)], "applied a value that was not the last announced");
                    (, uint64 eta) = vault.queuedParam(id);
                    assertEq(eta, 0);
                } catch {
                    assertEq(_get(id), before);
                }
            } else if (op == 6) {
                try vault.cancelParam(id) {
                    (, uint64 eta) = vault.queuedParam(id);
                    assertEq(eta, 0);
                } catch {}
            } else if (op == 7) {
                try vault.lowerDepthBps((r >> 16) % 1_100) {} catch {}
            } else {
                skip(((r >> 16) % 5) * 12 hours + (r >> 40) % 1 hours);
            }
            _rails();
        }
        vm.stopPrank();
    }
}
