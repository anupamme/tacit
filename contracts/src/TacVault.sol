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
/// @notice Borrow SYNTH against TAC. SYNTH is a TacSynth this contract deploys and alone mints; it tracks whatever
///         `ETH_USD` prices ETH in (a dollar with an ETH/USD feed, ETH itself with a feed fixed at 1.0). Each address
///         has one vault: deposit TAC, borrow, repay, withdraw. There is no interest.
///
///         Prices. The oracle gives ETH per TAC over a past window as a low and a high median of proven
///         end-of-block prices (`prices(window)`, `recovery(window)`), the newest of them (`latest()`) and now
///         (`spot()`); `ETH_USD` converts them. With two TAC venues behind it, each oracle value is the one that takes
///         moving both venues to move, except that a venue that has stopped tracking the market (retired, drained or
///         frozen) pins the liquidation, recovery, offer and redemption prices. LIQ_WINDOW is the oracle's longest
///         window. Views:
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
///         recorded: borrowing waits for the keeper to catch up). The cap limits new borrowing only; debt already
///         open stays when depth falls.
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
///         TAC_SINK. Anyone may send SYNTH to the reserve, and only `absorb` spends it, so what is sent stays out
///         of circulation; seed it from a dedicated vault that is never meant to close.
///
///         Fees:
///           - Borrowing adds `borrowFeeBps` of the amount to the debt, minted to FEE_TO. The owner sets the fee up
///             to MAX_BORROW_FEE_BPS; a borrower caps it with `maxFeeBps`.
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
///         The owner (transferable) sets only the debt ceiling and the borrow fee. Everything else is immutable.
contract TacVault is Ownable, Multicallable {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;
    uint256 public constant MAX_BORROW_FEE_BPS = 500;

    bytes32 public constant BORROW = keccak256(
        "Borrow(address owner,uint256 amount,uint256 maxFeeBps,uint256 minCollateral,address to,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant WITHDRAW =
        keccak256("Withdraw(address owner,uint256 amount,address to,uint256 nonce,uint256 deadline)");

    address public immutable TAC;
    TacSynth public immutable SYNTH;
    ITacVaultOracle public immutable ORACLE;
    ITacVaultFeed public immutable ETH_USD;
    uint256 internal immutable ETH_USD_SCALE;
    uint256 public immutable MINT_RATIO_BPS;
    uint256 public immutable LIQ_RATIO_BPS;
    uint256 public immutable LIQ_WINDOW;
    uint256 public immutable LIQ_BONUS_BPS;
    uint256 public immutable AUCTION_DURATION;
    uint256 public immutable OWNER_WINDOW;
    uint256 public immutable MIN_DEBT;
    uint256 public immutable FEED_MAX_STALENESS;
    uint256 public immutable REDEMPTION_FEE_BPS;
    uint256 public immutable DEPTH_BPS;
    address public immutable TAC_SINK;
    address public immutable FEE_TO;

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

    mapping(address => Vault) public vaults;
    mapping(address => uint256) public nonces;
    uint256 public totalDebt;
    uint256 public debtCeiling;
    uint256 public borrowFeeBps;

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

    constructor(Config memory c) {
        if (c.tac.code.length == 0 || c.oracle.code.length == 0 || c.ethUsd.code.length == 0) revert BadConfig();
        if (c.owner == address(0) || c.tacSink == address(0) || c.feeTo == address(0)) revert BadConfig();
        if (ITacVaultToken(c.tac).decimals() != 18) revert BadConfig();
        if (c.liqRatioBps < BPS || c.mintRatioBps <= c.liqRatioBps || c.mintRatioBps > 100_000) revert BadConfig();
        if (c.liqBonusBps == 0 || BPS + c.liqBonusBps >= c.liqRatioBps) revert BadConfig();
        if (c.auctionDuration == 0 || c.ownerWindow >= c.auctionDuration) revert BadConfig();
        if (c.feedMaxStaleness == 0 || c.minDebt == 0) revert BadConfig();
        if (c.redemptionFeeBps > 250 || c.borrowFeeBps > MAX_BORROW_FEE_BPS) revert BadConfig();
        if (c.depthBps == 0 || c.depthBps > BPS) revert BadConfig();
        // The liquidation, recovery and offer views then all read the same windows and have a price together.
        if (c.liqWindow != ITacVaultOracle(c.oracle).MAX_WINDOW()) revert BadConfig();
        uint8 feedDecimals = ITacVaultFeed(c.ethUsd).decimals();
        if (feedDecimals > 18) revert BadConfig();

        TAC = c.tac;
        SYNTH = new TacSynth(c.name, c.symbol);
        ORACLE = ITacVaultOracle(c.oracle);
        ETH_USD = ITacVaultFeed(c.ethUsd);
        ETH_USD_SCALE = 10 ** uint256(feedDecimals);
        MINT_RATIO_BPS = c.mintRatioBps;
        LIQ_RATIO_BPS = c.liqRatioBps;
        LIQ_WINDOW = c.liqWindow;
        LIQ_BONUS_BPS = c.liqBonusBps;
        AUCTION_DURATION = c.auctionDuration;
        OWNER_WINDOW = c.ownerWindow;
        MIN_DEBT = c.minDebt;
        FEED_MAX_STALENESS = c.feedMaxStaleness;
        REDEMPTION_FEE_BPS = c.redemptionFeeBps;
        DEPTH_BPS = c.depthBps;
        TAC_SINK = c.tacSink;
        FEE_TO = c.feeTo;
        _initializeOwner(c.owner);
        debtCeiling = c.debtCeiling;
        borrowFeeBps = c.borrowFeeBps;
        emit DebtCeilingSet(c.debtCeiling);
        emit BorrowFeeSet(c.borrowFeeBps);
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
        if (debt != 0 && debt < MIN_DEBT) revert BadAmount();
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
        if (debt < MIN_DEBT) revert BadAmount();
        uint256 total = totalDebt + amount + fee;
        if (total > debtCeiling || total * BPS > _depth() * DEPTH_BPS) revert OverCeiling();
        v.debt = debt;
        totalDebt = total;
        _requireBorrowHealthy(v);
        SYNTH.mint(to, amount);
        if (fee != 0) SYNTH.mint(FEE_TO, fee);
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
        Vault storage v = vaults[owner];
        if (v.auctionStart != 0) revert InAuction();
        if (v.debt == 0 || _value(v.collateral, _liqUsdPerTac()) * BPS >= v.debt * LIQ_RATIO_BPS) revert Healthy();
        v.auctionStart = block.timestamp;
        emit AuctionStarted(owner, v.debt, v.collateral);
    }

    /// Ends the auction on `owner`'s vault once it has recovered (see `recovered`).
    function cancel(address owner) external {
        Vault storage v = vaults[owner];
        if (v.auctionStart == 0) revert NoAuction();
        if (_value(v.collateral, _recoveryUsdPerTac()) * BPS < v.debt * LIQ_RATIO_BPS) revert StillUnhealthy();
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
            uint256 elapsed = FixedPointMathLib.min(block.timestamp - v.auctionStart, AUCTION_DURATION);
            uint256 bonus = LIQ_BONUS_BPS * elapsed / AUCTION_DURATION;
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
            if (block.timestamp < v.auctionStart + OWNER_WINDOW) revert OwnerWindow();
            if (!priced) revert NoPrice();
            try this.recovered(owner) returns (bool ok) {
                if (ok) revert Healthy();
            } catch {
                revert NoPrice();
            }
        }
        uint256 debt = v.debt;
        amount = FixedPointMathLib.min(amount, debt);
        if (amount == 0 || (debt - amount != 0 && debt - amount < MIN_DEBT)) revert BadAmount();
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
    /// same share of its TAC to TAC_SINK.
    function absorb(address owner) external {
        Vault storage v = vaults[owner];
        if (v.auctionStart == 0) revert NoAuction();
        if (block.timestamp - v.auctionStart < AUCTION_DURATION) revert TooEarly();
        uint256 debt = v.debt;
        if (_value(v.collateral, _liqUsdPerTac()) >= debt) revert Healthy();
        uint256 amount = SYNTH.balanceOf(address(this));
        // A partial absorb leaves at least MIN_DEBT.
        if (amount < debt) amount = FixedPointMathLib.min(amount, debt - MIN_DEBT);
        else amount = debt;
        if (amount == 0) revert BadAmount();
        uint256 tac = v.collateral * amount / debt;
        v.debt = debt - amount;
        v.collateral -= tac;
        totalDebt -= amount;
        _tryEnd(owner, v);
        SYNTH.approve(address(this), amount);
        SYNTH.burnFrom(address(this), amount);
        SafeTransferLib.safeTransfer(TAC, TAC_SINK, tac);
        emit Absorbed(owner, amount, tac);
    }

    // ─────────────── redemption ───────────────

    /// Burns `amount` of the caller's SYNTH against `owner`'s debt for that value of its TAC at the redemption
    /// view, less the redemption fee (see the contract notes), which stays in the vault. The vault must be between
    /// LIQ_RATIO_BPS and twice that at the liquidation view and not in an auction, and the debt left zero or at
    /// least MIN_DEBT.
    function redeem(address owner, uint256 amount, uint256 minTac) external returns (uint256 tac) {
        Vault storage v = vaults[owner];
        if (v.auctionStart != 0) revert InAuction();
        if (amount == 0 || amount > v.debt) revert BadAmount();
        uint256 debt = v.debt - amount;
        if (debt != 0 && debt < MIN_DEBT) revert BadAmount();
        uint256 liqUsd = _liqUsdPerTac();
        uint256 ratio = _value(v.collateral, liqUsd) * BPS / v.debt;
        if (ratio < LIQ_RATIO_BPS) revert StillUnhealthy();
        if (ratio >= 2 * LIQ_RATIO_BPS) revert Healthy();
        uint256 usdPerTac = _offerUsdPerTac();
        uint256 fee = REDEMPTION_FEE_BPS + REDEMPTION_FEE_BPS * 3 * (ratio - LIQ_RATIO_BPS) / LIQ_RATIO_BPS;
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
        return _depth() * DEPTH_BPS / BPS;
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
        return _value(v.collateral, _liqUsdPerTac()) * BPS >= v.debt * LIQ_RATIO_BPS;
    }

    /// Whether `owner`'s vault is at or above LIQ_RATIO_BPS at the recovery view: then its auction ends, and
    /// outsiders may not bid.
    function recovered(address owner) external view returns (bool) {
        Vault storage v = vaults[owner];
        return _value(v.collateral, _recoveryUsdPerTac()) * BPS >= v.debt * LIQ_RATIO_BPS;
    }

    function _value(uint256 tac, uint256 usdPerTac) internal pure returns (uint256) {
        return FixedPointMathLib.fullMulDiv(tac, usdPerTac, WAD);
    }

    function _requireBorrowHealthy(Vault storage v) internal view {
        if (v.debt * MINT_RATIO_BPS > _value(v.collateral, _borrowUsdPerTac()) * BPS) revert Undercollateralized();
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
        (uint256 window,) = ORACLE.prices(ORACLE.WINDOW());
        (uint256 short,) = ORACLE.prices(ORACLE.SHORT_WINDOW());
        return _inSynth(FixedPointMathLib.min(FixedPointMathLib.min(window, short), ORACLE.spot()));
    }

    // SYNTH per TAC (1e18-scaled) at the liquidation view.
    function _liqUsdPerTac() internal view returns (uint256) {
        (, uint256 window) = ORACLE.prices(LIQ_WINDOW);
        (, uint256 short) = ORACLE.prices(ORACLE.SHORT_WINDOW());
        return _inSynth(FixedPointMathLib.max(window, short));
    }

    // SYNTH per TAC (1e18-scaled) at the offer view: the liquidation view, or the newest recorded interval's price
    // when that is higher, so a rally the medians have not caught up with cannot sell TAC at a stale price.
    function _offerUsdPerTac() internal view returns (uint256) {
        return FixedPointMathLib.max(_liqUsdPerTac(), _inSynth(ORACLE.latest()));
    }

    // The venues' ETH depth in SYNTH: the smallest recorded over the longest window, so depth lifted for part of
    // the window cannot raise the cap.
    function _depth() internal view returns (uint256) {
        return _inSynth(ORACLE.depthMin(ORACLE.MAX_WINDOW()));
    }

    // SYNTH per TAC (1e18-scaled) at the recovery view.
    function _recoveryUsdPerTac() internal view returns (uint256) {
        return _inSynth(FixedPointMathLib.max(ORACLE.recovery(LIQ_WINDOW), ORACLE.recovery(ORACLE.SHORT_WINDOW())));
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
