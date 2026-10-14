// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// The confidential pool's reserve layout for local chains: `pools` sits at storage slot 74, as in the live pool, with
/// the same struct, so TacAmmOracle's slot arithmetic is real and `eth_getProof` proves its reserves. Only what the
/// oracle's constructor and `spot()` read is implemented.
contract TacMockV1 {
    struct Pool {
        bool init;
        bytes32 assetA;
        bytes32 assetB;
        uint256 reserveA;
        uint256 reserveB;
        uint32 feeBps;
        uint256 totalShares;
    }

    struct Asset {
        bool registered;
        address underlying;
        uint256 unitScale;
    }

    uint256[74] internal _pad; // slots 0..73
    mapping(bytes32 => Pool) public pools; // slot 74
    mapping(bytes32 => Asset) internal _assets;

    function setAsset(bytes32 id, address underlying, uint256 scale) external {
        _assets[id] = Asset(true, underlying, scale);
    }

    function setPool(bytes32 id, bytes32 a, bytes32 b, uint256 ra, uint256 rb) external {
        pools[id] = Pool(true, a, b, ra, rb, 30, 1);
    }

    function assets(bytes32 id) external view returns (bool, address, uint256, bytes32, bool, uint8) {
        Asset memory a = _assets[id];
        return (a.registered, a.underlying, a.unitScale, bytes32(0), false, 18);
    }
}
