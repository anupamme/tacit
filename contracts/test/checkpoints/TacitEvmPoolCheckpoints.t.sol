// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {TacitEvmPoolCheckpoints, ITacitEvmPoolRoots} from "../../src/checkpoints/TacitEvmPoolCheckpoints.sol";

/// A pool that holds the roots it is told to, at the counts it is told.
contract RootsMock is ITacitEvmPoolRoots {
    mapping(bytes32 => uint256) internal sizeOf;

    function hold(bytes32 r, uint256 size) external {
        sizeOf[r] = size + 1;
    }

    function rootSize(bytes32 r) external view returns (uint256) {
        uint256 s = sizeOf[r];
        require(s != 0, "unknown root");
        return s - 1;
    }
}

/// The vectors come from the page's own incremental tree (anon.wei, dapp/page.html: incTree and edgeRoot) over
/// pseudo-random leaves, so the fold here is the fold the wallet does; zeros 0 and 32 pin the empty tree to the pool's
/// own constant.
contract TacitEvmPoolCheckpointsTest is Test {
    uint256 internal constant EMPTY_ROOT = 21443572485391568159800782191812935835534334817699172242223315142338162256601;
    uint256 internal constant ZERO1 = 0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864;

    RootsMock internal pool;
    TacitEvmPoolCheckpoints internal cp;

    function kat0() internal pure returns (uint256 size, bytes32[32] memory filled, bytes32 r) {
        size = 2;
        r = 0x1f647c3f7f47543b5114ca29673de3e43a152e66a900643e01f23e093cee8273;
        filled[0] = 0x0000000000000000000000000000000061c8864680b5bf84219df1797510e7cb;
        filled[1] = 0x2dcc73819eb80725b392795c1ef76a0ecd9c4d0566a741c356f36a57d993cefb;
        filled[2] = 0x1a204cec282838a6c02b493b6d76234ce9992202b27f167866e20805a7836072;
        filled[3] = 0x2038f0c35dcba2316712f3fd198ef5ef0442e29f459afdd4b69b1bae29d2e6e8;
        filled[4] = 0x1ca4871c7cc7acfe59296750483cc268594f32da613adca382c2201e0c1bd604;
        filled[5] = 0x2eda626889cd1efe66185cbf277c76a21a816e70ce8e4c82d3926f33254ba3fe;
        filled[6] = 0x094adf2369efd0dfb5fb4a72a44786414459028e0365d8c6db42f207e2c1bf6e;
        filled[7] = 0x1788a70d3316253538f1c3f17fd44379944a6583878ba11174d5a6078ca2e4af;
        filled[8] = 0x091e45aeceb1aa26c9331ac955bfa751400275a9ff7fec50e5083870f28489ac;
        filled[9] = 0x22c41aa0bebb80126be10f3a52c7ddade3d1f708df0b975f1c75cb1b264e8656;
        filled[10] = 0x1c141b40603f7882660beda5d2901d9159ae46cd13b41ba61329e37f61d1d052;
        filled[11] = 0x05d62df02371e3c063c48950fd2a269c0d1b09846d143c6f1ad9ca13c7e803ce;
        filled[12] = 0x221098b514a4054f1ea798441ccc84951a74c96b137e1315d330a9ed4dc93582;
        filled[13] = 0x085f5bedc1ffaf70f9e9f588cdf236d080d46db15ea1f82ab5381587de5c3518;
        filled[14] = 0x2f0ac1ce138c6cc2090039bf4a0cb5306c7a6fbf50e9250a7df7aa7fb1494a68;
        filled[15] = 0x0e6a7a92804ba0b464d4149eb123b554f679b682b2ffab84f004cb3699f4bf01;
        filled[16] = 0x27717133b46e78d189781fa4326151b927352a44bf36effd302b2202300f8d91;
        filled[17] = 0x080aa405d25f32064451854bf236a9556b40cfd0f40438e282ba984600a6d09c;
        filled[18] = 0x0873ebf4fce085965077627410af6f25666d2abbc4c249b978a2de2c9391d432;
        filled[19] = 0x2b42d5e84212239d816ec89eff842c3dfdbdef36ed1154ad315660d9b092f010;
        filled[20] = 0x24403af0500aa601efeadbc45985b7679559da543ca5a57e8e3861cb60608b4c;
        filled[21] = 0x18b076b3c7b082f7c38dd406f62f5125d21de3b83a9927586124208e1faf02b5;
        filled[22] = 0x1d2eee03d37621d8ef073623afcb71dc9519ff4c6fdab8a97ccb1933c9199264;
        filled[23] = 0x09c94b8f8f631a6795d8f3c4663457802c1d14251b0cc23848a30b4feb6b22d9;
        filled[24] = 0x112e367a372985654134df2f6bdd8d15aab508a2558019b052c429912559d212;
        filled[25] = 0x020542d863f0a063a24149fce9a561d75422c1c2c4352b2f8128592f41a6a80b;
        filled[26] = 0x265f835521f79df52a588c1fee02ebc5f2c7994b082c4791ca46f6ec1799ecd6;
        filled[27] = 0x02916eac6c0ebddde315b030b30225536db15edfae1454ad27dbf669da88b45b;
        filled[28] = 0x12f1f3f93117a52a67afebba558e24dc63285f775286e67affa33d3bf4ba9390;
        filled[29] = 0x2dddacdedb11ceb277ac810dde04995f67efb4141d97328177fe469c3c79c459;
        filled[30] = 0x0b44f76c30e36c10133074492a4dcabad3871410d346750b1f37c37b78761048;
        filled[31] = 0x27519d6e15e34fcbb092050ef05e4ccc5fed40a80ded74d9eaadf2c9bfff21a3;
    }

    function kat1() internal pure returns (uint256 size, bytes32[32] memory filled, bytes32 r) {
        size = 6;
        r = 0x144ec31c8d008d7d77958b18224dfe425249f7fc74dc929ff59da97f0767bf05;
        filled[0] = 0x0000000000000000000000000000001ef0727c4eb970d523f9ba2f0ed945fc6b;
        filled[1] = 0x16ebebb921082870f500d4e29c62ebe59e574c7b5acb14375af4f78db31a15d2;
        filled[2] = 0x2c641815739ff5e0383f5bf63aec83a79341585e38c2eeaa1500cd8dc3d6aa09;
        filled[3] = 0x150696281291698660401d32729c517ff83c95c7825e7dbbf3c0b658c95b9577;
        filled[4] = 0x1e4ce45c8cfce90769087ad08eff2ee177d6e74f9fb2037753baf1d4e5207cff;
        filled[5] = 0x031fd9ebb3ddf9aeff36b99ad4c63dc3dae14851837bbba32697ed38ade29e36;
        filled[6] = 0x0aede93845835fb18e2d4d0f0d8afa1f4178cde6124c9a3bec0c73876dbe8056;
        filled[7] = 0x0918e5431524732e9eab3d007e2e01abd73fa3a0a0a602ded613400050a0f75d;
        filled[8] = 0x1c25fd710fdb4ddce91c926c3c66e3be01ebc83c8f0af57e49fab4376c39128c;
        filled[9] = 0x2a5bee7afac63bcb719868fb54cb4f08dfc3bdeaa4033692514b31a77baa8ac0;
        filled[10] = 0x2c8a7fe686b990838e5cdd134a4965a0edec73543f67b088b5e342c5e2c594bc;
        filled[11] = 0x186872871e9b8ed4f7888bd46e9fedee72068b0b4a3b9e5c9c0666bae6cdc895;
        filled[12] = 0x2581de9b44eb28dbb478897550389549c9f98378ec2cce026e692e633a954531;
        filled[13] = 0x2c6cf9797943246d23ea47f1f2c238323cacf7657f12a15e594e29dfc24f1f45;
        filled[14] = 0x1d64ac13096c0dca5c82d4569f8bf323304ec5c2d0d7d69b94ddd74281417f93;
        filled[15] = 0x19ac1259d65763b42c3d6a6c9d02405e67cbed4e1cf537c4530f6ddadabe04b8;
        filled[16] = 0x1df275d876fc8ef3a9e4ad6242c0071966b8e3a4ed4d629031aca3e6a22e0ad1;
        filled[17] = 0x2edc62d821ead039950a9a8e35d4d3fde289669f843431d44f76ced5f3b4ad38;
        filled[18] = 0x261242b3f1a0423f8b4a05f890478690723bae6734848ff9792006264b54c9b2;
        filled[19] = 0x12fbb70f9a23608b8dd61ce664bbb3ea4a6a036c3251c6d110a1dd6e862bc116;
        filled[20] = 0x02aa34a56584c589258a4378958fe9b5e5aef3c53e13b309f8ce0d0cbf0ccca5;
        filled[21] = 0x090ef6412ec7fc6fa6f2bdff4d56371163cda630e5bc411410d0b7149dd1eab6;
        filled[22] = 0x2c1088751a914c677a0cd245e0f7ef7a0d695fdfe2f607f81a507a860d598f27;
        filled[23] = 0x161df4dc0ec370f2e810a961111bdbcdd0c5d8799070e2ea5825e68a0c7243d2;
        filled[24] = 0x0f2c6d6e2f40b5c6c3773f23fca5ff4d5741b610488390d04c364c8bd7456c42;
        filled[25] = 0x04543b1ccbd6e42d495556106437afe0e54659ccd20b760b63b0061ccb7ba670;
        filled[26] = 0x06993fabd03232fe010f0c8797f1265498339b7a4adca799074b6ad9df092cef;
        filled[27] = 0x03d6e25d71fe6088891b710baa491680b08063e66c96652ac98b609eec6a5554;
        filled[28] = 0x177702f7dceebd83ba836fd8ec6b686ab80d9e6500d2a75fd13cd05da8712a6a;
        filled[29] = 0x017875eb827fd5cf853dbc9613be37948429b2fdad40ceab95793b6631eaea27;
        filled[30] = 0x059bf75ca56f50dff91ca762f0da7f30ee98ffe67f06c9a49d1922f817f19c1c;
        filled[31] = 0x050231bce66ebfde86d95f793c3cf351e3991852fdd7b6860de8620bebc127b3;
    }

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

    function kat3() internal pure returns (uint256 size, bytes32[32] memory filled, bytes32 r) {
        size = 25474;
        r = 0x29209890d376469a779f115b39e9ad8b2c8a629575b4d37faec8b8e19a4505a9;
        filled[0] = 0x0000000000000000000000000ff8efa95ef2b51ad7cabd5529837185953e7817;
        filled[1] = 0x27652f5010bedea377a546859374a37aedea6c573677ff846cbdca82820517f0;
        filled[2] = 0x155d4aa8e09757ad1643e3eef3202fd68681a23a0a6d9c97277a9d73b7ea19d4;
        filled[3] = 0x290c559f5c6369949ecc43290b522f04a4d2ce98bfe4d29d9e7b502f7d9eece5;
        filled[4] = 0x024c23e713cf4aab516eb523d105593cd1b1f06cd32af088bc0d6e38ea09b0d4;
        filled[5] = 0x025c15763deb1c9ba3bc27e4e0660f99ebcdb500bc0b747f918f38d9693575f7;
        filled[6] = 0x2018075f7e675fc851a96f648d82e9e5bb9614a50397e49a20cc3d9b8ab600e9;
        filled[7] = 0x08be78de8b29f9161ea53923494a337e5c28585929b6633c357c99d8427c5b73;
        filled[8] = 0x0fa61c64e0968cc2080f0628170a9464c57487fc7ef979890d38b4bf6a61e162;
        filled[9] = 0x20fe023d0ed463b108bcdb1794b03cba8bab01e9acc17ccb86e973bd97e4d3f9;
        filled[10] = 0x22964ecd916872dcfe0727f3e7ac7771aa037fa11241194001e477eca6c17326;
        filled[11] = 0x1443dc218d25c49156634908ec0b48177ac1079a40012a1d608bddf23cfaf0f8;
        filled[12] = 0x2367bb7a0d60bc2ab04a5392482875cc50767ddf7ac767efcaa856b591d038ac;
        filled[13] = 0x09818350dc5b8c1aa3c60328d3a8c1b5b9656f8e127bef5f892081e738ae36b2;
        filled[14] = 0x024b9d9e3d824db9e320bfe91e79b0c13143c27c2cf20ce37880f533c7a43205;
        filled[15] = 0x2766f7ca2baa7eb6a88adfe4be06c664ae1bd977d3602770ccdf91a43604ed80;
        filled[16] = 0x004431fcbc55fdebc3b93f6af8f077349a5412f77bce797886fec54ac0894dfc;
        filled[17] = 0x06d8aef702e090d3ef98ff70043cd8780a7cf148aeef51740969f34bbfc6daf7;
        filled[18] = 0x28118c88183d42f7e5dc455d6e3c2d3ad83b5b7fd7f3487a7702b49cc9328159;
        filled[19] = 0x0eb3152d424648425072e4ef48e6c094bbb1761119e44428d592b86ee65fd7cf;
        filled[20] = 0x0822070d1eac1f9d7bb2fe27b50c95a2d322fbe58560cca3e6041b7df4e898ca;
        filled[21] = 0x18d83e5f614fb16fc79f808c38697372cc1dec60f80d9dc548e5434772c48511;
        filled[22] = 0x2dc58fee58b98b3b28f1ba22e12498c5489357a7bc3103025753e1230bb806c0;
        filled[23] = 0x0d337825f01e9c067af53c84487de83a3b44f7f421874a3bca7d30c5f575bd7e;
        filled[24] = 0x24784329375677c1cc92e272c658d490adc7a9faea7befc422f6d9069f21cea7;
        filled[25] = 0x0ad2c0b41ecb8415641683bc63a68c0ea8075cb11b3a59e6f99daa0541ac341a;
        filled[26] = 0x2c06deb5ed54d6cb6b9754eaec1871820fb7453ffeb9ade0bdee2bf1dcfd2704;
        filled[27] = 0x2240037f90833c2dd5ce0a34fda2b594c7ba7ad8bf4a063477765f2b31ad35ba;
        filled[28] = 0x2aa793abb0c5886aa7fd8cfb273f0fb457719f3aad40e1171137714964e73ff4;
        filled[29] = 0x2d3209f307629827ced07e58b2ebca817d45092cac77b3541244781fa6001a0b;
        filled[30] = 0x194320dacbcfdb1745b6feb49abe56ebfb529b51fd4db237325d9391b293cec9;
        filled[31] = 0x0f9c6d6975a791ffe7f59052ad4e1a0c50cb8c959d2adaf591246d6799ab0226;
    }

    function setUp() public {
        pool = new RootsMock();
        cp = new TacitEvmPoolCheckpoints(ITacitEvmPoolRoots(address(pool)));
        vm.roll(1000);
        vm.warp(1_700_000_000);
    }

    function testZerosFoldToThePoolsEmptyRoot() public {
        assertEq(cp.zero(0), 0);
        // Size 2 is one pair of empty leaves: its edge is all zeros, and the pool's empty root is the root of an
        // empty tree of any size, so posting it under count 2 is the fold of the empty leaf against every empty subtree.
        bytes32[32] memory none;
        pool.hold(bytes32(EMPTY_ROOT), 2);
        vm.expectRevert(bytes("unknown root"));
        cp.post(2, 900, none);
        none[1] = bytes32(ZERO1);
        cp.post(2, 900, none);
        assertEq(cp.latest(), 2);
        assertEq(cp.zero(1), 0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864);
        assertEq(cp.zero(31), 0x1bbeb01b4c479ecde76917645e404dfa2e26f90d0afc5a65128513ad375c5ff2);
    }

    function testRootsMatchThePagesTree() public {
        (uint256 s0, bytes32[32] memory f0, bytes32 r0) = kat0();
        (uint256 s1, bytes32[32] memory f1, bytes32 r1) = kat1();
        (uint256 s2, bytes32[32] memory f2, bytes32 r2) = kat2();
        (uint256 s3, bytes32[32] memory f3, bytes32 r3) = kat3();
        pool.hold(r0, s0);
        pool.hold(r1, s1);
        pool.hold(r2, s2);
        pool.hold(r3, s3);
        // Each post lands only if the fold here gives the root the page's tree gave.
        cp.post(s0, 10, f0);
        cp.post(s1, 20, f1);
        cp.post(s2, 30, f2);
        uint256 g = gasleft();
        cp.post(s3, 40, f3);
        emit log_named_uint("post gas", g - gasleft());
        assertEq(cp.latest(), s3);
    }

    function testPostKeepsOnlyWhatThePoolHeld() public {
        (uint256 s, bytes32[32] memory f, bytes32 r) = kat2();
        // A root the pool never held: the pool's own revert comes through.
        vm.expectRevert(bytes("unknown root"));
        cp.post(s, 900, f);
        pool.hold(r, s);
        // The same edge under another count folds to another root, one the pool never held.
        vm.expectRevert(bytes("unknown root"));
        cp.post(s + 2, 900, f);
        bytes32[32] memory bad;
        for (uint256 i; i < 32; ++i) bad[i] = f[i]; // a copy: assigning a memory array aliases it
        bad[3] = bytes32(uint256(bad[3]) ^ 1); // a level the fold reads for this count (1000 = 0b1111101000)
        vm.expectRevert(bytes("unknown root"));
        cp.post(s, 900, bad);
        // A root the pool held at another count than the one posted.
        pool.hold(r, s + 4);
        vm.expectRevert(TacitEvmPoolCheckpoints.NotHeld.selector);
        cp.post(s, 900, f);
        pool.hold(r, s);
        vm.expectRevert(TacitEvmPoolCheckpoints.NotEven.selector);
        cp.post(s + 1, 900, f);
        vm.expectRevert(TacitEvmPoolCheckpoints.NotEven.selector);
        cp.post(0, 900, f);
        vm.expectRevert(TacitEvmPoolCheckpoints.BadBlock.selector);
        cp.post(s, uint256(type(uint64).max) + 1, f);

        vm.expectEmit(true, true, false, true);
        emit TacitEvmPoolCheckpoints.Posted(s, 900, address(this));
        cp.post(s, 900, f);
        assertEq(cp.latest(), s);
        (uint256 b, uint256 prev, bytes32[32] memory got) = cp.pointAt(s);
        assertEq(b, 900);
        assertEq(prev, 0);
        assertEq(cp.postedAt(s), 1_700_000_000);
        for (uint256 i; i < 32; ++i) assertEq(got[i], f[i]);

        vm.expectRevert(TacitEvmPoolCheckpoints.Known.selector);
        cp.post(s, 901, f);
    }

    /// On an Arbitrum chain `block.number` is the parent chain's, far below the chain's own block numbers the poster names.
    function testABlockNumberAheadOfThisChainsIsAccepted() public {
        (uint256 s, bytes32[32] memory f, bytes32 r) = kat1();
        pool.hold(r, s);
        cp.post(s, 90_000_000, f);
        (uint256 b,,) = cp.pointAt(s);
        assertEq(b, 90_000_000);
    }

    function testLatestAndTheChainBack() public {
        (uint256 s1, bytes32[32] memory f1, bytes32 r1) = kat1();
        (uint256 s2, bytes32[32] memory f2, bytes32 r2) = kat2();
        (uint256 s3, bytes32[32] memory f3, bytes32 r3) = kat3();
        pool.hold(r1, s1);
        pool.hold(r2, s2);
        pool.hold(r3, s3);
        cp.post(s2, 500, f2);
        cp.post(s3, 800, f3);
        assertEq(cp.latest(), s3);
        (, uint256 p3,) = cp.pointAt(s3);
        assertEq(p3, s2);
        // An older count posted later does not become the newest, and points at what was newest then.
        cp.post(s1, 100, f1);
        assertEq(cp.latest(), s3);
        (, uint256 p1,) = cp.pointAt(s1);
        assertEq(p1, s3);
        (uint256 b0, uint256 p0, bytes32[32] memory f0) = cp.pointAt(4);
        assertEq(b0, 0);
        assertEq(p0, 0);
        assertEq(f0[0], bytes32(0));
    }
}
