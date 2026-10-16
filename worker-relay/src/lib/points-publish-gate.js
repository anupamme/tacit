// When a changed reward tree is published to the distributor. A UTC day that has just settled is published at once. Later
// changes to the same history (task credits, late credits, ledger adjustments) wait until `minIntervalSecs` after the last
// publish, so a run of them reaches the chain as one root rather than a transaction each: the setter's gas and the number of
// roots a claimant's proof can go stale against stay bounded however many credits arrive.
//
// settledDay: the last day folded into the ledger. publishedThroughDay: the last settled day the last publish covered
// (-Infinity before any publish by this process, so the first publish after a start is never held).
export function mayPublishRoot({ nowSec, lastPublishSec, minIntervalSecs, settledDay, publishedThroughDay }) {
  if (settledDay > publishedThroughDay) return true;
  return nowSec - lastPublishSec >= minIntervalSecs;
}
