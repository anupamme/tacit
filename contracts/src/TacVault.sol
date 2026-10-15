// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {SignatureCheckerLib} from "solady/utils/SignatureCheckerLib.sol";
import {ECDSA} from "solady/utils/ECDSA.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {Multicallable} from "solady/utils/Multicallable.sol";
import {TacSynth} from "./TacSynth.sol";

interface ITacVaultOracle {
    function SHORT_WINDOW() external view returns (uint256);
    function WINDOW() external view returns (uint256);
    function MAX_WINDOW() external view returns (uint256);
    function prices(uint256 window) external view returns (uint256 low, uint256 high);
    function recovery(uint256 window) external view returns (uint256);
    function depthMin(uint256 window) external view returns (uint256);
    function latest() external view returns (uint256);
    function spot() external view returns (uint256);
}

interface ITacVaultFeed {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

interface ITacVaultToken {
    function decimals() external view returns (uint8);
}

interface IERC2612 {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

/// @title TacVault
/// @notice Borrow SYNTH against TAC. SYNTH is a TacSynth this contract deploys and mints (its owner can name further
///         minters, see TacSynth, and `lockMinters` there ends that for good); it tracks whatever
///         `ETH_USD` prices ETH in (a dollar with an ETH/USD feed, ETH itself with a feed fixed at 1.0). Each address
///         has one vault: deposit TAC, borrow, repay, withdraw. There is no interest.
///
///         Prices. The oracle gives ETH per TAC over a past window as a low and a high median of proven
///         end-of-block prices (`prices(window)`, `recovery(window)`), the newest of them (`latest()`) and now
///         (`spot()`); `ETH_USD` converts them. With two TAC venues behind it, each oracle value is the one that takes
///         moving both venues to move, except that a venue that is not tracking the market (retired, drained, frozen,
///         or held above it by someone trading) pins the liquidation, recovery, offer and redemption prices while it
///         stays so. LIQ_WINDOW is the oracle's longest window. Views:
///           - borrow: the lowest of the low WINDOW and SHORT_WINDOW medians and the current price. Borrowing and
///             withdrawing must leave the vault at MINT_RATIO_BPS or more.
///           - liquidation: the higher of the high LIQ_WINDOW and SHORT_WINDOW medians. Below LIQ_RATIO_BPS a
///             vault can be auctioned.
///           - recovery: the higher of the LIQ_WINDOW and SHORT_WINDOW recovery prices. At LIQ_RATIO_BPS or more an
///             auction ends.
///           - offer: the higher of the liquidation view and the newest recorded interval's price (with two venues,
///             the lower venue's: an end-of-block value from one interval, about ten minutes, older if recording
///             lags, that no single transaction can move); auctions price TAC here.
///           - redemption: the offer view.
///
///         Debt. Total debt is held under both the owner's `debtCeiling` and DEPTH_BPS of the venues' ETH depth
///         (the smallest the oracle recorded over LIQ_WINDOW, in SYNTH, which needs every interval of the window
///         recorded: borrowing waits for the keeper to catch up). The depth share rises and falls with the pools, so
///         a vault deployed with the largest `debtCeiling` is limited by depth alone; the owner may set a lower
///         ceiling and raise it again. The cap limits new borrowing only; debt already open stays when depth falls.
///
///         Liquidation. `liquidate` opens a Dutch auction on a vault below LIQ_RATIO_BPS. A bid repays debt and
///         takes TAC worth that debt at the offer view, plus a bonus that grows from zero at the auction's start to
///         LIQ_BONUS_BPS over AUCTION_DURATION (so the first outside bid, after OWNER_WINDOW, already carries the bonus
///         earned by then); at most the collateral. Bids may repay part of the debt (leaving zero or at least
///         MIN_DEBT) for the same share of the offer. The owner may bid at any time; others only after OWNER_WINDOW
///         from the auction's start, while there is an offer price and the vault has not recovered. During an
///         auction anyone can still deposit or repay, and the auction ends once the vault has recovered (a deposit,
///         repay, bid or absorb that brings it there ends it); `cancel` ends it then too. After AUCTION_DURATION, a
///         vault whose TAC is worth less than its debt at the liquidation view can be `absorb`ed: SYNTH held by this
///         contract (the reserve) burns as much of the debt as it covers, and the same share of the TAC goes to
///         `tacSink`. Anyone may send SYNTH to the reserve, and only `absorb` spends it, so what is sent stays out
///         of circulation; seed it from a dedicated vault that is never meant to close.
///
///         Fees:
///           - Borrowing adds `borrowFeeBps` of the amount to the debt, minted to `feeTo`. The owner sets the fee up
///             to MAX_BORROW_FEE_BPS, and `feeTo`; a borrower caps the fee with `maxFeeBps`.
///           - `redeem` burns SYNTH against a vault between LIQ_RATIO_BPS and twice that, for its TAC at the
///             redemption view, less a fee that stays in the vault: REDEMPTION_FEE_BPS at LIQ_RATIO_BPS, rising to
///             four times that at twice LIQ_RATIO_BPS, so redemptions fall on the least collateralised vaults first.
///
///         Owners need not send transactions: `borrowFor` and `withdrawFor` act on the owner's EIP-712 signature
///         (or ERC-1271 approval), and anyone may deposit into, repay or bid on any vault, so a vault can be run
///         from a shielded pool. `multicall` batches calls with the sender preserved, and `permitTac` /
///         `permitSynth` apply the caller's EIP-2612 permits, so approve, deposit and borrow fit in one
///         transaction.
///
///         Pause. The owner, or the `pauser` the owner names (a key that can do nothing else, for a fast answer to an
///         alert), can pause `liquidate`, outside bids, `absorb` and `redeem` for up to MAX_PAUSE at a time, and not
///         again until PAUSE_COOLDOWN after the pause ends (or is lifted), so a price held away from the market can
///         be waited out. Only the owner lifts a pause early. Deposits, repays, withdrawals, borrowing, `cancel` and
///         the vault owner's own bids go on.
///
///         Governed terms. The owner (transferable) tunes the vault to the market without a redeployment. At once it
///         can set the debt ceiling, the borrow fee, the redemption fee, where the borrow fee and the TAC of an
///         absorb go, the pauser and the pause, and lower the share of depth the vault may lend. Raising that share,
///         the mint and liquidation ratios, the bonus, the owner window, the auction's length, the minimum debt, and
///         replacing the oracle are announced first and take effect PARAM_DELAY (the oracle: ORACLE_DELAY) later,
///         inside fixed rails, so borrowers can repay and withdraw before a change reaches them. `lockParams` and
///         `lockOracle` end the owner's power over those terms for good. The TAC token, the synth (apart from the
///         further minters its owner may name, which only `lockMinters` on the synth ends), the ETH feed and the
///         accounting are immutable. An owner that renounces freezes the synth's minters as they stand.
contract TacVault is Ownable, Multicallable {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;
    uint256 public constant MAX_BORROW_FEE_BPS = 500;
    /// The longest one pause lasts, and the least time between the end of one and the start of the next.
    uint256 public constant MAX_PAUSE = 12 hours;
    uint256 public constant PAUSE_COOLDOWN = 12 hours;
    /// The largest share of the venues' depth (in basis points) the vault may be set to lend, and the redemption fee.
    uint256 public constant MAX_DEPTH_BPS = 1_000;
    uint256 public constant MAX_REDEMPTION_FEE_BPS = 250;
    /// How long a change to a governed term, or to the oracle, waits between its announcement and its execution, and
    /// how long after that it may still be executed.
    uint256 public constant PARAM_DELAY = 2 days;
    uint256 public constant ORACLE_DELAY = 3 days;
    uint256 public constant QUEUE_EXPIRY = 14 days;
    // The rails a queued change must stay inside, whatever the vault was deployed with.
    uint256 internal constant MIN_LIQ_RATIO_BPS = 12_000;
    uint256 internal constant MAX_LIQ_RATIO_BPS = 30_000;
    uint256 internal constant MIN_MARGIN_BPS = 2_000;
    uint256 internal constant MAX_MINT_RATIO_BPS = 100_000;
    uint256 internal constant MAX_BONUS_BPS = 5_000;
    uint256 internal constant MIN_OWNER_WINDOW = 10 minutes;
    uint256 internal constant MAX_OWNER_WINDOW = 1 days;
    uint256 internal constant MIN_AUCTION_DURATION = 30 minutes;
    uint256 internal constant MAX_AUCTION_DURATION = 3 days;

    bytes32 public constant BORROW = keccak256(
        "Borrow(address owner,uint256 amount,uint256 maxFeeBps,uint256 minCollateral,address to,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant WITHDRAW =
        keccak256("Withdraw(address owner,uint256 amount,address to,uint256 nonce,uint256 deadline)");

    address public immutable TAC;
    TacSynth public immutable SYNTH;
    ITacVaultFeed public immutable ETH_USD;
    uint256 internal immutable ETH_USD_SCALE;
    uint256 public immutable FEED_MAX_STALENESS;
    /// The minimum debt the vault was deployed with; a change to it stays within a tenth to a hundred times this.
    uint256 public immutable MIN_DEBT_BASE;

    // The terms the owner can change (see "governed terms"); read through the upper-case getters below.
    ITacVaultOracle internal _oracle;
    uint256 internal _mintRatioBps;
    uint256 internal _liqRatioBps;
    uint256 internal _liqBonusBps;
    uint256 internal _auctionDuration;
    uint256 internal _ownerWindow;
    uint256 internal _minDebt;
    uint256 internal _redemptionFeeBps;
    uint256 internal _depthBps;
    address public tacSink;
    address public feeTo;

    struct Vault {
        uint256 collateral; // TAC, 18 decimals
        uint256 debt; // SYNTH, 18 decimals
        uint256 auctionStart; // 0 when no auction runs
    }

    struct Config {
        address tac;
        address oracle;
        address ethUsd;
        address owner;
        uint256 mintRatioBps;
        uint256 liqRatioBps;
        uint256 liqWindow;
        uint256 liqBonusBps;
        uint256 auctionDuration;
        uint256 ownerWindow;
        uint256 minDebt;
        uint256 feedMaxStaleness;
        uint256 debtCeiling;
        uint256 depthBps;
        uint256 redemptionFeeBps;
        uint256 borrowFeeBps;
        address feeTo;
        address tacSink;
        string name;
        string symbol;
    }

    /// The terms the owner can change after deployment, slowly (see `queueParam`).
    enum Param {
        DepthBps,
        MintRatioBps,
        LiqRatioBps,
        LiqBonusBps,
        OwnerWindow,
        AuctionDuration,
        MinDebt
    }

    struct Queued {
        uint192 value;
        uint64 eta;
    }

    mapping(Param => Queued) public queuedParam;
    /// The oracle announced to replace the current one and when it may take over (zero when none).
    address public pendingOracle;
    uint256 public pendingOracleEta;
    /// Set for good by `lockParams` / `lockOracle`: no further queued change of that kind, ever.
    bool public paramsLocked;
    bool public oracleLocked;

    mapping(address => Vault) public vaults;
    mapping(address => uint256) public nonces;
    uint256 public totalDebt;
    uint256 public debtCeiling;
    uint256 public borrowFeeBps;
    /// Until this time `liquidate`, outside bids, `absorb` and `redeem` are refused.
    uint256 public pausedUntil;
    /// An address besides the owner that may start a pause (and nothing else); none until the owner names one.
    address public pauser;

    error BadConfig();
    error BadAmount();
    error Undercollateralized();
    error OverCeiling();
    error InAuction();
    error NoAuction();
    error Healthy();
    error StillUnhealthy();
    error FeeTooHigh();
    error TooEarly();
    error BadFeed();
    error StaleFeed();
    error BadSignature();
    error Expired();
    error TooLittleCollateral();
    error NoPrice();
    error OwnerWindow();
    error Paused();
    error PauseCooldown();
    error Locked();
    error NothingQueued();

    event Deposited(address indexed owner, address indexed payer, uint256 amount);
    event Withdrawn(address indexed owner, address to, uint256 amount);
    event Borrowed(address indexed owner, address to, uint256 amount, uint256 fee);
    event Repaid(address indexed owner, address indexed payer, uint256 amount);
    event AuctionStarted(address indexed owner, uint256 debt, uint256 collateral);
    event AuctionEnded(address indexed owner);
    event Liquidated(address indexed owner, address indexed bidder, uint256 debt, uint256 taken);
    event Absorbed(address indexed owner, uint256 debt, uint256 collateral);
    event Redeemed(address indexed owner, address indexed redeemer, uint256 amount, uint256 tac);
    event NonceUsed(address indexed owner, uint256 nonce);
    event DebtCeilingSet(uint256 ceiling);
    event BorrowFeeSet(uint256 bps);
    event FeeToSet(address to);
    event TacSinkSet(address to);
    event AuctionsPausedUntil(uint256 until);
    event PauserSet(address to);
    event ParamQueued(Param indexed id, uint256 value, uint256 eta);
    event ParamSet(Param indexed id, uint256 value);
    event ParamCancelled(Param indexed id);
    event RedemptionFeeSet(uint256 bps);
    event OracleQueued(address indexed oracle, uint256 eta);
    event OracleSet(address indexed oracle);
    event OracleCancelled(address indexed oracle);
    event ParamsLocked();
    event OracleLocked();

    constructor(Config memory c) {
        if (c.tac.code.length == 0 || c.oracle.code.length == 0 || c.ethUsd.code.length == 0) revert BadConfig();
        if (c.owner == address(0) || c.tacSink == address(0) || c.feeTo == address(0)) revert BadConfig();
        if (ITacVaultToken(c.tac).decimals() != 18) revert BadConfig();
        if (c.liqRatioBps < BPS || c.mintRatioBps <= c.liqRatioBps || c.mintRatioBps > 100_000) revert BadConfig();
        if (c.liqBonusBps == 0 || BPS + c.liqBonusBps >= c.liqRatioBps) revert BadConfig();
        if (c.auctionDuration == 0 || c.ownerWindow >= c.auctionDuration) revert BadConfig();
        if (c.feedMaxStaleness == 0 || c.minDebt == 0) revert BadConfig();
        if (c.redemptionFeeBps > 250 || c.borrowFeeBps > MAX_BORROW_FEE_BPS) revert BadConfig();
        if (c.depthBps == 0 || c.depthBps > MAX_DEPTH_BPS) revert BadConfig();
        // The liquidation, recovery and offer views then all read the same windows and have a price together.
        if (c.liqWindow != ITacVaultOracle(c.oracle).MAX_WINDOW()) revert BadConfig();
        uint8 feedDecimals = ITacVaultFeed(c.ethUsd).decimals();
        if (feedDecimals > 18) revert BadConfig();

        TAC = c.tac;
        SYNTH = new TacSynth(c.name, c.symbol);
        _oracle = ITacVaultOracle(c.oracle);
        ETH_USD = ITacVaultFeed(c.ethUsd);
        ETH_USD_SCALE = 10 ** uint256(feedDecimals);
        _mintRatioBps = c.mintRatioBps;
        _liqRatioBps = c.liqRatioBps;
        _liqBonusBps = c.liqBonusBps;
        _auctionDuration = c.auctionDuration;
        _ownerWindow = c.ownerWindow;
        _minDebt = c.minDebt;
        FEED_MAX_STALENESS = c.feedMaxStaleness;
        MIN_DEBT_BASE = c.minDebt;
        _redemptionFeeBps = c.redemptionFeeBps;
        _depthBps = c.depthBps;
        _initializeOwner(c.owner);
        debtCeiling = c.debtCeiling;
        borrowFeeBps = c.borrowFeeBps;
        tacSink = c.tacSink;
        feeTo = c.feeTo;
        emit DebtCeilingSet(c.debtCeiling);
        emit BorrowFeeSet(c.borrowFeeBps);
        emit FeeToSet(c.feeTo);
        emit TacSinkSet(c.tacSink);
    }

    // ─────────────── owner ───────────────

    function setDebtCeiling(uint256 ceiling) external onlyOwner {
        debtCeiling = ceiling;
        emit DebtCeilingSet(ceiling);
    }

    function setBorrowFee(uint256 bps) external onlyOwner {
        if (bps > MAX_BORROW_FEE_BPS) revert BadConfig();
        borrowFeeBps = bps;
        emit BorrowFeeSet(bps);
    }

    /// Where the borrow fee, in SYNTH, is minted from now on.
    function setFeeTo(address to) external onlyOwner {
        if (to == address(0)) revert BadConfig();
        feeTo = to;
        emit FeeToSet(to);
    }

    /// Where the TAC of an `absorb` goes from now on.
    function setTacSink(address to) external onlyOwner {
        if (to == address(0)) revert BadConfig();
        tacSink = to;
        emit TacSinkSet(to);
    }

    /// The address that may start a pause besides the owner (zero for none).
    function setPauser(address to) external onlyOwner {
        pauser = to;
        emit PauserSet(to);
    }

    /// Pauses `liquidate`, outside bids, `absorb` and `redeem` for `duration` (at most MAX_PAUSE). Not allowed
    /// until PAUSE_COOLDOWN after the previous pause ended, so a pause cannot be renewed or extended back to back.
    function pauseAuctions(uint256 duration) external {
        if (msg.sender != owner() && msg.sender != pauser) revert Unauthorized();
        if (duration == 0 || duration > MAX_PAUSE) revert BadConfig();
        if (block.timestamp < pausedUntil + PAUSE_COOLDOWN) revert PauseCooldown();
        pausedUntil = block.timestamp + duration;
        emit AuctionsPausedUntil(pausedUntil);
    }

    /// Ends a running pause now; the cooldown counts from this moment.
    function resumeAuctions() external onlyOwner {
        if (block.timestamp >= pausedUntil) revert BadConfig();
        pausedUntil = block.timestamp;
        emit AuctionsPausedUntil(block.timestamp);
    }

    /// Whether `liquidate`, outside bids, `absorb` and `redeem` are paused.
    function paused() public view returns (bool) {
        return block.timestamp < pausedUntil;
    }

    // ─────────────── governed terms ───────────────
    //
    // The owner can tune the vault to the market without redeploying it, under three rules: a change that makes the
    // vault safer for lenders takes effect at once (`lowerDepthBps`, a lower `setDebtCeiling`, the pause); every
    // other change is announced and takes effect PARAM_DELAY (the oracle: ORACLE_DELAY) later, so borrowers can
    // repay and withdraw first; and every change stays inside fixed rails. `lockParams` and `lockOracle` end the
    // owner's power over those terms for good. A change applies to an auction already running at once.

    /// Announces a new value for a governed term; `executeParam` applies it after PARAM_DELAY. Announcing again
    /// replaces the earlier announcement and restarts the wait.
    function queueParam(Param id, uint256 value) external onlyOwner {
        if (paramsLocked) revert Locked();
        if (value > type(uint192).max) revert BadConfig();
        _validate(id, value);
        uint256 eta = block.timestamp + PARAM_DELAY;
        queuedParam[id] = Queued(uint192(value), uint64(eta));
        emit ParamQueued(id, value, eta);
    }

    /// Applies an announced change once its wait is over (and before QUEUE_EXPIRY more has passed). The rails are
    /// checked again against the terms as they are now.
    function executeParam(Param id) external onlyOwner {
        if (paramsLocked) revert Locked();
        Queued memory q = queuedParam[id];
        if (q.eta == 0) revert NothingQueued();
        if (block.timestamp < q.eta) revert TooEarly();
        if (block.timestamp > uint256(q.eta) + QUEUE_EXPIRY) revert Expired();
        delete queuedParam[id];
        _validate(id, q.value);
        if (id == Param.DepthBps) _depthBps = q.value;
        else if (id == Param.MintRatioBps) _mintRatioBps = q.value;
        else if (id == Param.LiqRatioBps) _liqRatioBps = q.value;
        else if (id == Param.LiqBonusBps) _liqBonusBps = q.value;
        else if (id == Param.OwnerWindow) _ownerWindow = q.value;
        else if (id == Param.AuctionDuration) _auctionDuration = q.value;
        else _minDebt = q.value;
        emit ParamSet(id, q.value);
    }

    function cancelParam(Param id) external onlyOwner {
        if (queuedParam[id].eta == 0) revert NothingQueued();
        delete queuedParam[id];
        emit ParamCancelled(id);
    }

    /// Lowers the share of the venues' depth the vault may lend, at once.
    function lowerDepthBps(uint256 bps) external onlyOwner {
        if (bps >= _depthBps) revert BadConfig();
        _depthBps = bps;
        emit ParamSet(Param.DepthBps, bps);
    }

    function setRedemptionFee(uint256 bps) external onlyOwner {
        if (bps > MAX_REDEMPTION_FEE_BPS) revert BadConfig();
        _redemptionFeeBps = bps;
        emit RedemptionFeeSet(bps);
    }

    /// Ends the owner's power to change the governed terms (and cancels what is announced), for good.
    function lockParams() external onlyOwner {
        paramsLocked = true;
        for (uint256 i; i <= uint256(type(Param).max); ++i) {
            delete queuedParam[Param(i)];
        }
        emit ParamsLocked();
    }

    // The rails for changing one term, with the others as they are now.
    function _validate(Param id, uint256 v) internal view {
        uint256 liq = _liqRatioBps;
        uint256 mint = _mintRatioBps;
        uint256 bonus = _liqBonusBps;
        uint256 ow = _ownerWindow;
        uint256 ad = _auctionDuration;
        if (id == Param.DepthBps) {
            // Up by at most doubling (and a little from nothing) and never past the hard share; down is free.
            if (v > MAX_DEPTH_BPS || v > 2 * _depthBps + 25) revert BadConfig();
        } else if (id == Param.MintRatioBps) {
            if (v > MAX_MINT_RATIO_BPS || v < liq + MIN_MARGIN_BPS) revert BadConfig();
        } else if (id == Param.LiqRatioBps) {
            if (v < MIN_LIQ_RATIO_BPS || v > MAX_LIQ_RATIO_BPS || mint < v + MIN_MARGIN_BPS || BPS + bonus >= v) {
                revert BadConfig();
            }
        } else if (id == Param.LiqBonusBps) {
            if (v == 0 || v > MAX_BONUS_BPS || BPS + v >= liq) revert BadConfig();
        } else if (id == Param.OwnerWindow) {
            if (v < MIN_OWNER_WINDOW || v > MAX_OWNER_WINDOW || v >= ad) revert BadConfig();
        } else if (id == Param.AuctionDuration) {
            if (v < MIN_AUCTION_DURATION || v > MAX_AUCTION_DURATION || ow >= v) revert BadConfig();
        } else if (v < MIN_DEBT_BASE / 10 || v > MIN_DEBT_BASE * 100) {
            revert BadConfig();
        }
    }

    /// Announces an oracle to take over from the current one ORACLE_DELAY later. It must have its windows set and,
    /// when executed, price TAC right now (its intervals recorded) within a factor of three of something the old one says.
    function queueOracle(address oracle) external onlyOwner {
        if (oracleLocked) revert Locked();
        ITacVaultOracle o = ITacVaultOracle(oracle);
        if (oracle.code.length == 0 || oracle == address(_oracle)) revert BadConfig();
        uint256 short = o.SHORT_WINDOW();
        if (short == 0 || o.WINDOW() < short || o.MAX_WINDOW() < o.WINDOW()) revert BadConfig();
        pendingOracle = oracle;
        pendingOracleEta = block.timestamp + ORACLE_DELAY;
        emit OracleQueued(oracle, pendingOracleEta);
    }

    function executeOracle() external onlyOwner {
        if (oracleLocked) revert Locked();
        address next = pendingOracle;
        if (next == address(0)) revert NothingQueued();
        if (block.timestamp < pendingOracleEta) revert TooEarly();
        if (block.timestamp > pendingOracleEta + QUEUE_EXPIRY) revert Expired();
        ITacVaultOracle o = ITacVaultOracle(next);
        uint256 high = _answers(o);
        if (!_continuous(high)) revert BadConfig();
        delete pendingOracle;
        delete pendingOracleEta;
        _oracle = o;
        emit OracleSet(next);
    }

    /// The upper median over the new oracle's WINDOW, having checked that its windows are in order and that it gives
    /// a price on every view the vault reads (reverting if not).
    function _answers(ITacVaultOracle o) internal view returns (uint256 high) {
        uint256 short = o.SHORT_WINDOW();
        uint256 window = o.WINDOW();
        uint256 max = o.MAX_WINDOW();
        if (short == 0 || window < short || max < window) revert BadConfig();
        uint256[3] memory ws = [short, window, max];
        for (uint256 i; i < 3; ++i) {
            (uint256 lo, uint256 hi) = o.prices(ws[i]);
            if (lo == 0 || hi == 0 || o.recovery(ws[i]) == 0) revert NoPrice();
            if (i == 1) high = hi;
        }
        if (o.spot() == 0 || o.latest() == 0 || o.depthMin(max) == 0) revert NoPrice();
    }

    /// Whether `price` is within a factor of three of something the current oracle still says: its spot, or its
    /// low or high median over its WINDOW. What the current oracle does not give (it reverts or says zero) is no
    /// anchor, so an oracle that has stopped working can be replaced, and so can one with a venue frozen far from
    /// the market (its high median still follows the market). This catches a wrong address or scale, not a
    /// deliberate oracle: the announcement's delay and `lockOracle` are what protect against that.
    function _continuous(uint256 price) internal view returns (bool) {
        ITacVaultOracle old = _oracle;
        bool anchored;
        try old.spot() returns (uint256 s) {
            if (s != 0) {
                anchored = true;
                if (_within3(price, s)) return true;
            }
        } catch {}
        try old.WINDOW() returns (uint256 w) {
            try old.prices(w) returns (uint256 lo, uint256 hi) {
                if (lo != 0) {
                    anchored = true;
                    if (_within3(price, lo)) return true;
                }
                if (hi != 0) {
                    anchored = true;
                    if (_within3(price, hi)) return true;
                }
            } catch {}
        } catch {}
        return !anchored;
    }

    function _within3(uint256 a, uint256 b) internal pure returns (bool) {
        return a <= 3 * b && a * 3 >= b;
    }

    function cancelOracle() external onlyOwner {
        address next = pendingOracle;
        if (next == address(0)) revert NothingQueued();
        delete pendingOracle;
        delete pendingOracleEta;
        emit OracleCancelled(next);
    }

    /// Ends the owner's power to replace the oracle (and cancels what is announced), for good.
    function lockOracle() external onlyOwner {
        oracleLocked = true;
        delete pendingOracle;
        delete pendingOracleEta;
        emit OracleLocked();
    }

    // The terms under their original names.
    function ORACLE() external view returns (ITacVaultOracle) {
        return _oracle;
    }

    function MINT_RATIO_BPS() external view returns (uint256) {
        return _mintRatioBps;
    }

    function LIQ_RATIO_BPS() external view returns (uint256) {
        return _liqRatioBps;
    }

    /// The longest window of the oracle now in place.
    function LIQ_WINDOW() external view returns (uint256) {
        return _oracle.MAX_WINDOW();
    }

    function LIQ_BONUS_BPS() external view returns (uint256) {
        return _liqBonusBps;
    }

    function AUCTION_DURATION() external view returns (uint256) {
        return _auctionDuration;
    }

    function OWNER_WINDOW() external view returns (uint256) {
        return _ownerWindow;
    }

    function MIN_DEBT() external view returns (uint256) {
        return _minDebt;
    }

    function REDEMPTION_FEE_BPS() external view returns (uint256) {
        return _redemptionFeeBps;
    }

    function DEPTH_BPS() external view returns (uint256) {
        return _depthBps;
    }

    // ─────────────── permits ───────────────

    /// Applies the caller's EIP-2612 permit for TAC to this contract. A permit that fails (for example because
    /// someone already submitted it) is skipped; the call that needs the allowance decides.
    function permitTac(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        try IERC2612(TAC).permit(msg.sender, address(this), value, deadline, v, r, s) {} catch {}
    }

    /// As `permitTac`, for the synth this vault mints.
    function permitSynth(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        try IERC2612(address(SYNTH)).permit(msg.sender, address(this), value, deadline, v, r, s) {} catch {}
    }

    // ─────────────── borrower ───────────────

    function deposit(uint256 amount) external {
        _deposit(msg.sender, amount);
    }

    /// Adds the caller's TAC to `owner`'s vault (approve this contract first).
    function depositFor(address owner, uint256 amount) external {
        _deposit(owner, amount);
    }

    /// Withdraws `amount` of the caller's TAC; more than the collateral withdraws all of it.
    function withdraw(uint256 amount) external {
        _withdraw(msg.sender, amount, msg.sender);
    }

    /// Withdraws `owner`'s TAC to `to` on its signature; more than the collateral withdraws all of it.
    function withdrawFor(address owner, uint256 amount, address to, uint256 deadline, bytes calldata sig) external {
        _authorize(
            keccak256(abi.encode(WITHDRAW, owner, amount, to, _useNonce(owner), deadline)), owner, to, deadline, sig
        );
        _withdraw(owner, amount, to);
    }

    /// Borrows `amount` to the caller, refusing a borrow fee above `maxFeeBps`.
    function borrow(uint256 amount, uint256 maxFeeBps) external {
        _borrow(msg.sender, amount, maxFeeBps, msg.sender);
    }

    /// Borrows for `owner` on its signature, which also sets the least collateral the vault must hold.
    function borrowFor(
        address owner,
        uint256 amount,
        uint256 maxFeeBps,
        uint256 minCollateral,
        address to,
        uint256 deadline,
        bytes calldata sig
    ) external {
        bytes32 structHash = keccak256(
            abi.encode(BORROW, owner, amount, maxFeeBps, minCollateral, to, _useNonce(owner), deadline)
        );
        _authorize(structHash, owner, to, deadline, sig);
        if (vaults[owner].collateral < minCollateral) revert TooLittleCollateral();
        _borrow(owner, amount, maxFeeBps, to);
    }

    /// Repays up to `amount` of `owner`'s debt from the caller's SYNTH (approve this contract first); a larger
    /// amount repays all of it. The debt left must be zero or at least MIN_DEBT.
    function repay(address owner, uint256 amount) external returns (uint256 paid) {
        Vault storage v = vaults[owner];
        paid = FixedPointMathLib.min(amount, v.debt);
        if (paid == 0) revert BadAmount();
        uint256 debt = v.debt - paid;
        if (debt != 0 && debt < _minDebt) revert BadAmount();
        v.debt = debt;
        totalDebt -= paid;
        if (v.auctionStart != 0) _tryEnd(owner, v);
        SYNTH.burnFrom(msg.sender, paid);
        emit Repaid(owner, msg.sender, paid);
    }

    /// Spends the caller's next nonce, voiding any signature made with it.
    function useNonce() external {
        emit NonceUsed(msg.sender, _useNonce(msg.sender));
    }

    function _deposit(address owner, uint256 amount) internal {
        if (amount == 0 || owner == address(0)) revert BadAmount();
        Vault storage v = vaults[owner];
        v.collateral += amount;
        if (v.auctionStart != 0) _tryEnd(owner, v);
        SafeTransferLib.safeTransferFrom(TAC, msg.sender, address(this), amount);
        emit Deposited(owner, msg.sender, amount);
    }

    function _withdraw(address owner, uint256 amount, address to) internal {
        Vault storage v = vaults[owner];
        if (v.auctionStart != 0) revert InAuction();
        amount = FixedPointMathLib.min(amount, v.collateral);
        if (amount == 0) revert BadAmount();
        v.collateral -= amount;
        if (v.debt != 0) _requireBorrowHealthy(v);
        SafeTransferLib.safeTransfer(TAC, to, amount);
        emit Withdrawn(owner, to, amount);
    }

    function _borrow(address owner, uint256 amount, uint256 maxFeeBps, address to) internal {
        Vault storage v = vaults[owner];
        if (v.auctionStart != 0) revert InAuction();
        if (amount == 0) revert BadAmount();
        uint256 feeBps = borrowFeeBps;
        if (feeBps > maxFeeBps) revert FeeTooHigh();
        uint256 fee = amount * feeBps / BPS;
        uint256 debt = v.debt + amount + fee;
        if (debt < _minDebt) revert BadAmount();
        uint256 total = totalDebt + amount + fee;
        if (total > debtCeiling || total * BPS > _depth() * _depthBps) revert OverCeiling();
        v.debt = debt;
        totalDebt = total;
        _requireBorrowHealthy(v);
        SYNTH.mint(to, amount);
        if (fee != 0) SYNTH.mint(feeTo, fee);
        emit Borrowed(owner, to, amount, fee);
    }

    // ─────────────── signatures ───────────────

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
                keccak256("TacVault"),
                block.chainid,
                address(this)
            )
        );
    }

    /// The EIP-712 digest for a struct hash built as in `borrowFor` / `withdrawFor`.
    function digest(bytes32 structHash) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _useNonce(address owner) internal returns (uint256) {
        return nonces[owner]++;
    }

    function _authorize(bytes32 structHash, address owner, address to, uint256 deadline, bytes calldata sig)
        internal
        view
    {
        if (block.timestamp > deadline) revert Expired();
        if (to == address(0) || owner == address(0)) revert BadAmount();
        // The owner's own key signs even when the owner has code (an EIP-7702 account); otherwise ERC-1271.
        bytes32 h = digest(structHash);
        if (
            ECDSA.tryRecoverCalldata(h, sig) != owner
                && !SignatureCheckerLib.isValidERC1271SignatureNowCalldata(owner, h, sig)
        ) {
            revert BadSignature();
        }
    }

    // ─────────────── liquidation ───────────────

    /// Opens an auction on `owner`'s vault if it is below LIQ_RATIO_BPS at the liquidation view.
    function liquidate(address owner) external {
        if (paused()) revert Paused();
        Vault storage v = vaults[owner];
        if (v.auctionStart != 0) revert InAuction();
        if (v.debt == 0 || _value(v.collateral, _liqUsdPerTac()) * BPS >= v.debt * _liqRatioBps) revert Healthy();
        v.auctionStart = block.timestamp;
        emit AuctionStarted(owner, v.debt, v.collateral);
    }

    /// Ends the auction on `owner`'s vault once it has recovered (see `recovered`).
    function cancel(address owner) external {
        Vault storage v = vaults[owner];
        if (v.auctionStart == 0) revert NoAuction();
        if (_value(v.collateral, _recoveryUsdPerTac()) * BPS < v.debt * _liqRatioBps) revert StillUnhealthy();
        _end(owner, v);
    }

    /// The TAC a bid repaying all of `owner`'s debt takes now: that debt in TAC at the offer view, plus the bonus
    /// earned so far, at most the collateral. Without a price, the collateral (only the owner may bid).
    function onOffer(address owner) public view returns (uint256 tac) {
        if (vaults[owner].auctionStart == 0) return 0;
        (tac,) = _offer(owner);
    }

    function _offer(address owner) internal view returns (uint256 tac, bool priced) {
        Vault storage v = vaults[owner];
        tac = v.collateral;
        try this.offerPrice() returns (uint256 usdPerTac) {
            uint256 elapsed = FixedPointMathLib.min(block.timestamp - v.auctionStart, _auctionDuration);
            uint256 bonus = _liqBonusBps * elapsed / _auctionDuration;
            tac = FixedPointMathLib.min(tac, FixedPointMathLib.fullMulDiv(v.debt * (BPS + bonus) / BPS, WAD, usdPerTac));
            priced = true;
        } catch {}
    }

    /// Repays up to `amount` of `owner`'s debt from the caller's SYNTH (a larger amount repays all of it) and
    /// takes the same share of the TAC on offer; the rest stays the owner's. The debt left must be zero or at
    /// least MIN_DEBT. Others may bid only after OWNER_WINDOW from the auction's start, while there is an offer
    /// price and the vault has not recovered. `minTac` is the least TAC accepted.
    function bid(address owner, uint256 amount, uint256 minTac) external returns (uint256 taken) {
        Vault storage v = vaults[owner];
        if (v.auctionStart == 0) revert NoAuction();
        (uint256 offer, bool priced) = _offer(owner);
        if (msg.sender != owner) {
            if (paused()) revert Paused();
            if (block.timestamp < v.auctionStart + _ownerWindow) revert OwnerWindow();
            if (!priced) revert NoPrice();
            try this.recovered(owner) returns (bool ok) {
                if (ok) revert Healthy();
            } catch {
                revert NoPrice();
            }
        }
        uint256 debt = v.debt;
        amount = FixedPointMathLib.min(amount, debt);
        if (amount == 0 || (debt - amount != 0 && debt - amount < _minDebt)) revert BadAmount();
        taken = offer * amount / debt;
        if (taken < minTac) revert BadAmount();
        v.debt = debt - amount;
        v.collateral -= taken;
        totalDebt -= amount;
        _tryEnd(owner, v);
        SYNTH.burnFrom(msg.sender, amount);
        SafeTransferLib.safeTransfer(TAC, msg.sender, taken);
        emit Liquidated(owner, msg.sender, amount, taken);
    }

    /// After AUCTION_DURATION, burns as much of `owner`'s debt as the reserve (SYNTH held here) covers, leaving zero
    /// or at least MIN_DEBT, on a vault whose TAC is worth less than its debt at the liquidation view, and sends the
    /// same share of its TAC to `tacSink`.
    function absorb(address owner) external {
        if (paused()) revert Paused();
        Vault storage v = vaults[owner];
        if (v.auctionStart == 0) revert NoAuction();
        if (block.timestamp - v.auctionStart < _auctionDuration) revert TooEarly();
        uint256 debt = v.debt;
        if (_value(v.collateral, _liqUsdPerTac()) >= debt) revert Healthy();
        uint256 amount = SYNTH.balanceOf(address(this));
        // A partial absorb leaves at least the minimum debt, so a vault at or under it is absorbed whole or not at all.
        if (amount < debt) {
            if (debt <= _minDebt) revert BadAmount();
            amount = FixedPointMathLib.min(amount, debt - _minDebt);
        } else {
            amount = debt;
        }
        if (amount == 0) revert BadAmount();
        uint256 tac = v.collateral * amount / debt;
        v.debt = debt - amount;
        v.collateral -= tac;
        totalDebt -= amount;
        _tryEnd(owner, v);
        SYNTH.approve(address(this), amount);
        SYNTH.burnFrom(address(this), amount);
        SafeTransferLib.safeTransfer(TAC, tacSink, tac);
        emit Absorbed(owner, amount, tac);
    }

    // ─────────────── redemption ───────────────

    /// Burns `amount` of the caller's SYNTH against `owner`'s debt for that value of its TAC at the redemption
    /// view, less the redemption fee (see the contract notes), which stays in the vault. The vault must be between
    /// LIQ_RATIO_BPS and twice that at the liquidation view and not in an auction, and the debt left zero or at
    /// least MIN_DEBT.
    function redeem(address owner, uint256 amount, uint256 minTac) external returns (uint256 tac) {
        if (paused()) revert Paused();
        Vault storage v = vaults[owner];
        if (v.auctionStart != 0) revert InAuction();
        if (amount == 0 || amount > v.debt) revert BadAmount();
        uint256 debt = v.debt - amount;
        if (debt != 0 && debt < _minDebt) revert BadAmount();
        uint256 liqUsd = _liqUsdPerTac();
        uint256 ratio = _value(v.collateral, liqUsd) * BPS / v.debt;
        if (ratio < _liqRatioBps) revert StillUnhealthy();
        if (ratio >= 2 * _liqRatioBps) revert Healthy();
        uint256 usdPerTac = _offerUsdPerTac();
        uint256 fee = _redemptionFeeBps + _redemptionFeeBps * 3 * (ratio - _liqRatioBps) / _liqRatioBps;
        tac = FixedPointMathLib.fullMulDiv(amount * (BPS - fee) / BPS, WAD, usdPerTac);
        if (tac < minTac || tac > v.collateral) revert BadAmount();
        v.debt = debt;
        v.collateral -= tac;
        totalDebt -= amount;
        SYNTH.burnFrom(msg.sender, amount);
        SafeTransferLib.safeTransfer(TAC, msg.sender, tac);
        emit Redeemed(owner, msg.sender, amount, tac);
    }

    // ─────────────── pricing ───────────────

    /// SYNTH value (18 decimals) of `tac` TAC at the borrow view (`forBorrow`) or the liquidation view.
    function valueOf(uint256 tac, bool forBorrow) external view returns (uint256) {
        return _value(tac, forBorrow ? _borrowUsdPerTac() : _liqUsdPerTac());
    }

    /// The most total debt the pool's depth allows now (before `debtCeiling`).
    function depthCeiling() external view returns (uint256) {
        return _depth() * _depthBps / BPS;
    }

    /// SYNTH per TAC (1e18-scaled) at the liquidation view.
    function liquidationPrice() external view returns (uint256) {
        return _liqUsdPerTac();
    }

    /// SYNTH per TAC (1e18-scaled) at the offer view.
    function offerPrice() external view returns (uint256) {
        return _offerUsdPerTac();
    }

    /// Whether `owner`'s vault is at or above LIQ_RATIO_BPS at the liquidation view (no auction may start).
    function liqHealthyView(address owner) external view returns (bool) {
        Vault storage v = vaults[owner];
        return _value(v.collateral, _liqUsdPerTac()) * BPS >= v.debt * _liqRatioBps;
    }

    /// Whether `owner`'s vault is at or above LIQ_RATIO_BPS at the recovery view: then its auction ends, and
    /// outsiders may not bid.
    function recovered(address owner) external view returns (bool) {
        Vault storage v = vaults[owner];
        return _value(v.collateral, _recoveryUsdPerTac()) * BPS >= v.debt * _liqRatioBps;
    }

    function _value(uint256 tac, uint256 usdPerTac) internal pure returns (uint256) {
        return FixedPointMathLib.fullMulDiv(tac, usdPerTac, WAD);
    }

    function _requireBorrowHealthy(Vault storage v) internal view {
        if (v.debt * _mintRatioBps > _value(v.collateral, _borrowUsdPerTac()) * BPS) revert Undercollateralized();
    }

    // Ends the auction once the vault owes nothing or has recovered; without a price it leaves the auction running
    // rather than refusing the deposit or repay.
    function _tryEnd(address owner, Vault storage v) internal {
        if (v.debt == 0) return _end(owner, v);
        try this.recovered(owner) returns (bool ok) {
            if (ok) _end(owner, v);
        } catch {}
    }

    function _end(address owner, Vault storage v) internal {
        v.auctionStart = 0;
        emit AuctionEnded(owner);
    }

    // SYNTH per TAC (1e18-scaled) at the borrow view.
    function _borrowUsdPerTac() internal view returns (uint256) {
        (uint256 window,) = _oracle.prices(_oracle.WINDOW());
        (uint256 short,) = _oracle.prices(_oracle.SHORT_WINDOW());
        return _inSynth(FixedPointMathLib.min(FixedPointMathLib.min(window, short), _oracle.spot()));
    }

    // SYNTH per TAC (1e18-scaled) at the liquidation view.
    function _liqUsdPerTac() internal view returns (uint256) {
        (, uint256 window) = _oracle.prices(_oracle.MAX_WINDOW());
        (, uint256 short) = _oracle.prices(_oracle.SHORT_WINDOW());
        return _inSynth(FixedPointMathLib.max(window, short));
    }

    // SYNTH per TAC (1e18-scaled) at the offer view: the liquidation view, or the newest recorded interval's price
    // when that is higher, so a rally the medians have not caught up with cannot sell TAC at a stale price.
    function _offerUsdPerTac() internal view returns (uint256) {
        return FixedPointMathLib.max(_liqUsdPerTac(), _inSynth(_oracle.latest()));
    }

    // The venues' ETH depth in SYNTH: the smallest recorded over the longest window, so depth lifted for part of
    // the window cannot raise the cap.
    function _depth() internal view returns (uint256) {
        return _inSynth(_oracle.depthMin(_oracle.MAX_WINDOW()));
    }

    // SYNTH per TAC (1e18-scaled) at the recovery view.
    function _recoveryUsdPerTac() internal view returns (uint256) {
        return _inSynth(
            FixedPointMathLib.max(_oracle.recovery(_oracle.MAX_WINDOW()), _oracle.recovery(_oracle.SHORT_WINDOW()))
        );
    }

    // An ETH amount (or ETH per TAC) in SYNTH through ETH_USD, refusing a bad or stale answer.
    function _inSynth(uint256 eth) internal view returns (uint256) {
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = ETH_USD.latestRoundData();
        if (answer <= 0) revert BadFeed();
        if (updatedAt == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > FEED_MAX_STALENESS) {
            revert StaleFeed();
        }
        if (answeredInRound < roundId) revert StaleFeed();
        // forge-lint: disable-next-line(unsafe-typecast)
        return eth * uint256(answer) / ETH_USD_SCALE;
    }
}
