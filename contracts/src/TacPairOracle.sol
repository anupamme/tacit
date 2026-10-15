// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

interface ITacVenueOracle {
    function POOL() external view returns (address);
    function STEP() external view returns (uint256);
    function SHORT_WINDOW() external view returns (uint256);
    function WINDOW() external view returns (uint256);
    function MAX_WINDOW() external view returns (uint256);
    function prices(uint256 window) external view returns (uint256 low, uint256 high);
    function recovery(uint256 window) external view returns (uint256);
    function depthMin(uint256 window) external view returns (uint256);
    function latest() external view returns (uint256);
    function spot() external view returns (uint256);
}

/// @title TacPairOracle
/// @notice Two venue oracles over different pools, combined so that moving a view takes moving both venues:
///           - `prices`: the lower of the lows and the higher of the highs;
///           - `recovery`: the higher of the lows;
///           - `spot`, `latest`, `depthMin`: the lower of the two.
///         A venue without a price leaves the pair without one. A venue that stops tracking the market (retired,
///         drained, frozen, or held above it) keeps pinning the highs and the recovery price, so vaults priced by the
///         pair must be wound down, or moved to another oracle, before either venue is retired. The venues must share
///         their interval and windows. No owner and no settings.
contract TacPairOracle {
    ITacVenueOracle public immutable A;
    ITacVenueOracle public immutable B;
    uint256 public immutable STEP;
    uint256 public immutable SHORT_WINDOW;
    uint256 public immutable WINDOW;
    uint256 public immutable MAX_WINDOW;

    error BadConfig();

    constructor(address a, address b) {
        if (a == b || a.code.length == 0 || b.code.length == 0) revert BadConfig();
        if (ITacVenueOracle(a).POOL() == ITacVenueOracle(b).POOL()) revert BadConfig();
        A = ITacVenueOracle(a);
        B = ITacVenueOracle(b);
        uint256 step = ITacVenueOracle(a).STEP();
        uint256 short = ITacVenueOracle(a).SHORT_WINDOW();
        uint256 window = ITacVenueOracle(a).WINDOW();
        uint256 maxWindow = ITacVenueOracle(a).MAX_WINDOW();
        if (
            ITacVenueOracle(b).STEP() != step || ITacVenueOracle(b).SHORT_WINDOW() != short
                || ITacVenueOracle(b).WINDOW() != window || ITacVenueOracle(b).MAX_WINDOW() != maxWindow
        ) revert BadConfig();
        STEP = step;
        SHORT_WINDOW = short;
        WINDOW = window;
        MAX_WINDOW = maxWindow;
    }

    function prices(uint256 window) external view returns (uint256 low, uint256 high) {
        (uint256 lowA, uint256 highA) = A.prices(window);
        (uint256 lowB, uint256 highB) = B.prices(window);
        low = FixedPointMathLib.min(lowA, lowB);
        high = FixedPointMathLib.max(highA, highB);
    }

    function recovery(uint256 window) external view returns (uint256) {
        return FixedPointMathLib.max(A.recovery(window), B.recovery(window));
    }

    function depthMin(uint256 window) external view returns (uint256) {
        return FixedPointMathLib.min(A.depthMin(window), B.depthMin(window));
    }

    function latest() external view returns (uint256) {
        return FixedPointMathLib.min(A.latest(), B.latest());
    }

    function spot() external view returns (uint256) {
        return FixedPointMathLib.min(A.spot(), B.spot());
    }
}
