// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {PoseidonT3} from "../lib/PoseidonT3.sol";
import {ITacitEvmPoolRoots} from "./TacitEvmPoolCheckpoints.sol";

/// The single-pool registry this hub wraps (TacitEvmPoolCheckpoints), as the hub reads it.
interface ITacitEvmPoolCheckpoints {
    function POOL() external view returns (address);
    function latest() external view returns (uint256);
    function pointAt(uint256 size) external view returns (uint256 blockNumber, uint256 prev, bytes32[32] memory filled);
    function postedAt(uint256 size) external view returns (uint256);
}

/// @title TacitEvmPoolCheckpointsHub
/// @notice Catch-up points for every TacitEvmPool on a chain, in one registry. A point is the right edge of a pool's
///         incremental Merkle tree (its 32 filled subtrees) at a leaf count, posted by anyone who has read that pool's
///         history that far, with the block at whose end the tree had that count. A post is kept only if the pool named
///         held the root the edge folds to at that count, so every point here is one its pool vouches for, exactly as in
///         the single-pool registry. Points are kept by pool and count, one per count, the first to land: a post for one
///         pool never touches another's. `postMany` takes many points at once and passes over the ones that cannot be
///         kept, and `newest` gives a wallet the newest point of every pool it shows in one read.
///
///         Anyone may post for any address, and an address that vouches for anything is its own pool here: a page reads
///         points only for pools it already trusts, by naming them. The block is the poster's word, as in the single-pool
///         registry; a wallet checks it by reading the pool's events after it, which must start where the point ends, and
///         passes a point whose block was wrong over for the one before it.
///
///         The ETH pool's single-pool registry on this chain is `PREVIOUS`: its points count as this hub's for its pool,
///         so `latest`, `pointAt`, `postedAt` and `newest` read through to it, and a count it holds is not posted again here.
contract TacitEvmPoolCheckpointsHub {
    uint256 internal constant DEPTH = 32;
    /// The most gas a pool's `rootSize` may use in `postMany`. A TacitEvmPool's takes a few thousand: one storage read.
    uint256 internal constant ROOT_GAS = 30_000;

    /// @notice The ETH pool's single-pool registry on this chain, and its pool: its points count as this hub's for that
    ///         pool. Both are zero for a hub that wraps none.
    ITacitEvmPoolCheckpoints public immutable PREVIOUS;
    address public immutable PREVIOUS_POOL;

    struct Point {
        uint64 blockNumber; // the tree had this count at the end of this block, as posted
        uint64 prev; // the pool's newest point when this one was posted, 0 for the first
        uint64 postedAt; // the time of the post (block.timestamp), 0 for a count never posted
        bytes32[32] filled;
    }

    /// A point for `postMany`.
    struct Post {
        address pool;
        uint256 size;
        uint256 blockNumber;
        bytes32[32] filled;
    }

    /// A pool's newest point, as `newest` gives it: all zero for a pool with none.
    struct Newest {
        uint256 size;
        uint256 blockNumber;
        bytes32[32] filled;
    }

    /// Each pool's newest count here (not counting PREVIOUS's), 0 while it has none.
    mapping(address pool => uint256) internal _latest;
    mapping(address pool => mapping(uint256 size => Point)) internal _points;

    event Posted(address indexed pool, uint256 indexed size, uint256 blockNumber, address indexed by);

    error NotEven();
    /// The block named does not fit a uint64.
    error BadBlock();
    error Known();
    /// The pool held the root at another count (it reverts itself for a root it never held).
    error NotHeld();
    /// A batch ran too low on gas to give a pool's read its full allowance. It reverts whole, as running out would, so a
    /// point is passed over only for what its pool answered and never for the gas the batch was sent with.
    error LowGas();

    /// @param previous The ETH pool's single-pool registry on this chain, or zero for none.
    constructor(ITacitEvmPoolCheckpoints previous) {
        PREVIOUS = previous;
        PREVIOUS_POOL = address(previous) == address(0) ? address(0) : previous.POOL();
    }

    /// @notice The empty subtree at each height: 0 for a leaf, then Poseidon of two of the one below.
    function zero(uint256 level) public pure returns (uint256) {
        if (level == 0) return 0x0000000000000000000000000000000000000000000000000000000000000000;
        if (level == 1) return 0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864;
        if (level == 2) return 0x1069673dcdb12263df301a6ff584a7ec261a44cb9dc68df067a4774460b1f1e1;
        if (level == 3) return 0x18f43331537ee2af2e3d758d50f72106467c6eea50371dd528d57eb2b856d238;
        if (level == 4) return 0x07f9d837cb17b0d36320ffe93ba52345f1b728571a568265caac97559dbc952a;
        if (level == 5) return 0x2b94cf5e8746b3f5c9631f4c5df32907a699c58c94b2ad4d7b5cec1639183f55;
        if (level == 6) return 0x2dee93c5a666459646ea7d22cca9e1bcfed71e6951b953611d11dda32ea09d78;
        if (level == 7) return 0x078295e5a22b84e982cf601eb639597b8b0515a88cb5ac7fa8a4aabe3c87349d;
        if (level == 8) return 0x2fa5e5f18f6027a6501bec864564472a616b2e274a41211a444cbe3a99f3cc61;
        if (level == 9) return 0x0e884376d0d8fd21ecb780389e941f66e45e7acce3e228ab3e2156a614fcd747;
        if (level == 10) return 0x1b7201da72494f1e28717ad1a52eb469f95892f957713533de6175e5da190af2;
        if (level == 11) return 0x1f8d8822725e36385200c0b201249819a6e6e1e4650808b5bebc6bface7d7636;
        if (level == 12) return 0x2c5d82f66c914bafb9701589ba8cfcfb6162b0a12acf88a8d0879a0471b5f85a;
        if (level == 13) return 0x14c54148a0940bb820957f5adf3fa1134ef5c4aaa113f4646458f270e0bfbfd0;
        if (level == 14) return 0x190d33b12f986f961e10c0ee44d8b9af11be25588cad89d416118e4bf4ebe80c;
        if (level == 15) return 0x22f98aa9ce704152ac17354914ad73ed1167ae6596af510aa5b3649325e06c92;
        if (level == 16) return 0x2a7c7c9b6ce5880b9f6f228d72bf6a575a526f29c66ecceef8b753d38bba7323;
        if (level == 17) return 0x2e8186e558698ec1c67af9c14d463ffc470043c9c2988b954d75dd643f36b992;
        if (level == 18) return 0x0f57c5571e9a4eab49e2c8cf050dae948aef6ead647392273546249d1c1ff10f;
        if (level == 19) return 0x1830ee67b5fb554ad5f63d4388800e1cfe78e310697d46e43c9ce36134f72cca;
        if (level == 20) return 0x2134e76ac5d21aab186c2be1dd8f84ee880a1e46eaf712f9d371b6df22191f3e;
        if (level == 21) return 0x19df90ec844ebc4ffeebd866f33859b0c051d8c958ee3aa88f8f8df3db91a5b1;
        if (level == 22) return 0x18cca2a66b5c0787981e69aefd84852d74af0e93ef4912b4648c05f722efe52b;
        if (level == 23) return 0x2388909415230d1b4d1304d2d54f473a628338f2efad83fadf05644549d2538d;
        if (level == 24) return 0x27171fb4a97b6cc0e9e8f543b5294de866a2af2c9c8d0b1d96e673e4529ed540;
        if (level == 25) return 0x2ff6650540f629fd5711a0bc74fc0d28dcb230b9392583e5f8d59696dde6ae21;
        if (level == 26) return 0x120c58f143d491e95902f7f5277778a2e0ad5168f6add75669932630ce611518;
        if (level == 27) return 0x1f21feb70d3f21b07bf853d5e5db03071ec495a0a565a21da2d665d279483795;
        if (level == 28) return 0x24be905fa71335e14c638cc0f66a8623a826e768068a9e968bb1a1dde18a72d2;
        if (level == 29) return 0x0f8666b62ed17491c50ceadead57d4cd597ef3821d65c328744c74e553dac26d;
        if (level == 30) return 0x0918d46bf52d98b034413f4a1a1c41594e7a7a3f6ae08cb43d1a2a230e1959ef;
        if (level == 31) return 0x1bbeb01b4c479ecde76917645e404dfa2e26f90d0afc5a65128513ad375c5ff2;
        revert();
    }

    /// The root of a tree of `size` leaves whose right edge is `filled`: at each height, the filled subtree to the left
    /// where the count's bit is set, the empty subtree to the right where it is not. Internal, so the hash is in the
    /// code once; a wallet folds the same way itself.
    function _root(uint256 size, bytes32[32] calldata filled) internal pure returns (bytes32) {
        uint256 cur; // zero(0)
        for (uint256 level; level < DEPTH; ++level) {
            (uint256 left, uint256 right) = (size >> level) & 1 == 1 ? (uint256(filled[level]), cur) : (cur, zero(level));
            cur = PoseidonT3.hash([left, right]);
        }
        return bytes32(cur);
    }

    /// Whether `pool`'s points include PREVIOUS's.
    function _wraps(address pool) internal view returns (bool) {
        return pool == PREVIOUS_POOL && pool != address(0);
    }

    /// @notice The leaf count of `pool`'s newest point (for PREVIOUS_POOL, the larger of this hub's and PREVIOUS's), 0
    ///         while it has none.
    function latest(address pool) public view returns (uint256 size) {
        size = _latest[pool];
        if (_wraps(pool)) {
            uint256 previous = PREVIOUS.latest();
            if (previous > size) size = previous;
        }
    }

    /// @notice A point by its pool and leaf count: its block, the count of the pool's point that was newest when it was
    ///         posted (a chain back from `latest`), and its edge. For PREVIOUS_POOL, PREVIOUS's point when there is none
    ///         here. All zero for a count never posted.
    function pointAt(address pool, uint256 size)
        public
        view
        returns (uint256 blockNumber, uint256 prev, bytes32[32] memory filled)
    {
        Point storage p = _points[pool][size];
        if (p.postedAt == 0 && _wraps(pool)) return PREVIOUS.pointAt(size);
        return (p.blockNumber, p.prev, p.filled);
    }

    /// @notice The time a point was posted (its block's timestamp), 0 for a count never posted. For PREVIOUS_POOL,
    ///         PREVIOUS's when there is none here.
    function postedAt(address pool, uint256 size) public view returns (uint256 time) {
        time = _points[pool][size].postedAt;
        if (time == 0 && _wraps(pool)) time = PREVIOUS.postedAt(size);
    }

    /// @notice Each pool's newest point, in one call: what a wallet starts every pool it shows from. For PREVIOUS_POOL,
    ///         whichever registry's point is newer. All zero for a pool with none. Reads only this hub's storage (and
    ///         PREVIOUS's), never a pool, so no address in the list can make it revert.
    function newest(address[] calldata pools) external view returns (Newest[] memory out) {
        out = new Newest[](pools.length);
        for (uint256 i; i < pools.length; ++i) {
            uint256 size = latest(pools[i]);
            if (size == 0) continue;
            (uint256 blockNumber,, bytes32[32] memory filled) = pointAt(pools[i], size);
            out[i] = Newest(size, blockNumber, filled);
        }
    }

    /// @notice Posts the edge of `pool`'s tree at `size` leaves, which it had at the end of `blockNumber`. Kept only if the
    ///         pool held the root this edge folds to at that count; one post per pool and count, the first to land (for
    ///         PREVIOUS_POOL, a count PREVIOUS holds is known already). The pool's own revert, for a root it never held,
    ///         comes through. The block number is the poster's word and is not checked here (a contract cannot tell the
    ///         pool's chain's block numbers from its own: on an Arbitrum chain `block.number` is the parent chain's); a
    ///         wallet that uses a point checks it against the events after it.
    function post(address pool, uint256 size, uint256 blockNumber, bytes32[32] calldata filled) external {
        if (size == 0 || size & 1 == 1) revert NotEven();
        if (blockNumber > type(uint64).max) revert BadBlock();
        if (postedAt(pool, size) != 0) revert Known();
        if (ITacitEvmPoolRoots(pool).rootSize(_root(size, filled)) != size) revert NotHeld();
        _keep(pool, size, blockNumber, filled);
    }

    /// @notice Posts many points at once, each kept as `post` keeps it or passed over where `post` would revert: a point
    ///         already kept (here, earlier in the batch, or in PREVIOUS), a pool that never held the root or held it at
    ///         another count, and an address that reverts, has no code, uses more than a fixed gas allowance or answers
    ///         with anything but one word. Nothing a pool does reverts the batch. Returns how many were kept.
    function postMany(Post[] calldata posts) external returns (uint256 kept) {
        for (uint256 i; i < posts.length; ++i) {
            Post calldata q = posts[i];
            if (q.size == 0 || q.size & 1 == 1 || q.blockNumber > type(uint64).max) continue;
            if (postedAt(q.pool, q.size) != 0) continue;
            if (!_held(q.pool, _root(q.size, q.filled), q.size)) continue;
            _keep(q.pool, q.size, q.blockNumber, q.filled);
            ++kept;
        }
    }

    /// Whether `pool` answers `rootSize(r)` with `size`, asked with a bounded allowance of gas and read without copying
    /// more than one word back. A static call, so a pool cannot change any state while it answers.
    function _held(address pool, bytes32 r, uint256 size) internal view returns (bool held) {
        // The call's own cost (a cold account, at most) on top of the allowance and the 64th of it a call keeps back.
        if (gasleft() < ROOT_GAS + ROOT_GAS / 63 + 3_000) revert LowGas();
        bytes4 selector = ITacitEvmPoolRoots.rootSize.selector;
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, selector)
            mstore(add(m, 0x04), r)
            // The call is its own statement: Yul evaluates arguments right to left, so a `returndatasize()` beside it would
            // read the call before.
            let ok := staticcall(ROOT_GAS, pool, m, 0x24, 0x00, 0x20)
            held := and(and(ok, eq(returndatasize(), 0x20)), eq(mload(0x00), size))
        }
    }

    function _keep(address pool, uint256 size, uint256 blockNumber, bytes32[32] calldata filled) internal {
        Point storage p = _points[pool][size];
        p.blockNumber = uint64(blockNumber);
        p.prev = uint64(latest(pool));
        p.postedAt = uint64(block.timestamp);
        p.filled = filled;
        if (size > _latest[pool]) _latest[pool] = size;
        emit Posted(pool, size, blockNumber, msg.sender);
    }
}
