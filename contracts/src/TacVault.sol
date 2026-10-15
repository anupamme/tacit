// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

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
/// @notice Borrow SYNTH against TAC. SYNTH is a TacSynth deployed by this vault; priced through an ETH/USD feed it
///         is a dollar, through FixedFeed it is ETH. One vault per address, no interest.
///
///         The oracle gives ETH per TAC as low and high medians of proven end-of-block prices over past windows
///         (`prices`), a recovery price, the newest recorded price (`latest`) and the current price (`spot`);
///         ETH_USD converts them to SYNTH. LIQ_WINDOW is the oracle's longest window. The vault uses four views:
///           - borrow: min(low WINDOW median, low SHORT_WINDOW median, spot). Borrowing and withdrawing must leave
///             a vault at MINT_RATIO_BPS or more.
///           - liquidation: max(high LIQ_WINDOW median, high SHORT_WINDOW median). Below LIQ_RATIO_BPS a vault can
///             be auctioned.
///           - recovery: max(recovery over LIQ_WINDOW, recovery over SHORT_WINDOW). At LIQ_RATIO_BPS or more an
///             auction ends.
///           - offer: max(liquidation view, latest). Auctions and redemptions price TAC here.
///
///         Total debt is capped by `debtCeiling` and by DEPTH_BPS of the venues' smallest ETH depth over LIQ_WINDOW,
///         so capacity follows the pools' liquidity. The cap limits new borrowing only.
///
///         Liquidation is a Dutch auction: a bid repays debt for TAC worth that debt at the offer view plus a bonus
///         that rises from zero to LIQ_BONUS_BPS over AUCTION_DURATION, at most the collateral; a partial bid takes
///         the same share. Only the vault's owner may bid during OWNER_WINDOW. Deposits and repayments continue, and
///         the auction ends once the vault is back at LIQ_RATIO_BPS at the recovery view. After AUCTION_DURATION a
///         vault worth less than its debt can be absorbed: SYNTH held by this contract (the reserve) burns its debt
///         and the same share of its TAC goes to `tacSink`.
///
///         Fees: a one-time borrow fee of `borrowFeeBps`, minted to `feeTo` and capped per call by `maxFeeBps`; and a
///         redemption fee left in the redeemed vault. `redeem` swaps SYNTH for TAC from a vault between LIQ_RATIO_BPS
///         and twice that, at REDEMPTION_FEE_BPS rising to four times that across the range.
///
///         `borrowFor` and `withdrawFor` act on the owner's EIP-712 or ERC-1271 signature; anyone may deposit,
///         repay or bid for any vault.
///
///         Owner powers. At once: the debt ceiling, the borrow and redemption fees, `feeTo`, `tacSink`, the pauser,
///         the pause, and lowering the depth share. After PARAM_DELAY and within fixed limits: raising the depth
///         share, the ratios, the bonus, the owner window, the auction duration and the minimum debt. After
///         ORACLE_DELAY: a new oracle. `lockParams` and `lockOracle` end the delayed powers for good. A pause (by the
///         owner or the pauser) stops `liquidate`, outside bids, `absorb` and `redeem` for at most MAX_PAUSE from its
///         start, and the next pause waits as long as the last one ran.
contract TacVault is Ownable, Multicallable {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;

    uint256 public constant MAX_BORROW_FEE_BPS = 500;
    uint256 public constant MAX_REDEMPTION_FEE_BPS = 250;
    uint256 public constant MAX_DEPTH_BPS = 1_000;
    uint256 public constant MAX_PAUSE = 12 hours;
    uint256 public constant PARAM_DELAY = 2 days;
    uint256 public constant ORACLE_DELAY = 3 days;
    /// How long a change may still be executed after its delay.
    uint256 public constant QUEUE_EXPIRY = 14 days;

    // Limits on the governed terms, at deployment and on every change.
    uint256 internal constant MIN_LIQ_RATIO_BPS = 12_000;
    uint256 internal constant MAX_LIQ_RATIO_BPS = 30_000;
    uint256 internal constant MIN_MARGIN_BPS = 2_000;
    uint256 internal constant MAX_MINT_RATIO_BPS = 100_000;
    uint256 internal constant MAX_BONUS_BPS = 5_000;
    uint256 internal constant MIN_OWNER_WINDOW = 10 minutes;
    uint256 internal constant MAX_OWNER_WINDOW = 1 days;
    uint256 internal constant MIN_AUCTION_DURATION = 30 minutes;
    uint256 internal constant MAX_AUCTION_DURATION = 3 days;
    uint256 internal constant MIN_ORACLE_WINDOW = 1 hours;

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
    /// The deployed minimum debt; changes stay within a tenth to a hundred times it.
    uint256 public immutable MIN_DEBT_BASE;

    // Governed terms, read through the upper-case getters.
    ITacVaultOracle internal _oracle;
    uint256 internal _mintRatioBps;
    uint256 internal _liqRatioBps;
    uint256 internal _liqBonusBps;
    uint256 internal _auctionDuration;
    uint256 internal _ownerWindow;
    uint256 internal _minDebt;
    uint256 internal _redemptionFeeBps;
    uint256 internal _depthBps;

    struct Vault {
        uint256 collateral; // TAC
        uint256 debt; // SYNTH
        uint256 auctionStart; // 0 when no auction runs
    }

    struct Config {
        address tac;
        address oracle;
        address ethUsd;
        address owner;
        uint256 mintRatioBps;
        uint256 liqRatioBps;
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

    /// The terms changed through `queueParam` / `executeParam`.
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

    mapping(address => Vault) public vaults;
    mapping(address => uint256) public nonces;
    uint256 public totalDebt;
    uint256 public debtCeiling;
    uint256 public borrowFeeBps;
    address public feeTo;
    address public tacSink;
    address public pauser;
    uint256 public pausedFrom;
    uint256 public pausedUntil;
    // Seconds spent in pauses that have ended, before the latest one.
    uint256 internal _pausedBefore;

    mapping(Param => Queued) public queuedParam;
    address public pendingOracle;
    uint256 public pendingOracleEta;
    bool public paramsLocked;
    bool public oracleLocked;

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
    error MintersRemain();

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
    event RedemptionFeeSet(uint256 bps);
    event FeeToSet(address to);
    event TacSinkSet(address to);
    event PauserSet(address to);
    event AuctionsPausedUntil(uint256 until);
    event ParamQueued(Param indexed id, uint256 value, uint256 eta);
    event ParamSet(Param indexed id, uint256 value);
    event ParamCancelled(Param indexed id);
    event OracleQueued(address indexed oracle, uint256 eta);
    event OracleSet(address indexed oracle);
    event OracleCancelled(address indexed oracle);
    event ParamsLocked();
    event OracleLocked();

    constructor(Config memory c) {
        if (c.tac.code.length == 0 || c.ethUsd.code.length == 0) revert BadConfig();
        if (c.owner == address(0) || c.tacSink == address(0) || c.feeTo == address(0)) revert BadConfig();
        if (ITacVaultToken(c.tac).decimals() != 18 || c.feedMaxStaleness == 0 || c.minDebt == 0) revert BadConfig();
        if (c.redemptionFeeBps > MAX_REDEMPTION_FEE_BPS || c.borrowFeeBps > MAX_BORROW_FEE_BPS) revert BadConfig();
        _checkWindows(ITacVaultOracle(c.oracle));
        uint8 feedDecimals = ITacVaultFeed(c.ethUsd).decimals();
        if (feedDecimals > 18) revert BadConfig();

        TAC = c.tac;
        SYNTH = new TacSynth(c.name, c.symbol);
        ETH_USD = ITacVaultFeed(c.ethUsd);
        ETH_USD_SCALE = 10 ** uint256(feedDecimals);
        FEED_MAX_STALENESS = c.feedMaxStaleness;
        MIN_DEBT_BASE = c.minDebt;

        _oracle = ITacVaultOracle(c.oracle);
        _mintRatioBps = c.mintRatioBps;
        _liqRatioBps = c.liqRatioBps;
        _liqBonusBps = c.liqBonusBps;
        _auctionDuration = c.auctionDuration;
        _ownerWindow = c.ownerWindow;
        _minDebt = c.minDebt;
        _redemptionFeeBps = c.redemptionFeeBps;
        _depthBps = c.depthBps;
        _validate(Param.DepthBps, c.depthBps);
        _validate(Param.MintRatioBps, c.mintRatioBps);
        _validate(Param.LiqRatioBps, c.liqRatioBps);
        _validate(Param.LiqBonusBps, c.liqBonusBps);
        _validate(Param.OwnerWindow, c.ownerWindow);
        _validate(Param.AuctionDuration, c.auctionDuration);

        _initializeOwner(c.owner);
        debtCeiling = c.debtCeiling;
        borrowFeeBps = c.borrowFeeBps;
        feeTo = c.feeTo;
        tacSink = c.tacSink;
        emit DebtCeilingSet(c.debtCeiling);
        emit BorrowFeeSet(c.borrowFeeBps);
        emit FeeToSet(c.feeTo);
        emit TacSinkSet(c.tacSink);
    }

    // ─────────────── owner: immediate ───────────────

    function setDebtCeiling(uint256 ceiling) external onlyOwner {
        debtCeiling = ceiling;
        emit DebtCeilingSet(ceiling);
    }

    function setBorrowFee(uint256 bps) external onlyOwner {
        if (bps > MAX_BORROW_FEE_BPS) revert BadConfig();
        borrowFeeBps = bps;
        emit BorrowFeeSet(bps);
    }

    function setRedemptionFee(uint256 bps) external onlyOwner {
        if (bps > MAX_REDEMPTION_FEE_BPS) revert BadConfig();
        _redemptionFeeBps = bps;
        emit RedemptionFeeSet(bps);
    }

    function setFeeTo(address to) external onlyOwner {
        if (to == address(0)) revert BadConfig();
        feeTo = to;
        emit FeeToSet(to);
    }

    function setTacSink(address to) external onlyOwner {
        if (to == address(0)) revert BadConfig();
        tacSink = to;
        emit TacSinkSet(to);
    }

    /// Names an address that may start or lengthen a pause and do nothing else (zero for none).
    function setPauser(address to) external onlyOwner {
        pauser = to;
        emit PauserSet(to);
    }

    /// Ends every owner power, including the synth's: it needs the synth to have no further minter, which no one
    /// could remove afterwards. Also removes the pauser.
    function renounceOwnership() public payable override onlyOwner {
        if (SYNTH.minterCount() != 0) revert MintersRemain();
        if (pauser != address(0)) {
            pauser = address(0);
            emit PauserSet(address(0));
        }
        super.renounceOwnership();
    }

    /// Lowers the share of depth the vault may lend. Raising it goes through `queueParam`. Ends with `lockParams`;
    /// `setDebtCeiling` is the brake that stays.
    function lowerDepthBps(uint256 bps) external onlyOwner {
        if (paramsLocked) revert Locked();
        if (bps >= _depthBps) revert BadConfig();
        _depthBps = bps;
        emit ParamSet(Param.DepthBps, bps);
    }

    /// Pauses `liquidate`, outside bids, `absorb` and `redeem` until `duration` from now. A running pause can only
    /// be lengthened, to at most MAX_PAUSE after it began; a new one waits as long after the last as that one ran.
    function pauseAuctions(uint256 duration) external {
        if (msg.sender != owner() && msg.sender != pauser) revert Unauthorized();
        if (duration == 0 || duration > MAX_PAUSE) revert BadConfig();
        uint256 until = block.timestamp + duration;
        if (block.timestamp < pausedUntil) {
            if (until <= pausedUntil || until > pausedFrom + MAX_PAUSE) revert BadConfig();
        } else {
            if (block.timestamp < 2 * pausedUntil - pausedFrom) revert PauseCooldown();
            _pausedBefore += pausedUntil - pausedFrom;
            pausedFrom = block.timestamp;
        }
        pausedUntil = until;
        emit AuctionsPausedUntil(until);
    }

    /// Ends the running pause now.
    function resumeAuctions() external onlyOwner {
        if (block.timestamp >= pausedUntil) revert BadConfig();
        pausedUntil = block.timestamp;
        emit AuctionsPausedUntil(block.timestamp);
    }

    function paused() public view returns (bool) {
        return block.timestamp < pausedUntil;
    }

    /// The clock auctions run on: the time, less the time spent paused. A pause stops the owner window, the bonus
    /// and the wait before `absorb`. `vaults(owner).auctionStart` is a reading of it.
    function auctionTime() public view returns (uint256) {
        return block.timestamp - _pausedBefore - (FixedPointMathLib.min(block.timestamp, pausedUntil) - pausedFrom);
    }

    // ─────────────── owner: delayed ───────────────

    /// Announces a new value for a term, applied by `executeParam` after PARAM_DELAY. Replaces any earlier
    /// announcement for that term.
    function queueParam(Param id, uint256 value) external onlyOwner {
        if (paramsLocked) revert Locked();
        if (value > type(uint192).max) revert BadConfig();
        _validate(id, value);
        uint256 eta = block.timestamp + PARAM_DELAY;
        queuedParam[id] = Queued(uint192(value), uint64(eta));
        emit ParamQueued(id, value, eta);
    }

    /// Applies an announced value, checked again against the other terms as they are now.
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

    /// Ends `queueParam` and `lowerDepthBps` for good and drops what is announced.
    function lockParams() external onlyOwner {
        paramsLocked = true;
        for (uint256 i; i <= uint256(type(Param).max); ++i) {
            delete queuedParam[Param(i)];
        }
        emit ParamsLocked();
    }

    /// Announces a new oracle, put in place by `executeOracle` after ORACLE_DELAY.
    function queueOracle(address oracle) external onlyOwner {
        if (oracleLocked) revert Locked();
        if (oracle == address(_oracle)) revert BadConfig();
        _checkWindows(ITacVaultOracle(oracle));
        pendingOracle = oracle;
        pendingOracleEta = block.timestamp + ORACLE_DELAY;
        emit OracleQueued(oracle, pendingOracleEta);
    }

    /// Puts the announced oracle in place if it prices every view the vault reads and its WINDOW high median is
    /// within a factor of three of the current oracle's WINDOW low or high median. The check catches a wrong
    /// address or scale; the delay and `lockOracle` are the protection against a deliberately bad oracle.
    function executeOracle() external onlyOwner {
        if (oracleLocked) revert Locked();
        address next = pendingOracle;
        if (next == address(0)) revert NothingQueued();
        if (block.timestamp < pendingOracleEta) revert TooEarly();
        if (block.timestamp > pendingOracleEta + QUEUE_EXPIRY) revert Expired();
        ITacVaultOracle o = ITacVaultOracle(next);
        if (!_continuous(_answers(o))) revert BadConfig();
        delete pendingOracle;
        delete pendingOracleEta;
        _oracle = o;
        emit OracleSet(next);
    }

    function cancelOracle() external onlyOwner {
        address next = pendingOracle;
        if (next == address(0)) revert NothingQueued();
        delete pendingOracle;
        delete pendingOracleEta;
        emit OracleCancelled(next);
    }

    /// Ends `queueOracle` for good and drops what is announced.
    function lockOracle() external onlyOwner {
        oracleLocked = true;
        delete pendingOracle;
        delete pendingOracleEta;
        emit OracleLocked();
    }

    // The limits on term `id` taking value `v`, given the other terms as they are.
    function _validate(Param id, uint256 v) internal view {
        if (id == Param.DepthBps) {
            // At most doubling (plus 25) per change.
            if (v > MAX_DEPTH_BPS || v > 2 * _depthBps + 25) revert BadConfig();
        } else if (id == Param.MintRatioBps) {
            if (v > MAX_MINT_RATIO_BPS || v < _liqRatioBps + MIN_MARGIN_BPS) revert BadConfig();
        } else if (id == Param.LiqRatioBps) {
            if (
                v < MIN_LIQ_RATIO_BPS || v > MAX_LIQ_RATIO_BPS || _mintRatioBps < v + MIN_MARGIN_BPS
                    || BPS + _liqBonusBps >= v
            ) revert BadConfig();
        } else if (id == Param.LiqBonusBps) {
            if (v == 0 || v > MAX_BONUS_BPS || BPS + v >= _liqRatioBps) revert BadConfig();
        } else if (id == Param.OwnerWindow) {
            if (v < MIN_OWNER_WINDOW || v > MAX_OWNER_WINDOW || v >= _auctionDuration) revert BadConfig();
        } else if (id == Param.AuctionDuration) {
            if (v < MIN_AUCTION_DURATION || v > MAX_AUCTION_DURATION || _ownerWindow >= v) revert BadConfig();
        } else if (v == 0 || v < MIN_DEBT_BASE / 10 || v > MIN_DEBT_BASE * 100) {
            revert BadConfig();
        }
    }

    function _checkWindows(ITacVaultOracle o) internal view returns (uint256 short, uint256 window, uint256 max) {
        if (address(o).code.length == 0) revert BadConfig();
        (short, window, max) = (o.SHORT_WINDOW(), o.WINDOW(), o.MAX_WINDOW());
        if (short == 0 || window < short || max < window || max < MIN_ORACLE_WINDOW) revert BadConfig();
    }

    // Reverts unless `o` gives a price on every view the vault reads, with lows not above highs; returns its WINDOW
    // high median.
    function _answers(ITacVaultOracle o) internal view returns (uint256 high) {
        (uint256 short, uint256 window, uint256 max) = _checkWindows(o);
        uint256[3] memory ws = [short, window, max];
        for (uint256 i; i < 3; ++i) {
            (uint256 lo, uint256 hi) = o.prices(ws[i]);
            if (lo == 0 || hi == 0 || o.recovery(ws[i]) == 0) revert NoPrice();
            if (lo > hi) revert BadConfig();
            if (i == 1) high = hi;
        }
        if (o.spot() == 0 || o.latest() == 0 || o.depthMin(max) == 0) revert NoPrice();
    }

    // Whether `price` is within a factor of three of the current oracle's WINDOW low or high median. Its spot is
    // not used, since a trade in the same block moves it. A current oracle without medians imposes nothing, so a
    // broken one can be replaced.
    function _continuous(uint256 price) internal view returns (bool) {
        ITacVaultOracle old = _oracle;
        bool anchored;
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

    // ─────────────── governed terms ───────────────

    function ORACLE() external view returns (ITacVaultOracle) {
        return _oracle;
    }

    function LIQ_WINDOW() external view returns (uint256) {
        return _oracle.MAX_WINDOW();
    }

    function MINT_RATIO_BPS() external view returns (uint256) {
        return _mintRatioBps;
    }

    function LIQ_RATIO_BPS() external view returns (uint256) {
        return _liqRatioBps;
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

    /// Applies the caller's EIP-2612 permit for TAC to this contract; a failing permit (for example one already
    /// used) is ignored.
    function permitTac(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        try IERC2612(TAC).permit(msg.sender, address(this), value, deadline, v, r, s) {} catch {}
    }

    /// As `permitTac`, for SYNTH.
    function permitSynth(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        try IERC2612(address(SYNTH)).permit(msg.sender, address(this), value, deadline, v, r, s) {} catch {}
    }

    // ─────────────── borrower ───────────────

    function deposit(uint256 amount) external {
        _deposit(msg.sender, amount);
    }

    /// Adds the caller's TAC to `owner`'s vault.
    function depositFor(address owner, uint256 amount) external {
        _deposit(owner, amount);
    }

    /// Withdraws up to `amount` of the caller's TAC.
    function withdraw(uint256 amount) external {
        _withdraw(msg.sender, amount, msg.sender);
    }

    /// Withdraws up to `amount` of `owner`'s TAC to `to`, on `owner`'s signature.
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

    /// Borrows for `owner` to `to`, on `owner`'s signature, if the vault holds at least `minCollateral`.
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

    /// Repays up to `amount` of `owner`'s debt from the caller's SYNTH. The debt left must be zero or at least
    /// MIN_DEBT.
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

    function digest(bytes32 structHash) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _useNonce(address owner) internal returns (uint256) {
        return nonces[owner]++;
    }

    // Accepts the owner's own key even when the owner has code (an EIP-7702 account), otherwise ERC-1271.
    function _authorize(bytes32 structHash, address owner, address to, uint256 deadline, bytes calldata sig)
        internal
        view
    {
        if (block.timestamp > deadline) revert Expired();
        if (to == address(0) || owner == address(0)) revert BadAmount();
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
        v.auctionStart = auctionTime();
        emit AuctionStarted(owner, v.debt, v.collateral);
    }

    /// Ends the auction on `owner`'s vault if it has recovered.
    function cancel(address owner) external {
        Vault storage v = vaults[owner];
        if (v.auctionStart == 0) revert NoAuction();
        if (_value(v.collateral, _recoveryUsdPerTac()) * BPS < v.debt * _liqRatioBps) revert StillUnhealthy();
        _end(owner, v);
    }

    /// The TAC a bid for all of `owner`'s debt takes now; without a price, the whole collateral (only the owner
    /// may bid then).
    function onOffer(address owner) public view returns (uint256 tac) {
        if (vaults[owner].auctionStart == 0) return 0;
        (tac,) = _offer(owner);
    }

    function _offer(address owner) internal view returns (uint256 tac, bool priced) {
        Vault storage v = vaults[owner];
        tac = v.collateral;
        try this.offerPrice() returns (uint256 usdPerTac) {
            uint256 elapsed = FixedPointMathLib.min(auctionTime() - v.auctionStart, _auctionDuration);
            uint256 bonus = _liqBonusBps * elapsed / _auctionDuration;
            tac = FixedPointMathLib.min(tac, FixedPointMathLib.fullMulDiv(v.debt * (BPS + bonus) / BPS, WAD, usdPerTac));
            priced = true;
        } catch {}
    }

    /// Repays up to `amount` of `owner`'s debt from the caller's SYNTH for the same share of the TAC on offer,
    /// at least `minTac`. The debt left must be zero or at least MIN_DEBT. Others than the owner may bid only after
    /// OWNER_WINDOW, with an offer price, while the vault has not recovered and auctions are not paused.
    function bid(address owner, uint256 amount, uint256 minTac) external returns (uint256 taken) {
        Vault storage v = vaults[owner];
        if (v.auctionStart == 0) revert NoAuction();
        (uint256 offer, bool priced) = _offer(owner);
        if (msg.sender != owner) {
            if (paused()) revert Paused();
            if (auctionTime() < v.auctionStart + _ownerWindow) revert OwnerWindow();
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

    /// After AUCTION_DURATION, on a vault worth less than its debt at the liquidation view, burns as much of the
    /// debt as the reserve covers and sends the same share of the TAC to `tacSink`. A partial absorb leaves at least
    /// MIN_DEBT, so a vault at or under it is absorbed whole or not at all.
    function absorb(address owner) external {
        if (paused()) revert Paused();
        Vault storage v = vaults[owner];
        if (v.auctionStart == 0) revert NoAuction();
        if (auctionTime() - v.auctionStart < _auctionDuration) revert TooEarly();
        uint256 debt = v.debt;
        if (_value(v.collateral, _liqUsdPerTac()) >= debt) revert Healthy();
        uint256 amount = SYNTH.balanceOf(address(this));
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
        SYNTH.burnFrom(address(this), amount);
        SafeTransferLib.safeTransfer(TAC, tacSink, tac);
        emit Absorbed(owner, amount, tac);
    }

    // ─────────────── redemption ───────────────

    /// Burns `amount` of the caller's SYNTH against `owner`'s debt for that value of its TAC at the offer view, less
    /// the redemption fee, at least `minTac`. The vault must be between LIQ_RATIO_BPS and twice that at the
    /// liquidation view and not in an auction, and the debt left zero or at least MIN_DEBT.
    function redeem(address owner, uint256 amount, uint256 minTac) external returns (uint256 tac) {
        if (paused()) revert Paused();
        Vault storage v = vaults[owner];
        if (v.auctionStart != 0) revert InAuction();
        if (amount == 0 || amount > v.debt) revert BadAmount();
        uint256 debt = v.debt - amount;
        if (debt != 0 && debt < _minDebt) revert BadAmount();
        uint256 ratio = _value(v.collateral, _liqUsdPerTac()) * BPS / v.debt;
        if (ratio < _liqRatioBps) revert StillUnhealthy();
        if (ratio >= 2 * _liqRatioBps) revert Healthy();
        uint256 fee = _redemptionFeeBps + _redemptionFeeBps * 3 * (ratio - _liqRatioBps) / _liqRatioBps;
        tac = FixedPointMathLib.fullMulDiv(amount * (BPS - fee) / BPS, WAD, _offerUsdPerTac());
        if (tac < minTac || tac > v.collateral) revert BadAmount();
        v.debt = debt;
        v.collateral -= tac;
        totalDebt -= amount;
        SYNTH.burnFrom(msg.sender, amount);
        SafeTransferLib.safeTransfer(TAC, msg.sender, tac);
        emit Redeemed(owner, msg.sender, amount, tac);
    }

    // ─────────────── views ───────────────

    /// SYNTH value of `tac` TAC at the borrow view (`forBorrow`) or the liquidation view.
    function valueOf(uint256 tac, bool forBorrow) external view returns (uint256) {
        return _value(tac, forBorrow ? _borrowUsdPerTac() : _liqUsdPerTac());
    }

    /// The total debt the venues' depth allows now (before `debtCeiling`).
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

    /// Whether `owner`'s vault is at or above LIQ_RATIO_BPS at the liquidation view.
    function liqHealthyView(address owner) external view returns (bool) {
        Vault storage v = vaults[owner];
        return _value(v.collateral, _liqUsdPerTac()) * BPS >= v.debt * _liqRatioBps;
    }

    /// Whether `owner`'s vault is at or above LIQ_RATIO_BPS at the recovery view.
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

    // Ends the auction if the vault owes nothing or has recovered. Without a price the auction runs on, so that a
    // deposit or repayment still goes through.
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

    function _borrowUsdPerTac() internal view returns (uint256) {
        (uint256 window,) = _oracle.prices(_oracle.WINDOW());
        (uint256 short,) = _oracle.prices(_oracle.SHORT_WINDOW());
        return _inSynth(FixedPointMathLib.min(FixedPointMathLib.min(window, short), _oracle.spot()));
    }

    function _liqUsdPerTac() internal view returns (uint256) {
        (, uint256 window) = _oracle.prices(_oracle.MAX_WINDOW());
        (, uint256 short) = _oracle.prices(_oracle.SHORT_WINDOW());
        return _inSynth(FixedPointMathLib.max(window, short));
    }

    function _recoveryUsdPerTac() internal view returns (uint256) {
        return _inSynth(
            FixedPointMathLib.max(_oracle.recovery(_oracle.MAX_WINDOW()), _oracle.recovery(_oracle.SHORT_WINDOW()))
        );
    }

    // The latest price lifts the offer when the medians lag a rally, so an auction does not sell TAC below it.
    function _offerUsdPerTac() internal view returns (uint256) {
        return FixedPointMathLib.max(_liqUsdPerTac(), _inSynth(_oracle.latest()));
    }

    function _depth() internal view returns (uint256) {
        return _inSynth(_oracle.depthMin(_oracle.MAX_WINDOW()));
    }

    // ETH (or ETH per TAC) in SYNTH, refusing a non-positive or stale feed answer.
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
