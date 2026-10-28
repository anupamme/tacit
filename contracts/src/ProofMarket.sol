// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {EIP712} from "solady/utils/EIP712.sol";
import {ECDSA} from "solady/utils/ECDSA.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface ISettlePool {
    function settle(bytes calldata publicValues, bytes calldata proofBytes, bytes[] calldata memos) external;
}

interface IERC2612 {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

/// @title ProofMarket — pay in TAC for an entry op to be proved and settled, only if the pool accepts it
/// @notice A holder who wants a public/entry op (a wrap, a zap's share, a voucher: anything that carries no
///         secret and that anyone may settle) done fast signs an INTENT: the op's id (the keccak of its public
///         values, which the client knows before any proof exists), the most TAC they will pay, and how the
///         price rises from a floor to that most over time. Any prover (Tacit's own box first, then anyone) may
///         `claim` the op, which fixes the price and gives it an exclusive window, then `fulfill` it: in ONE
///         transaction the pool settles the proof and the prover is paid the claimed price in TAC, pulled from
///         the payer. If the pool refuses the proof the whole call reverts, so TAC moves only when the pool has
///         accepted exactly the op the payer signed for.
/// @dev    TWO WAYS TO AUTHORISE. Direct: the payer signs the intent and a TAC permit for that op's most. Tank (a
///         "proof tank", like a gas tank): the payer signs ONE package once, a `Tank` naming a delegate key (the
///         page's session key), a total `cap`, a per-op `perOpMax` and an expiry, plus one permit for `cap`; the
///         delegate then signs each op's intent silently. The contract counts what each tank has paid and never
///         pulls past `cap`, and the allowance itself is capped by the permit, so a tank can neither be drained
///         nor overdrawn. The payer can `revokeTank` or `cancel` an op at any time (or set the allowance to 0).
///         Non-custodial: TAC goes payer -> prover directly, nothing is held or escrowed here. The payer's
///         authority is the intent signature plus a TAC (ERC-2612) permit, so a payer needs no prior approval
///         and pays no gas. Scope: ops whose settle carries NO fee legs paid to the settler (the settle runs with
///         msg.sender == this contract); a native-ETH fee leg is passed on to the prover, a fee in any other
///         asset would strand, so provers build such proofs fee-free (same rule as the router's wrapAndSettle*).
///         A wallet permit suits public ops only: on a private op it would link the wallet to the op, so those
///         keep their fee inside the pool.
contract ProofMarket is EIP712 {
    struct Intent {
        address payer; // pays the TAC (signs this intent and the permit)
        bytes32 opId; // keccak256(publicValues): the one op this pays for
        uint256 floorFee; // price at `start`, in TAC base units
        uint256 maxFee; // price from `start + rampSecs` on; also the permit's value
        uint64 start; // when the price begins to rise
        uint64 rampSecs; // seconds from floor to max (0: always max)
        uint64 deadline; // after this nothing is claimed or fulfilled (and the permit's deadline)
    }

    struct Tank {
        address payer; // whose TAC it is; signs the tank and the permit
        address delegate; // the key that may sign intents against this tank (the page's session key)
        uint256 cap; // the most this tank ever pays out in total; also the permit's value
        uint256 perOpMax; // no single op may be priced above this
        uint64 expiry; // after this the tank pays nothing (and is the permit's deadline)
        uint256 salt; // lets one payer sign several tanks
    }

    struct Claim {
        address solver;
        uint64 until;
        uint256 price;
    }

    bytes32 public constant INTENT_TYPEHASH =
        keccak256("Intent(address payer,bytes32 opId,uint256 floorFee,uint256 maxFee,uint64 start,uint64 rampSecs,uint64 deadline)");

    bytes32 public constant TANK_TYPEHASH =
        keccak256("Tank(address payer,address delegate,uint256 cap,uint256 perOpMax,uint64 expiry,uint256 salt)");

    address public immutable POOL;
    address public immutable TAC;
    /// How long a claim excludes everyone else, seconds.
    uint64 public immutable CLAIM_WINDOW;

    mapping(bytes32 opId => Claim) public claims;
    mapping(bytes32 opId => bool) public done;
    mapping(address payer => mapping(bytes32 opId => bool)) public cancelled;
    mapping(bytes32 tankId => uint256) public spent;
    mapping(bytes32 tankId => bool) public tankRevoked;

    error BadConfig();
    error BadSignature();
    error Expired();
    error Cancelled();
    error AlreadyDone();
    error WrongOp();
    error Claimed();
    error BadPrice();
    error TankRevoked();
    error TankSpent();
    error NotPayer();

    event Claimed_(bytes32 indexed opId, address indexed solver, uint256 price, uint64 until);
    event Fulfilled(bytes32 indexed opId, address indexed payer, address indexed solver, uint256 price);
    event Cancel(address indexed payer, bytes32 indexed opId);
    event TankRevoked_(address indexed payer, bytes32 indexed tankId);

    constructor(address pool, address tac, uint64 claimWindow) {
        if (pool == address(0) || pool.code.length == 0 || tac == address(0) || tac.code.length == 0 || claimWindow == 0) {
            revert BadConfig();
        }
        POOL = pool;
        TAC = tac;
        CLAIM_WINDOW = claimWindow;
    }

    /// Lets `settle` pay this contract a native-ETH fee leg, which `fulfill` hands to the prover.
    receive() external payable {}

    function _domainNameAndVersion() internal pure override returns (string memory, string memory) {
        return ("TacitProofMarket", "1");
    }

    /// The price at `ts`: the floor, rising in a straight line to the max over `rampSecs`.
    function priceAt(Intent calldata i, uint256 ts) public pure returns (uint256) {
        if (i.rampSecs == 0) return i.maxFee;
        if (ts <= i.start) return i.floorFee;
        uint256 el = ts - i.start;
        if (el >= i.rampSecs) return i.maxFee;
        return i.floorFee + ((i.maxFee - i.floorFee) * el) / i.rampSecs;
    }

    function intentHash(Intent calldata i) public view returns (bytes32) {
        return _hashTypedData(
            keccak256(abi.encode(INTENT_TYPEHASH, i.payer, i.opId, i.floorFee, i.maxFee, i.start, i.rampSecs, i.deadline))
        );
    }

    /// The payer withdraws an intent (a claim already made still runs out its window, but cannot be fulfilled).
    function cancel(bytes32 opId) external {
        cancelled[msg.sender][opId] = true;
        emit Cancel(msg.sender, opId);
    }

    function tankHash(Tank calldata t) public view returns (bytes32) {
        return _hashTypedData(keccak256(abi.encode(TANK_TYPEHASH, t.payer, t.delegate, t.cap, t.perOpMax, t.expiry, t.salt)));
    }

    /// The payer withdraws a tank: it pays nothing more (what it already paid stays paid).
    function revokeTank(Tank calldata t) external {
        if (msg.sender != t.payer) revert NotPayer();
        bytes32 id = tankHash(t);
        tankRevoked[id] = true;
        emit TankRevoked_(t.payer, id);
    }

    /// Takes the op at the price it has now, for CLAIM_WINDOW seconds: nobody else may fulfill it meanwhile, so
    /// a watcher cannot copy the proof out of the mempool and take the fee. Cheap (no proof is revealed).
    function claim(Intent calldata i, bytes calldata signature) external {
        _checkDirect(i, signature);
        _claim(i);
    }

    function claimFromTank(Tank calldata t, bytes calldata tankSig, Intent calldata i, bytes calldata intentSig) external {
        _checkTank(t, tankSig, i, intentSig);
        _claim(i);
    }

    /// Settles the proof and pays the prover, atomically. The price is the one fixed by this caller's live claim,
    /// else the price now (when nobody else holds a live claim). `v,r,s` is the payer's ERC-2612 permit to this
    /// contract (value maxFee, deadline); it is tried and ignored if it fails (an allowance may already stand), and
    /// the pull then reverts if the allowance is not there.
    function fulfill(
        Intent calldata i,
        bytes calldata signature,
        bytes calldata publicValues,
        bytes calldata proofBytes,
        bytes[] calldata memos,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _checkDirect(i, signature);
        _run(i, bytes32(0), 0, i.maxFee, i.deadline, publicValues, proofBytes, memos, v, r, s);
    }

    /// The same out of a tank: the permit is the tank's (value `cap`, deadline `expiry`), signed once; every op
    /// after the first rides the allowance it left. The tank's running total can never pass its `cap`.
    function fulfillFromTank(
        Tank calldata t,
        bytes calldata tankSig,
        Intent calldata i,
        bytes calldata intentSig,
        bytes calldata publicValues,
        bytes calldata proofBytes,
        bytes[] calldata memos,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        bytes32 id = _checkTank(t, tankSig, i, intentSig);
        _run(i, id, t.cap, t.cap, t.expiry, publicValues, proofBytes, memos, v, r, s);
    }

    function _claim(Intent calldata i) internal {
        Claim memory c = claims[i.opId];
        if (c.until > block.timestamp && c.solver != msg.sender) revert Claimed();
        uint256 p = priceAt(i, block.timestamp);
        uint64 until = uint64(block.timestamp) + CLAIM_WINDOW;
        claims[i.opId] = Claim(msg.sender, until, p);
        emit Claimed_(i.opId, msg.sender, p, until);
    }

    /// `tankId` 0 = direct. `cap` is the tank's total (checked against `spent`); `permitValue`/`permitDeadline` are
    /// what the payer's permit covers.
    function _run(
        Intent calldata i,
        bytes32 tankId,
        uint256 cap,
        uint256 permitValue,
        uint64 permitDeadline,
        bytes calldata publicValues,
        bytes calldata proofBytes,
        bytes[] calldata memos,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        if (keccak256(publicValues) != i.opId) revert WrongOp();
        Claim memory c = claims[i.opId];
        uint256 price;
        if (c.until > block.timestamp) {
            if (c.solver != msg.sender) revert Claimed();
            price = c.price;
        } else {
            price = priceAt(i, block.timestamp);
        }
        if (price > i.maxFee) revert BadPrice();
        if (tankId != bytes32(0)) {
            uint256 total = spent[tankId] + price;
            if (total > cap) revert TankSpent();
            spent[tankId] = total;
        }
        done[i.opId] = true;
        delete claims[i.opId];

        try IERC2612(TAC).permit(i.payer, address(this), permitValue, permitDeadline, v, r, s) {} catch {}
        ISettlePool(POOL).settle(publicValues, proofBytes, memos);
        if (price != 0) SafeTransferLib.safeTransferFrom(TAC, i.payer, msg.sender, price);
        uint256 eth = address(this).balance;
        if (eth != 0) SafeTransferLib.safeTransferETH(msg.sender, eth);
        emit Fulfilled(i.opId, i.payer, msg.sender, price);
    }

    function _checkDirect(Intent calldata i, bytes calldata signature) internal view {
        _checkIntent(i);
        if (ECDSA.recoverCalldata(intentHash(i), signature) != i.payer) revert BadSignature();
    }

    function _checkTank(Tank calldata t, bytes calldata tankSig, Intent calldata i, bytes calldata intentSig)
        internal
        view
        returns (bytes32 id)
    {
        _checkIntent(i);
        id = tankHash(t);
        if (tankRevoked[id]) revert TankRevoked();
        if (block.timestamp > t.expiry) revert Expired();
        if (i.payer != t.payer || i.maxFee > t.perOpMax) revert BadPrice();
        if (ECDSA.recoverCalldata(id, tankSig) != t.payer) revert BadSignature();
        if (ECDSA.recoverCalldata(intentHash(i), intentSig) != t.delegate) revert BadSignature();
    }

    function _checkIntent(Intent calldata i) internal view {
        if (block.timestamp > i.deadline) revert Expired();
        if (done[i.opId]) revert AlreadyDone();
        if (cancelled[i.payer][i.opId]) revert Cancelled();
        if (i.floorFee > i.maxFee) revert BadPrice();
    }
}
