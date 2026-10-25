// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test, Vm} from "forge-std/Test.sol";
import {PoseidonT3} from "../../src/lib/PoseidonT3.sol";
import {TacitEvmPoolCheckpoints, ITacitEvmPoolRoots} from "../../src/checkpoints/TacitEvmPoolCheckpoints.sol";
import {TacitEvmPoolCheckpointsHub, ITacitEvmPoolCheckpoints} from "../../src/checkpoints/TacitEvmPoolCheckpointsHub.sol";
import {RootsMock} from "./TacitEvmPoolCheckpoints.t.sol";

/// A pool's tree kept incrementally, as the page keeps it (dapp/evm-pool-zk.js, incTree): each pair goes in at the next
/// pair slot and every level keeps its latest left node. It builds the root leaf by leaf, apart from the hub's fold,
/// which has only the edge.
library EdgeTree {
    uint256 internal constant P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    struct Tree {
        uint256 size;
        uint256 root;
        bytes32[32] filled;
        uint256[33] zeros;
    }

    function empty() internal pure returns (Tree memory t) {
        for (uint256 l; l < 32; ++l) {
            t.filled[l] = bytes32(t.zeros[l]);
            t.zeros[l + 1] = PoseidonT3.hash([t.zeros[l], t.zeros[l]]);
        }
        t.root = t.zeros[32];
    }

    function append(Tree memory t, uint256 a, uint256 b) internal pure {
        t.filled[0] = bytes32(a);
        uint256 cur = PoseidonT3.hash([a, b]);
        uint256 idx = t.size >> 1;
        for (uint256 l = 1; l < 32; ++l) {
            if (idx & 1 == 0) {
                t.filled[l] = bytes32(cur);
                cur = PoseidonT3.hash([cur, t.zeros[l]]);
            } else {
                cur = PoseidonT3.hash([uint256(t.filled[l]), cur]);
            }
            idx >>= 1;
        }
        t.root = cur;
        t.size += 2;
    }

    /// `pairs` more pairs of pseudo-random leaves from `seed`.
    function grow(Tree memory t, uint256 seed, uint256 pairs) internal pure {
        for (uint256 k; k < pairs; ++k) {
            uint256 i = t.size;
            append(t, uint256(keccak256(abi.encode(seed, i))) % P, uint256(keccak256(abi.encode(seed, i + 1))) % P);
        }
    }

    /// A copy: assigning a memory array aliases it.
    function copy(bytes32[32] memory f) internal pure returns (bytes32[32] memory g) {
        for (uint256 l; l < 32; ++l) g[l] = f[l];
    }
}

/// Vouches for every root, at whatever count it is set to answer: the points it takes are its own.
contract LiarPool {
    uint256 public answer;

    function set(uint256 a) external {
        answer = a;
    }

    function rootSize(bytes32) external view returns (uint256) {
        return answer;
    }
}

/// Uses every bit of the gas it is given.
contract BurnerPool {
    fallback() external {
        assembly {
            for {} 1 {} {}
        }
    }
}

/// Answers (or reverts) with the count it is set to, followed by as many more bytes as its gas pays for.
contract BombPool {
    uint256 public answer;
    bool public reverts;

    function set(uint256 a, bool r) external {
        (answer, reverts) = (a, r);
    }

    fallback() external {
        (uint256 a, bool r) = (answer, reverts);
        assembly {
            mstore(0, a)
            if r { revert(0, 60000) }
            return(0, 60000)
        }
    }
}

/// Answers with the count it is set to, in `width` bytes (two words, or less than one).
contract WidthPool {
    uint256 public answer;
    uint256 public width;

    function set(uint256 a, uint256 w) external {
        (answer, width) = (a, w);
    }

    fallback() external {
        (uint256 a, uint256 w) = (answer, width);
        assembly {
            mstore(0, a)
            mstore(0x20, 0)
            return(0, w)
        }
    }
}

/// Tries to post through the hub while it answers: a point for a liar of its own, which the hub would keep.
contract ReentrantPool {
    TacitEvmPoolCheckpointsHub internal hub;
    LiarPool public inner;

    constructor(TacitEvmPoolCheckpointsHub h) {
        hub = h;
        inner = new LiarPool();
        inner.set(2);
    }

    function rootSize(bytes32) external returns (uint256) {
        bytes32[32] memory none;
        hub.post(address(inner), 2, 1, none);
        return 2;
    }
}

/// A pool that holds what it is told until it is turned hostile, after which it burns all its gas.
contract FlipPool {
    mapping(bytes32 => uint256) internal sizeOf;
    bool public hostile;

    function hold(bytes32 r, uint256 size) external {
        sizeOf[r] = size + 1;
    }

    function flip() external {
        hostile = true;
    }

    function rootSize(bytes32 r) external view returns (uint256) {
        if (hostile) {
            assembly {
                for {} 1 {} {}
            }
        }
        uint256 s = sizeOf[r];
        require(s != 0, "unknown root");
        return s - 1;
    }
}

/// A pool that answers truly but slowly: its read takes most of the hub's allowance.
contract SlowPool {
    mapping(bytes32 => uint256) internal sizeOf;

    function hold(bytes32 r, uint256 size) external {
        sizeOf[r] = size + 1;
    }

    function rootSize(bytes32 r) external view returns (uint256) {
        assembly {
            for { let i := 0 } lt(i, 500) { i := add(i, 1) } {}
        }
        uint256 s = sizeOf[r];
        require(s != 0, "unknown root");
        return s - 1;
    }
}

contract TacitEvmPoolCheckpointsHubTest is Test {
    using EdgeTree for EdgeTree.Tree;

    uint256 internal constant EMPTY_ROOT = 21443572485391568159800782191812935835534334817699172242223315142338162256601;
    uint256 internal constant T0 = 1_700_000_000;

    RootsMock internal ethPool; // the pool the single-pool registry serves
    RootsMock internal poolA;
    RootsMock internal poolB;
    TacitEvmPoolCheckpoints internal previous;
    TacitEvmPoolCheckpointsHub internal hub;

    function setUp() public {
        vm.roll(1000);
        vm.warp(T0);
        ethPool = new RootsMock();
        poolA = new RootsMock();
        poolB = new RootsMock();
        previous = new TacitEvmPoolCheckpoints(ITacitEvmPoolRoots(address(ethPool)));
        hub = new TacitEvmPoolCheckpointsHub(ITacitEvmPoolCheckpoints(address(previous)));
    }

    /// A tree of `size` leaves grown from `seed`, its root held by `pool` at that count (by no pool for address 0).
    function _tree(RootsMock pool, uint256 seed, uint256 size) internal returns (EdgeTree.Tree memory t) {
        t = EdgeTree.empty();
        t.grow(seed, size / 2);
        if (address(pool) != address(0)) pool.hold(bytes32(t.root), size);
    }

    function _posts(uint256 n) internal pure returns (TacitEvmPoolCheckpointsHub.Post[] memory) {
        return new TacitEvmPoolCheckpointsHub.Post[](n);
    }

    function _assertPoint(address pool, uint256 size, uint256 wantBlock, uint256 wantPrev, bytes32[32] memory wantFilled)
        internal
        view
    {
        (uint256 b, uint256 prev, bytes32[32] memory got) = hub.pointAt(pool, size);
        assertEq(b, wantBlock, "block");
        assertEq(prev, wantPrev, "prev");
        for (uint256 l; l < 32; ++l) assertEq(got[l], wantFilled[l], "filled");
    }

    function _assertNone(address pool, uint256 size) internal view {
        (uint256 b, uint256 prev, bytes32[32] memory got) = hub.pointAt(pool, size);
        assertEq(b, 0);
        assertEq(prev, 0);
        for (uint256 l; l < 32; ++l) assertEq(got[l], bytes32(0));
        assertEq(hub.postedAt(pool, size), 0);
    }

    /// The single-pool registry's own vector from the page's tree (TacitEvmPoolCheckpoints.t.sol, kat2).
    function kat2() internal pure returns (uint256 size, bytes32[32] memory filled, bytes32 r) {
        size = 1000;
        r = 0x2cdb7d033c03ca78433394aac86ba8cfcb560767ee3912215cf6e53deeb46975;
        filled[0] = 0x0000000000000000000000000005f50f7b3c0b9979b6d4718c5aeec338623647;
        filled[1] = 0x1ebcfbb13eb0aeb0d725ab018c8ab8a975e0fbfd8b44fd8cfa85c067e93c0ecc;
        filled[2] = 0x2def8d85d46f7f378bc08820b71a7eab3f3a2ca00163e375bdd44157fd3ccfad;
        filled[3] = 0x237ebb4c97fa3abb02ba830a5176ebc5340a65d8793f0f5c366ee5bf6449f445;
        filled[4] = 0x22a69fb9275fbf30f032138c512294dcf984ede5dd286813dc588fadfd558a69;
        filled[5] = 0x06a43cfd8f0530ffab19cf9ca2ad2d02009b1886b20d950c926ae4051ce2fa07;
        filled[6] = 0x14b7760ba9c5ec262a86f61f79eaef808e73aa1056bddc6f3a343252325ecdc2;
        filled[7] = 0x1f56c67e822438cb4e97323de56921292f064c730d267d82b2ba1370a6759f7c;
        filled[8] = 0x04eb0c07aa4a48d3d70f7cdf629ff8d1ff830a4da0db85f752d9a427efaafae8;
        filled[9] = 0x0e86e717c5281d2ebc75c76dba63fac6f2827434526d264ed82e8e2457069539;
        filled[10] = 0x0b5e3aab4c09b03f7a782f087244d10de5003f6b48840eb12dcfbe7c0e056c4a;
        filled[11] = 0x13ffbab9885b7271f5f5052bb8465cc368118358b3b7290cecb3abdb287b24a4;
        filled[12] = 0x14107e5d631bb1e176fa0e2567557695a2618abb511e1df097727691c7d552a2;
        filled[13] = 0x214771614bb9263caf31417575b2813388e1a5c89395f94e29a6f695a7b3b788;
        filled[14] = 0x18925fcee2c2b8b4b9f5fec945a1063d004a84a6f5dab2b3974a69e083d08691;
        filled[15] = 0x1a7dbe89f52b63f25e40f066d5d82b573008d73727cd6d29801bb6f8e8d10d9c;
        filled[16] = 0x116a40e898323d53adab462f38a09bc26ac686cd062c2d2f2c8c93681417be76;
        filled[17] = 0x1c05d0de33b27e80c308be6979dbe8e878d2456eb5973e55c1c6746c3cd6058b;
        filled[18] = 0x0dde95282abbd92e819bfa5be7d4bd2a0a8ff6b784096ab4dccc4c193925db05;
        filled[19] = 0x1e1b1ed9a2f5392ba668e27847c89b1021f1451685e40b0c33c37e218d2ae726;
        filled[20] = 0x1c02d342e8d5a3bf52f76f895979ec61c13f9bb1a98c350a92985188d56e11da;
        filled[21] = 0x25c4cec14a2c9db27da2ecd0e830bbe71dd9d3c033a42bdaed5aaea16a31f74c;
        filled[22] = 0x0ff088f860772149977c1c82aad32115e48d57d7eff97f7bc747d82c9cd7f8d0;
        filled[23] = 0x2f003ad3ae5e7d96f4e46d7fa3b020571784b70741f9398ca7b7b9662952d923;
        filled[24] = 0x09ea33cd137963bdae91d4ec4ab37d661bb06621183d1adfff66cd476543c513;
        filled[25] = 0x09d7aaa0b32308e797ab89dfa68f5046b041876888a108dcf3426221664d2527;
        filled[26] = 0x07da2a0ef7bf6430ef4e3b299ca0b78e5c901e6cbf3db65ac6a8ebf565112fc6;
        filled[27] = 0x21e5f6b6b70c08f48bee411b2ec75c5a396282f1f8b4c37b08f7f6745d233d83;
        filled[28] = 0x06d69f2f1b4cb631c193169264802f9c7156536232489908fc800b1eadf79b95;
        filled[29] = 0x13b7b7d9fa669ea46c106a9d0faf8af8fa0218f66deecae87fa5d7365765a993;
        filled[30] = 0x26b8ab96cfb4fe4900e85922bbb974c4b7380d8fcb1041854a10eeaedc09c751;
        filled[31] = 0x0ecdbdfc215a09f234a5b34ca06596e92e99436fe5d1bcfdb2fd588316795ca3;
    }

    // ── construction and the fold ──

    function testConstructorWrapsTheRegistryItIsGiven() public {
        assertEq(address(hub.PREVIOUS()), address(previous));
        assertEq(hub.PREVIOUS_POOL(), address(ethPool));
        TacitEvmPoolCheckpointsHub solo = new TacitEvmPoolCheckpointsHub(ITacitEvmPoolCheckpoints(address(0)));
        assertEq(address(solo.PREVIOUS()), address(0));
        assertEq(solo.PREVIOUS_POOL(), address(0));
        // An address with no code, or a contract that is no registry, is refused.
        vm.expectRevert();
        new TacitEvmPoolCheckpointsHub(ITacitEvmPoolCheckpoints(makeAddr("nobody")));
        vm.expectRevert();
        new TacitEvmPoolCheckpointsHub(ITacitEvmPoolCheckpoints(address(poolA)));
    }

    function testZerosFoldToThePoolsEmptyRoot() public {
        EdgeTree.Tree memory t = EdgeTree.empty();
        for (uint256 l; l < 32; ++l) assertEq(hub.zero(l), t.zeros[l]);
        assertEq(t.root, EMPTY_ROOT);
        vm.expectRevert();
        hub.zero(32);
        // Count 2 of an empty tree: its edge folds to the pool's empty root, as in the single-pool registry's test.
        bytes32[32] memory none;
        poolA.hold(bytes32(EMPTY_ROOT), 2);
        vm.expectRevert(bytes("unknown root"));
        hub.post(address(poolA), 2, 900, none);
        none[1] = bytes32(hub.zero(1));
        hub.post(address(poolA), 2, 900, none);
        assertEq(hub.latest(address(poolA)), 2);
    }

    function testTheFoldIsThePagesAndTheSinglePoolRegistrys() public {
        (uint256 s, bytes32[32] memory f, bytes32 r) = kat2();
        poolA.hold(r, s);
        uint256 g = gasleft();
        hub.post(address(poolA), s, 30, f);
        emit log_named_uint("post gas (count 1000)", g - gasleft());
        assertEq(hub.latest(address(poolA)), s);
        // A tree grown here leaf by leaf: each root it reaches is what the hub's fold of its edge gives, and what the
        // single-pool registry's gives.
        TacitEvmPoolCheckpoints single = new TacitEvmPoolCheckpoints(ITacitEvmPoolRoots(address(poolB)));
        EdgeTree.Tree memory t = EdgeTree.empty();
        for (uint256 k; k < 12; ++k) {
            t.grow(7, 1);
            poolB.hold(bytes32(t.root), t.size);
            hub.post(address(poolB), t.size, 100 + k, t.filled);
            single.post(t.size, 100 + k, t.filled);
        }
        assertEq(hub.latest(address(poolB)), 24);
        assertEq(single.latest(), 24);
    }

    // ── post ──

    function testPostKeepsOnlyWhatThePoolHeld() public {
        address a = address(poolA);
        EdgeTree.Tree memory t = _tree(RootsMock(address(0)), 1, 10);
        // A root the pool never held: the pool's own revert comes through.
        vm.expectRevert(bytes("unknown root"));
        hub.post(a, 10, 900, t.filled);
        poolA.hold(bytes32(t.root), 10);
        // The same edge under another count folds to another root, one the pool never held (14 = 0b1110 reads level 1's
        // pair twice over).
        vm.expectRevert(bytes("unknown root"));
        hub.post(a, 14, 900, t.filled);
        // Under 12 = 0b1100 it folds to the root of these ten leaves and two empty ones, which is the root the pool held at
        // 10: the count the pool names is what refuses it.
        vm.expectRevert(TacitEvmPoolCheckpointsHub.NotHeld.selector);
        hub.post(a, 12, 900, t.filled);
        bytes32[32] memory bad = EdgeTree.copy(t.filled);
        bad[1] = bytes32(uint256(bad[1]) ^ 1); // a level the fold reads for this count (10 = 0b1010)
        vm.expectRevert(bytes("unknown root"));
        hub.post(a, 10, 900, bad);
        // A root the pool held at another count than the one posted.
        poolA.hold(bytes32(t.root), 14);
        vm.expectRevert(TacitEvmPoolCheckpointsHub.NotHeld.selector);
        hub.post(a, 10, 900, t.filled);
        poolA.hold(bytes32(t.root), 10);
        vm.expectRevert(TacitEvmPoolCheckpointsHub.NotEven.selector);
        hub.post(a, 11, 900, t.filled);
        vm.expectRevert(TacitEvmPoolCheckpointsHub.NotEven.selector);
        hub.post(a, 0, 900, t.filled);
        vm.expectRevert(TacitEvmPoolCheckpointsHub.BadBlock.selector);
        hub.post(a, 10, uint256(type(uint64).max) + 1, t.filled);
        // An address with no code, and a contract without rootSize.
        vm.expectRevert();
        hub.post(makeAddr("eoa"), 10, 900, t.filled);
        vm.expectRevert();
        hub.post(address(hub), 10, 900, t.filled);
        vm.expectRevert();
        hub.post(address(previous), 10, 900, t.filled);

        vm.expectEmit(true, true, true, true, address(hub));
        emit TacitEvmPoolCheckpointsHub.Posted(a, 10, 900, address(this));
        hub.post(a, 10, 900, t.filled);
        assertEq(hub.latest(a), 10);
        _assertPoint(a, 10, 900, 0, t.filled);
        assertEq(hub.postedAt(a, 10), T0);

        vm.expectRevert(TacitEvmPoolCheckpointsHub.Known.selector);
        hub.post(a, 10, 901, t.filled);
        // The largest block that fits is taken.
        t.grow(1, 1);
        poolA.hold(bytes32(t.root), 12);
        hub.post(a, 12, type(uint64).max, t.filled);
        (uint256 b,,) = hub.pointAt(a, 12);
        assertEq(b, type(uint64).max);
        _assertNone(a, 4);
        _assertNone(a, 11);
    }

    /// The root vouches only for the levels where the count's bit is set; the others are the poster's word, kept as
    /// posted, as in the single-pool registry. The tree a wallet continues from a point writes those levels before it
    /// reads them (dapp/evm-pool-zk.js, incTree), so they change nothing it does.
    function testLevelsTheCountDoesNotReadAreThePostersWord() public {
        EdgeTree.Tree memory t = _tree(poolA, 1, 10);
        bytes32[32] memory other = EdgeTree.copy(t.filled);
        other[0] = bytes32(uint256(7)); // 10 = 0b1010: levels 0, 2 and 4 to 31 are not read
        other[2] = bytes32(uint256(8));
        hub.post(address(poolA), 10, 900, other);
        _assertPoint(address(poolA), 10, 900, 0, other);
    }

    /// On an Arbitrum chain `block.number` is the parent chain's, far below the chain's own block numbers the poster names.
    function testABlockNumberAheadOfThisChainsIsAccepted() public {
        EdgeTree.Tree memory t = _tree(poolA, 1, 6);
        hub.post(address(poolA), 6, 90_000_000, t.filled);
        (uint256 b,,) = hub.pointAt(address(poolA), 6);
        assertEq(b, 90_000_000);
    }

    function testPostCannotBeReenteredByThePool() public {
        ReentrantPool re = new ReentrantPool(hub);
        bytes32[32] memory none;
        // Outside a pool's answer, the inner post is one the hub keeps.
        TacitEvmPoolCheckpointsHub other = new TacitEvmPoolCheckpointsHub(ITacitEvmPoolCheckpoints(address(0)));
        other.post(address(re.inner()), 2, 1, none);
        // The pool is asked with a static call, so its post inside the answer fails, and with it the answer. (A write in
        // a static call takes all the gas it was given, hence the limit.)
        vm.expectRevert();
        hub.post{gas: 5_000_000}(address(re), 2, 1, none);
        TacitEvmPoolCheckpointsHub.Post[] memory batch = _posts(1);
        batch[0] = TacitEvmPoolCheckpointsHub.Post(address(re), 2, 1, none);
        assertEq(hub.postMany(batch), 0);
        assertEq(hub.latest(address(re)), 0);
        assertEq(hub.latest(address(re.inner())), 0);
    }

    function testLatestOnlyMovesUpAndChainsBack() public {
        address a = address(poolA);
        EdgeTree.Tree memory t = EdgeTree.empty();
        t.grow(5, 1);
        poolA.hold(bytes32(t.root), 2);
        bytes32[32] memory f2 = EdgeTree.copy(t.filled);
        t.grow(5, 3);
        poolA.hold(bytes32(t.root), 8);
        bytes32[32] memory f8 = EdgeTree.copy(t.filled);
        t.grow(5, 2);
        poolA.hold(bytes32(t.root), 12);
        bytes32[32] memory f12 = EdgeTree.copy(t.filled);

        hub.post(a, 8, 500, f8);
        vm.warp(T0 + 12);
        hub.post(a, 12, 800, f12);
        assertEq(hub.latest(a), 12);
        _assertPoint(a, 12, 800, 8, f12);
        assertEq(hub.postedAt(a, 12), T0 + 12);
        // An older count posted later does not become the newest, and points at what was newest then.
        hub.post(a, 2, 100, f2);
        assertEq(hub.latest(a), 12);
        _assertPoint(a, 2, 100, 12, f2);
        _assertNone(a, 4);
        _assertNone(a, 14);
    }

    // ── one pool's points are its own ──

    function testOnePoolsPointsNeverTouchAnothers() public {
        address a = address(poolA);
        address b = address(poolB);
        EdgeTree.Tree memory ta = _tree(poolA, 1, 8);
        EdgeTree.Tree memory tb = _tree(poolB, 2, 8);
        // A's edge is not B's: B never held A's root.
        vm.expectRevert(bytes("unknown root"));
        hub.post(b, 8, 50, ta.filled);
        hub.post(a, 8, 50, ta.filled);
        assertEq(hub.latest(b), 0);
        _assertNone(b, 8);
        // A point kept for A at a count does not stop B's at the same count.
        hub.post(b, 8, 60, tb.filled);
        // A liar that vouches for every root takes A's edge at A's count, and any count, for itself alone.
        LiarPool liar = new LiarPool();
        liar.set(8);
        hub.post(address(liar), 8, 70, ta.filled);
        liar.set(1 << 40);
        bytes32[32] memory junk;
        hub.post(address(liar), 1 << 40, 1, junk);
        assertEq(hub.latest(address(liar)), 1 << 40);
        // A's and B's points are as they were.
        assertEq(hub.latest(a), 8);
        assertEq(hub.latest(b), 8);
        _assertPoint(a, 8, 50, 0, ta.filled);
        _assertPoint(b, 8, 60, 0, tb.filled);
        // A grows; B's newest does not move.
        ta.grow(1, 2);
        poolA.hold(bytes32(ta.root), 12);
        hub.post(a, 12, 90, ta.filled);
        assertEq(hub.latest(a), 12);
        assertEq(hub.latest(b), 8);
        _assertPoint(a, 12, 90, 8, ta.filled);
        _assertNone(b, 12);
        // The wrapped pool's points stay with it: a count its registry holds is open for another pool.
        EdgeTree.Tree memory te = _tree(ethPool, 3, 4);
        previous.post(4, 40, te.filled);
        EdgeTree.Tree memory ta4 = _tree(poolA, 1, 4);
        hub.post(a, 4, 41, ta4.filled);
        _assertPoint(a, 4, 41, 12, ta4.filled);
        assertEq(hub.latest(address(ethPool)), 4);
    }

    function testFuzzPostsStayWithTheirPool(address x, address y, uint8 pairs, uint64 bx, uint64 by) public {
        assumeNotPrecompile(x);
        assumeNotPrecompile(y);
        assumeNotForgeAddress(x);
        assumeNotForgeAddress(y);
        vm.assume(x != y && x.code.length == 0 && y.code.length == 0 && x != address(0) && y != address(0));
        bytes memory code = address(poolA).code;
        vm.etch(x, code);
        vm.etch(y, code);
        uint256 size = 2 * (uint256(pairs) % 6 + 1);
        EdgeTree.Tree memory tx_ = _tree(RootsMock(x), 11, size);
        EdgeTree.Tree memory ty = _tree(RootsMock(y), 12, size);
        hub.post(x, size, bx, tx_.filled);
        assertEq(hub.latest(y), 0);
        _assertNone(y, size);
        vm.expectRevert(bytes("unknown root"));
        hub.post(y, size, by, tx_.filled);
        hub.post(y, size, by, ty.filled);
        _assertPoint(x, size, bx, 0, tx_.filled);
        _assertPoint(y, size, by, 0, ty.filled);
        TacitEvmPoolCheckpointsHub.Newest[] memory n;
        address[] memory both = new address[](2);
        (both[0], both[1]) = (x, y);
        n = hub.newest(both);
        assertEq(n[0].blockNumber, bx);
        assertEq(n[1].blockNumber, by);
    }

    // ── the registry it wraps ──

    function testWrapsTheSinglePoolRegistry() public {
        address e = address(ethPool);
        address[] memory just = new address[](1);
        just[0] = e;
        assertEq(hub.latest(e), 0);
        assertEq(hub.newest(just)[0].size, 0);
        // The ETH pool's tree at counts 2, 4, 8, 12, 16 and 20.
        EdgeTree.Tree memory t = EdgeTree.empty();
        bytes32[32][6] memory f;
        uint256[6] memory sizes = [uint256(2), 4, 8, 12, 16, 20];
        for (uint256 k; k < 6; ++k) {
            t.grow(9, (sizes[k] - t.size) / 2);
            ethPool.hold(bytes32(t.root), t.size);
            f[k] = EdgeTree.copy(t.filled);
        }
        // The single-pool registry has 4 and 8.
        previous.post(4, 40, f[1]);
        vm.warp(T0 + 1);
        previous.post(8, 80, f[2]);
        // The hub reads through to it: latest, pointAt, postedAt and newest.
        assertEq(hub.latest(e), 8);
        _assertPoint(e, 8, 80, 4, f[2]);
        _assertPoint(e, 4, 40, 0, f[1]);
        assertEq(hub.postedAt(e, 8), T0 + 1);
        assertEq(hub.postedAt(e, 4), T0);
        TacitEvmPoolCheckpointsHub.Newest memory n = hub.newest(just)[0];
        assertEq(n.size, 8);
        assertEq(n.blockNumber, 80);
        assertEq(n.filled[3], f[2][3]);
        // A count the single-pool registry holds is known here.
        vm.expectRevert(TacitEvmPoolCheckpointsHub.Known.selector);
        hub.post(e, 8, 81, f[2]);
        vm.expectRevert(TacitEvmPoolCheckpointsHub.Known.selector);
        hub.post(e, 4, 41, f[1]);
        TacitEvmPoolCheckpointsHub.Post[] memory batch = _posts(1);
        batch[0] = TacitEvmPoolCheckpointsHub.Post(e, 8, 81, f[2]);
        assertEq(hub.postMany(batch), 0);
        _assertPoint(e, 8, 80, 4, f[2]);

        // A newer count is kept here, chained back to the single-pool registry's newest.
        vm.warp(T0 + 2);
        hub.post(e, 12, 120, f[3]);
        assertEq(hub.latest(e), 12);
        _assertPoint(e, 12, 120, 8, f[3]);
        n = hub.newest(just)[0];
        assertEq(n.size, 12);
        assertEq(n.blockNumber, 120);
        // An older count that neither holds is kept here and does not become the newest.
        hub.post(e, 2, 20, f[0]);
        assertEq(hub.latest(e), 12);
        _assertPoint(e, 2, 20, 12, f[0]);
        // The chain back from the newest reads through both registries: 12, 8, 4.
        uint256[3] memory chain = [uint256(12), 8, 4];
        uint256 s = hub.latest(e);
        for (uint256 k; k < 3; ++k) {
            assertEq(s, chain[k]);
            (, s,) = hub.pointAt(e, s);
        }
        assertEq(s, 0);

        // The single-pool registry moves ahead again, and the hub follows it.
        previous.post(16, 160, f[4]);
        assertEq(hub.latest(e), 16);
        _assertPoint(e, 16, 160, 8, f[4]);
        n = hub.newest(just)[0];
        assertEq(n.size, 16);
        assertEq(n.blockNumber, 160);
        // A count both hold: the hub's point is the one read.
        vm.warp(T0 + 3);
        previous.post(12, 999, f[3]);
        _assertPoint(e, 12, 120, 8, f[3]);
        assertEq(hub.postedAt(e, 12), T0 + 2);
        // The hub's next point chains back to the newer of the two registries.
        hub.post(e, 20, 200, f[5]);
        _assertPoint(e, 20, 200, 16, f[5]);
        assertEq(hub.latest(e), 20);
        assertEq(previous.latest(), 16);

        // Another pool is its own at the same counts: no reading through, no counts taken.
        EdgeTree.Tree memory ta = _tree(poolA, 4, 8);
        hub.post(address(poolA), 8, 88, ta.filled);
        assertEq(hub.latest(address(poolA)), 8);
        _assertNone(address(poolA), 16);
        _assertNone(address(poolA), 4);
    }

    function testWithoutAPreviousRegistry() public {
        TacitEvmPoolCheckpointsHub solo = new TacitEvmPoolCheckpointsHub(ITacitEvmPoolCheckpoints(address(0)));
        address e = address(ethPool);
        EdgeTree.Tree memory t = _tree(ethPool, 3, 6);
        // The single-pool registry's points do not count here, and its counts are open.
        previous.post(6, 60, t.filled);
        assertEq(solo.latest(e), 0);
        solo.post(e, 6, 61, t.filled);
        (uint256 b, uint256 prev,) = solo.pointAt(e, 6);
        assertEq(b, 61);
        assertEq(prev, 0);
        // The zero address is no pool and reads no registry.
        assertEq(solo.latest(address(0)), 0);
        assertEq(solo.postedAt(address(0), 6), 0);
        vm.expectRevert();
        solo.post(address(0), 6, 1, t.filled);
        TacitEvmPoolCheckpointsHub.Post[] memory batch = _posts(1);
        batch[0] = TacitEvmPoolCheckpointsHub.Post(address(0), 6, 1, t.filled);
        assertEq(solo.postMany(batch), 0);
        address[] memory pools = new address[](2);
        (pools[0], pools[1]) = (address(0), e);
        TacitEvmPoolCheckpointsHub.Newest[] memory n = solo.newest(pools);
        assertEq(n[0].size, 0);
        assertEq(n[1].size, 6);
        assertEq(n[1].blockNumber, 61);
    }

    // ── postMany ──

    /// Addresses that can keep no point for an edge whose root was held at `size`: a pool that held it at another count,
    /// pools that burn their gas, answer with too much or too little, or reenter, an address with no code, the zero
    /// address, and contracts that are no pools.
    function _noPoints(uint256 size, bytes32 root) internal returns (address[] memory h) {
        h = new address[](11);
        RootsMock elsewhere = new RootsMock();
        elsewhere.hold(root, size + 2);
        h[0] = address(elsewhere);
        h[1] = address(new BurnerPool());
        BombPool bomb = new BombPool();
        bomb.set(size, false);
        h[2] = address(bomb);
        bomb = new BombPool();
        bomb.set(size, true);
        h[3] = address(bomb);
        WidthPool width = new WidthPool();
        width.set(size, 64);
        h[4] = address(width);
        width = new WidthPool();
        width.set(size, 31);
        h[5] = address(width);
        h[6] = address(new ReentrantPool(hub));
        h[7] = makeAddr("eoa");
        h[8] = address(0);
        h[9] = address(hub);
        h[10] = address(previous);
    }

    function testPostManyKeepsTheGoodAndPassesOverTheRest() public {
        address a = address(poolA);
        address e = address(ethPool);
        EdgeTree.Tree memory ta = _tree(poolA, 1, 6);
        bytes32[32] memory fb = _tree(poolB, 2, 6).filled;
        bytes32[32] memory e4;
        bytes32[32] memory e8;
        {
            EdgeTree.Tree memory te = _tree(ethPool, 3, 4);
            previous.post(4, 40, te.filled);
            e4 = EdgeTree.copy(te.filled);
            te.grow(3, 2);
            ethPool.hold(bytes32(te.root), 8);
            e8 = te.filled;
        }
        address[] memory none = _noPoints(6, bytes32(ta.root));
        LiarPool liar = new LiarPool();
        liar.set(6);

        TacitEvmPoolCheckpointsHub.Post[] memory batch = _posts(21);
        {
            bytes32[32] memory badA = EdgeTree.copy(ta.filled);
            badA[1] = bytes32(uint256(badA[1]) ^ 1); // 6 = 0b110: level 1 is read
            batch[0] = TacitEvmPoolCheckpointsHub.Post(a, 6, 1, badA); // a root A never held
        }
        batch[1] = TacitEvmPoolCheckpointsHub.Post(a, 7, 1, ta.filled); // odd
        batch[2] = TacitEvmPoolCheckpointsHub.Post(a, 0, 1, ta.filled); // none
        batch[3] = TacitEvmPoolCheckpointsHub.Post(a, 6, uint256(type(uint64).max) + 1, ta.filled); // a block too big
        batch[4] = TacitEvmPoolCheckpointsHub.Post(e, 4, 1, e4); // the single-pool registry holds it
        for (uint256 i; i < none.length; ++i) batch[5 + i] = TacitEvmPoolCheckpointsHub.Post(none[i], 6, 1, ta.filled);
        batch[16] = TacitEvmPoolCheckpointsHub.Post(a, 6, 60, ta.filled); // kept
        batch[17] = TacitEvmPoolCheckpointsHub.Post(address(poolB), 6, 61, fb); // kept: the same count, another pool
        batch[18] = TacitEvmPoolCheckpointsHub.Post(a, 6, 62, ta.filled); // kept earlier in the batch
        batch[19] = TacitEvmPoolCheckpointsHub.Post(e, 8, 80, e8); // kept: newer than the registry's
        batch[20] = TacitEvmPoolCheckpointsHub.Post(address(liar), 6, 63, ta.filled); // kept, for the liar alone

        vm.recordLogs();
        uint256 g = gasleft();
        assertEq(hub.postMany(batch), 4);
        emit log_named_uint("postMany gas (21 entries, 4 kept)", g - gasleft());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 posted;
        for (uint256 i; i < logs.length; ++i) if (logs[i].emitter == address(hub)) ++posted;
        assertEq(posted, 4);

        _assertPoint(a, 6, 60, 0, ta.filled);
        _assertPoint(address(poolB), 6, 61, 0, fb);
        _assertPoint(e, 8, 80, 4, e8);
        _assertPoint(address(liar), 6, 63, 0, ta.filled);
        assertEq(hub.latest(e), 8);
        for (uint256 i; i < none.length; ++i) {
            assertEq(hub.latest(none[i]), 0);
            assertEq(hub.postedAt(none[i], 6), 0);
        }
        assertEq(hub.latest(address(ReentrantPool(none[6]).inner())), 0);
        // The single-pool registry's point at 4 is as it was.
        _assertPoint(e, 4, 40, 0, e4);
        assertEq(hub.postMany(_posts(0)), 0);
    }

    function testAHostilePoolCostsABatchNoMoreThanItsAllowance() public {
        bytes32[32] memory f = _tree(RootsMock(address(0)), 1, 6).filled;
        // A pool that never held the root, asked once: the fold and a cheap revert.
        TacitEvmPoolCheckpointsHub.Post[] memory one = _posts(1);
        one[0] = TacitEvmPoolCheckpointsHub.Post(address(poolA), 6, 1, f);
        uint256 g = gasleft();
        hub.postMany(one);
        uint256 base = g - gasleft();
        emit log_named_uint("postMany gas, one pool that never held the root", base);

        BombPool bomb = new BombPool();
        bomb.set(6, false);
        BombPool revertBomb = new BombPool();
        revertBomb.set(6, true);
        WidthPool twoWords = new WidthPool();
        twoWords.set(6, 64);
        address[5] memory hostile =
            [address(new BurnerPool()), address(bomb), address(revertBomb), address(twoWords), address(new ReentrantPool(hub))];
        for (uint256 i; i < hostile.length; ++i) {
            one[0].pool = hostile[i];
            g = gasleft();
            assertEq(hub.postMany(one), 0);
            uint256 cost = g - gasleft();
            emit log_named_uint("postMany gas, one hostile pool", cost);
            // At most the allowance over what the honest refusal cost, and the call's own cost.
            assertLe(cost, base + 30_000 + 3_000);
        }
        // Twenty burners in one batch cost the batch twenty allowances, no more, and it still keeps the good point.
        EdgeTree.Tree memory t = _tree(poolB, 2, 6);
        TacitEvmPoolCheckpointsHub.Post[] memory many = _posts(21);
        address burner = address(new BurnerPool());
        for (uint256 i; i < 20; ++i) many[i] = TacitEvmPoolCheckpointsHub.Post(burner, 6, 1, f);
        many[20] = TacitEvmPoolCheckpointsHub.Post(address(poolB), 6, 2, t.filled);
        g = gasleft();
        assertEq(hub.postMany(many), 1);
        emit log_named_uint("postMany gas, 20 burners and one good point", g - gasleft());
        assertEq(hub.latest(address(poolB)), 6);
    }

    /// A batch sent with too little gas for a pool's full allowance reverts whole: whatever gas it is sent with, it never
    /// succeeds having passed over a point its pool would have vouched for, so an estimate cannot settle on a limit at
    /// which a pool's read runs short and the batch returns having kept less. For a pool whose read is cheap the 64th of
    /// the gas a call keeps back is too little to finish the batch anyway; for one whose read is near the allowance it is
    /// not, and the guard is what closes the gap (without it, the slow pool's sweep finds limits that keep nothing).
    function testABatchNeverPassesOverAPointForTheGasItWasSent() public {
        _sweep(address(poolA));
    }

    function testABatchNeverPassesOverASlowPoolsPointForTheGasItWasSent() public {
        SlowPool slow = new SlowPool();
        bytes32[32] memory none;
        slow.hold(bytes32(0), 0);
        TacitEvmPoolCheckpointsHub.Post[] memory one = _posts(1);
        one[0] = TacitEvmPoolCheckpointsHub.Post(address(slow), 2, 1, none);
        uint256 g = gasleft();
        hub.postMany(one); // a root it never held: the read, all of it, and a revert
        emit log_named_uint("postMany gas, one slow pool that never held the root", g - gasleft());
        _sweep(address(slow));
    }

    function _sweep(address pool) internal {
        EdgeTree.Tree memory t = _tree(RootsMock(address(0)), 1, 6);
        RootsMock(pool).hold(bytes32(t.root), 6);
        TacitEvmPoolCheckpointsHub.Post[] memory batch = _posts(1);
        batch[0] = TacitEvmPoolCheckpointsHub.Post(pool, 6, 60, t.filled);
        bytes memory good = abi.encodeCall(hub.postMany, (batch));
        // The same batch for an address with no code: the gas it takes to reach the pool's read and fail it.
        batch[0].pool = makeAddr("eoa");
        uint256 snap = vm.snapshotState();
        uint256 g = gasleft();
        (bool ok,) = address(hub).call(abi.encodeCall(hub.postMany, (batch)));
        uint256 toRead = g - gasleft();
        assertTrue(ok);
        g = gasleft();
        (ok,) = address(hub).call(good);
        uint256 whole = g - gasleft();
        assertTrue(ok);
        vm.revertToState(snap);
        (uint256 successes, uint256 lowGas) = _tryLimits(pool, good, snap, toRead - 2_000, toRead + 38_000, 67);
        (uint256 more,) = _tryLimits(pool, good, snap, whole - 3_000, whole + 3_000, 101);
        assertGt(successes + more, 0);
        assertGt(lowGas, 0);
        emit log_named_uint("limits turned away as LowGas", lowGas);
    }

    /// Sends `data` with each limit from `from` to `to`: every one that succeeds must have kept the point.
    function _tryLimits(address pool, bytes memory data, uint256 snap, uint256 from, uint256 to, uint256 step)
        internal
        returns (uint256 successes, uint256 lowGas)
    {
        for (uint256 lim = from; lim < to; lim += step) {
            (bool sent, bytes memory ret) = address(hub).call{gas: lim}(data);
            if (!sent) {
                if (ret.length == 4 && bytes4(ret) == TacitEvmPoolCheckpointsHub.LowGas.selector) ++lowGas;
                continue;
            }
            ++successes;
            assertEq(abi.decode(ret, (uint256)), 1);
            assertEq(hub.latest(pool), 6);
            vm.revertToState(snap);
        }
    }

    // ── newest ──

    function testNewestForManyPools() public {
        uint256 n = 30;
        address[] memory pools = new address[](n);
        // Ten honest pools, some posted at two counts; the wrapped pool with points in both registries; a liar; two
        // pools that turned hostile after their points were kept; addresses with no code, the zero address, contracts
        // that are no pools, a duplicate, and pools never posted.
        for (uint256 i; i < 10; ++i) {
            RootsMock m = new RootsMock();
            EdgeTree.Tree memory t = _tree(m, 100 + i, 2 * (i % 4 + 1));
            hub.post(address(m), t.size, 1000 + i, t.filled);
            if (i % 3 == 0) {
                t.grow(100 + i, 1);
                m.hold(bytes32(t.root), t.size);
                hub.post(address(m), t.size, 2000 + i, t.filled);
            }
            pools[i] = address(m);
        }
        EdgeTree.Tree memory te = _tree(ethPool, 3, 4);
        previous.post(4, 40, te.filled);
        te.grow(3, 1);
        ethPool.hold(bytes32(te.root), 6);
        hub.post(address(ethPool), 6, 60, te.filled);
        pools[10] = address(ethPool);
        LiarPool liar = new LiarPool();
        liar.set(1 << 32);
        bytes32[32] memory junk;
        hub.post(address(liar), 1 << 32, 7, junk);
        pools[11] = address(liar);
        for (uint256 i = 12; i < 14; ++i) {
            FlipPool fp = new FlipPool();
            EdgeTree.Tree memory t = _tree(RootsMock(address(0)), 200 + i, 4);
            fp.hold(bytes32(t.root), 4);
            hub.post(address(fp), 4, 3000 + i, t.filled);
            fp.flip();
            pools[i] = address(fp);
            vm.expectCall(address(fp), abi.encodeWithSelector(ITacitEvmPoolRoots.rootSize.selector), 0);
        }
        pools[14] = makeAddr("eoa");
        pools[15] = address(0);
        pools[16] = address(hub);
        pools[17] = address(previous);
        pools[18] = address(new BurnerPool());
        pools[19] = pools[3];
        for (uint256 i = 20; i < n; ++i) pools[i] = address(new RootsMock());

        uint256 g = gasleft();
        TacitEvmPoolCheckpointsHub.Newest[] memory got = hub.newest(pools);
        emit log_named_uint("newest gas (30 pools)", g - gasleft());
        assertEq(got.length, n);
        for (uint256 i; i < n; ++i) {
            uint256 size = hub.latest(pools[i]);
            assertEq(got[i].size, size);
            (uint256 b,, bytes32[32] memory f) = hub.pointAt(pools[i], size);
            assertEq(got[i].blockNumber, b);
            for (uint256 l; l < 32; ++l) assertEq(got[i].filled[l], f[l]);
        }
        assertEq(got[0].size, 4); // posted at 2, then 4
        assertEq(got[0].blockNumber, 2000);
        assertEq(got[1].size, 4);
        assertEq(got[1].blockNumber, 1001);
        assertEq(got[10].size, 6); // the hub's, newer than the registry's 4
        assertEq(got[10].blockNumber, 60);
        assertEq(got[11].size, 1 << 32);
        assertEq(got[12].blockNumber, 3012);
        assertEq(got[19].blockNumber, got[3].blockNumber);
        for (uint256 i = 14; i < 19; ++i) assertEq(got[i].size, 0);
        for (uint256 i = 20; i < n; ++i) {
            assertEq(got[i].size, 0);
            assertEq(got[i].blockNumber, 0);
            assertEq(got[i].filled[0], bytes32(0));
        }
        // The registry moves ahead of the hub for the wrapped pool, and newest gives its point.
        te.grow(3, 1);
        ethPool.hold(bytes32(te.root), 8);
        previous.post(8, 80, te.filled);
        got = hub.newest(pools);
        assertEq(got[10].size, 8);
        assertEq(got[10].blockNumber, 80);
        assertEq(got[10].filled[3], te.filled[3]);
        assertEq(hub.newest(new address[](0)).length, 0);
    }
}

/// The hub on an Ethereum fork, over the live single-pool registry and the live pools. Runs when CHECKPOINT_HUB_FORK_URL
/// names an archive node (https://mainnet.gateway.tenderly.co serves one); skipped otherwise.
///   CHECKPOINT_HUB_FORK_URL=https://mainnet.gateway.tenderly.co FOUNDRY_PROFILE=checkpoints forge test --mc HubFork -vv
contract TacitEvmPoolCheckpointsHubForkTest is Test {
    using EdgeTree for EdgeTree.Tree;

    ITacitEvmPoolCheckpoints internal constant REGISTRY = ITacitEvmPoolCheckpoints(0x00000000C3267616ED5E0DAA6F6490D109d6844D);
    address internal constant ETH_POOL = 0x000000c2A20657CE25f2Ba99737933D031AFBEE9;
    address internal constant USDC_POOL = 0x6C0be904750Fe1b50cd7207cc94731642d99e908;
    address internal constant TAC_POOL = 0x0000007F401114398b8fa67b4Bf1e1CFEcd28ffe;
    uint256 internal constant ETH_POOL_FROM = 26069245; // the ETH pool's deploy block
    uint256 internal constant USDC_POOL_FROM = 26264051;
    uint256 internal constant FORK_BLOCK = 26271400;
    bytes32 internal constant TRANSACT =
        keccak256("Transact(bytes32,bytes32,bytes32,bytes32,uint256,bytes32,address,int256,address,uint256,bytes,bytes)");

    TacitEvmPoolCheckpointsHub internal hub;
    address[] internal pools = new address[](3);

    function _forked() internal returns (bool) {
        string memory url = vm.envOr("CHECKPOINT_HUB_FORK_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return false;
        }
        vm.createSelectFork(url, FORK_BLOCK);
        hub = new TacitEvmPoolCheckpointsHub(REGISTRY);
        (pools[0], pools[1], pools[2]) = (ETH_POOL, USDC_POOL, TAC_POOL);
        return true;
    }

    /// The pool's tree from its Transact events through FORK_BLOCK (each inserting one's two output leaves, at the
    /// position it names), the block of its last insertion, and the edge at `stopAt` leaves with the block of the
    /// insertion that made it.
    function _treeFromEvents(address pool, uint256 from, uint256 stopAt)
        internal
        view
        returns (EdgeTree.Tree memory t, uint256 lastBlock, bytes32[32] memory edgeAt, uint256 blockAt)
    {
        t = EdgeTree.empty();
        bytes32[] memory topics = new bytes32[](1);
        topics[0] = TRANSACT;
        for (uint256 a = from; a <= FORK_BLOCK; a += 50_000) {
            uint256 b = a + 49_999 < FORK_BLOCK ? a + 49_999 : FORK_BLOCK;
            Vm.EthGetLogs[] memory logs = vm.eth_getLogs(a, b, pool, topics);
            for (uint256 i; i < logs.length; ++i) {
                (uint256 l0, uint256 l1, uint256 firstIndex) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                if (l0 == 0 && l1 == 0) continue; // inserted nothing
                assertEq(firstIndex, t.size, "an insertion is missing");
                t.append(l0, l1);
                lastBlock = logs[i].blockNumber;
                if (t.size == stopAt) (edgeAt, blockAt) = (EdgeTree.copy(t.filled), lastBlock);
            }
        }
    }

    function testForkReadsThroughTheLiveRegistry() public {
        if (!_forked()) return;
        assertEq(address(hub.PREVIOUS()), address(REGISTRY));
        assertEq(hub.PREVIOUS_POOL(), ETH_POOL);
        uint256 live = REGISTRY.latest();
        assertEq(live, 596);
        assertEq(hub.latest(ETH_POOL), live);
        // Every live point reads through, along the chain back from the newest.
        uint256 points;
        for (uint256 s = live; s != 0; ++points) {
            (uint256 b, uint256 p, bytes32[32] memory f) = hub.pointAt(ETH_POOL, s);
            (uint256 b2, uint256 p2, bytes32[32] memory f2) = REGISTRY.pointAt(s);
            assertEq(b, b2);
            assertEq(p, p2);
            for (uint256 l; l < 32; ++l) assertEq(f[l], f2[l]);
            assertEq(hub.postedAt(ETH_POOL, s), REGISTRY.postedAt(s));
            assertGt(hub.postedAt(ETH_POOL, s), 0);
            s = p;
        }
        emit log_named_uint("live points read through", points);
        (uint256 liveBlock,, bytes32[32] memory liveEdge) = REGISTRY.pointAt(live);
        TacitEvmPoolCheckpointsHub.Newest[] memory n = hub.newest(pools);
        assertEq(n[0].size, live);
        assertEq(n[0].blockNumber, liveBlock);
        for (uint256 l; l < 32; ++l) assertEq(n[0].filled[l], liveEdge[l]);
        assertEq(n[1].size, 0);
        assertEq(n[2].size, 0);
        // The live registry's count is known here, its own edge and all.
        vm.expectRevert(TacitEvmPoolCheckpointsHub.Known.selector);
        hub.post(ETH_POOL, live, liveBlock, liveEdge);
        // The hub's fold agrees with the live registry's point: a hub that wraps nothing keeps it for the ETH pool.
        TacitEvmPoolCheckpointsHub solo = new TacitEvmPoolCheckpointsHub(ITacitEvmPoolCheckpoints(address(0)));
        solo.post(ETH_POOL, live, liveBlock, liveEdge);
        assertEq(solo.latest(ETH_POOL), live);
    }

    function testForkKeepsRealPointsPastTheLiveRegistry() public {
        if (!_forked()) return;
        uint256 live = REGISTRY.latest();
        // The ETH pool's tree from its events, through the fork block: it is the pool's own tree.
        (EdgeTree.Tree memory t, uint256 lastBlock, bytes32[32] memory e600, uint256 b600) =
            _treeFromEvents(ETH_POOL, ETH_POOL_FROM, 600);
        {
            (bytes32 root, uint256 size) = TacitEvmPoolHead(ETH_POOL).head();
            assertEq(t.size, size);
            assertEq(bytes32(t.root), root);
            assertEq(size, 604);
            emit log_named_uint("ETH pool leaves at the fork block", size);
            emit log_named_uint("block of the insertion that made 604", lastBlock);
        }
        // Two real points past the live registry's, a known one, and the token pools' empty trees, in one batch.
        TacitEvmPoolCheckpointsHub.Post[] memory batch = new TacitEvmPoolCheckpointsHub.Post[](5);
        batch[0] = TacitEvmPoolCheckpointsHub.Post(ETH_POOL, 600, b600, e600);
        batch[1] = TacitEvmPoolCheckpointsHub.Post(ETH_POOL, 604, lastBlock, t.filled);
        {
            (uint256 liveBlock,, bytes32[32] memory liveEdge) = REGISTRY.pointAt(live);
            batch[2] = TacitEvmPoolCheckpointsHub.Post(ETH_POOL, live, liveBlock, liveEdge);
        }
        bytes32[32] memory empty2;
        empty2[1] = bytes32(hub.zero(1));
        batch[3] = TacitEvmPoolCheckpointsHub.Post(USDC_POOL, 2, FORK_BLOCK, empty2);
        batch[4] = TacitEvmPoolCheckpointsHub.Post(TAC_POOL, 2, FORK_BLOCK, empty2);
        uint256 g = gasleft();
        assertEq(hub.postMany(batch), 2);
        emit log_named_uint("postMany gas (2 of 5 kept)", g - gasleft());
        assertEq(hub.latest(ETH_POOL), 604);
        // The chain back runs 604, 600, then into the live registry.
        (uint256 b604, uint256 p604,) = hub.pointAt(ETH_POOL, 604);
        assertEq(b604, lastBlock);
        assertEq(p604, 600);
        (uint256 b, uint256 p600,) = hub.pointAt(ETH_POOL, 600);
        assertEq(b, b600);
        assertEq(p600, live);
        TacitEvmPoolCheckpointsHub.Newest[] memory n = hub.newest(pools);
        assertEq(n[0].size, 604);
        assertEq(n[0].blockNumber, lastBlock);
        for (uint256 l; l < 32; ++l) assertEq(n[0].filled[l], t.filled[l]);
        assertEq(n[1].size, 0);
        assertEq(n[2].size, 0);
        assertEq(REGISTRY.latest(), live);
    }

    /// The token pools are empty at the fork block (no Transact since they were deployed): the empty tree's root is one
    /// they held at 0 leaves, not 2, and another pool's edge folds to a root they never held.
    function testForkTokenPoolsVouchOnlyForTheirOwnTrees() public {
        if (!_forked()) return;
        assertEq(TacitEvmPoolHead(USDC_POOL).nextIndex(), 0);
        assertEq(TacitEvmPoolHead(TAC_POOL).nextIndex(), 0);
        (EdgeTree.Tree memory tu,,,) = _treeFromEvents(USDC_POOL, USDC_POOL_FROM, 0);
        assertEq(tu.size, 0);
        bytes32[32] memory empty2;
        empty2[1] = bytes32(hub.zero(1));
        vm.expectRevert(TacitEvmPoolCheckpointsHub.NotHeld.selector);
        hub.post(USDC_POOL, 2, FORK_BLOCK, empty2);
        vm.expectRevert(TacitEvmPoolCheckpointsHub.NotHeld.selector);
        hub.post(TAC_POOL, 2, FORK_BLOCK, empty2);
        uint256 live = REGISTRY.latest();
        (,, bytes32[32] memory liveEdge) = REGISTRY.pointAt(live);
        vm.expectRevert(bytes4(keccak256("UnknownMembershipRoot()")));
        hub.post(USDC_POOL, live, FORK_BLOCK, liveEdge);
        assertEq(hub.latest(USDC_POOL), 0);
    }
}

interface TacitEvmPoolHead {
    function head() external view returns (bytes32, uint256);
    function nextIndex() external view returns (uint256);
}
