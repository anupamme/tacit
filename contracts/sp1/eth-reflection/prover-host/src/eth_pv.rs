// The eth-reflection guest's public values, computed here from its program input (the two CBOR buffers eth_prove writes into
// the SP1Stdin) with the same transitions the guest applies (contracts/sp1/eth-reflection/src/main.rs): the light-client
// updates and finality update on the resumed store, the cross-out IMT inserts, the consumed and message appends, and the two
// accumulator digests. A proof of that guest made somewhere else (the prover board) is used only when its public values are
// these bytes, so a proof of another input is refused before anything is published.
//
// What the guest only asserts (the storage proofs, the per-slot witness binding, the completeness counts against the
// on-chain counters) is not repeated: it cannot change the public values, it can only make the guest refuse, and a proof
// exists only for an input the guest accepted. tests: eth_prove's SP1_PROVER=expect on a recorded network request, whose
// proof's public values these must equal byte for byte (.github/workflows/build-eth-prover.yml).

use alloy_primitives::{Address, B256};
use anyhow::{anyhow, ensure, Result};
use cxfer_core::eth_reflection::{
    eth_consumed_leaf, eth_crossout_leaf, eth_message_leaf, eth_refl_digest, EthConsumed, EthCrossOut, EthMessage,
};
use cxfer_core::{imt_insert_transition, keccak_tree_append_transition};
use helios_consensus_core::{apply_finality_update, apply_update, verify_finality_update, verify_update};
use serde::Deserialize;
use sp1_helios_primitives::types::ProofInputs;
use tree_hash::TreeHash;

// The guest's EthReflInputs, read by field name (serde_cbor), as eth_prove writes it.
#[derive(Deserialize)]
struct EthReflInputs {
    pool: Address,
    prior_set_root: B256,
    prior_count: u64,
    crossouts: Vec<CrossOutWitness>,
    prior_consumed_root: B256,
    prior_consumed_count: u64,
    consumeds: Vec<ConsumedWitness>,
    outbox: Address,
    prior_msg_root: B256,
    prior_msg_count: u64,
    messages: Vec<MessageWitness>,
}
#[derive(Deserialize)]
struct CrossOutWitness {
    claim_id: B256,
    dest_chain: u16,
    dest_commitment: B256,
    #[allow(dead_code)]
    nullifier: B256,
    asset_id: B256,
    low_value: B256,
    low_next: B256,
    low_index: u64,
    low_path: Vec<B256>,
    new_index: u64,
    new_path: Vec<B256>,
}
#[derive(Deserialize)]
struct ConsumedWitness {
    nullifier: B256,
    spend_root: B256,
    append_path: Vec<B256>,
}
#[derive(Deserialize)]
struct MessageWitness {
    msg_id: B256,
    record: B256,
    append_path: Vec<B256>,
}

fn path(p: &[B256]) -> Vec<[u8; 32]> {
    p.iter().map(|x| x.0).collect()
}

/// The 14 ABI words the guest commits (EthReflectionPublicValues, 448 bytes), from the stdin's two buffers.
pub fn expected_public_values(lc: &[u8], ethr: &[u8]) -> Result<Vec<u8>> {
    let ProofInputs { updates, finality_update, expected_current_slot, mut store, genesis_root, forks, contract_storage: _ } =
        serde_cbor::from_slice(lc).map_err(|e| anyhow!("light-client input: {e}"))?;
    let ethr: EthReflInputs = serde_cbor::from_slice(ethr).map_err(|e| anyhow!("eth-reflection input: {e}"))?;

    // 1. The light client, as the guest runs it.
    let prev_head = store.finalized_header.beacon().slot;
    let prev_sync_committee = store.current_sync_committee.tree_hash_root();
    for u in updates.iter() {
        verify_update(u, expected_current_slot, &store, genesis_root, &forks).map_err(|e| anyhow!("update invalid: {e:?}"))?;
        apply_update(&mut store, u);
    }
    verify_finality_update(&finality_update, expected_current_slot, &store, genesis_root, &forks)
        .map_err(|e| anyhow!("finality update invalid: {e:?}"))?;
    apply_finality_update(&mut store, &finality_update);
    let head = store.finalized_header.beacon().slot;
    ensure!(head > prev_head, "finalized head did not advance");
    ensure!(head % 32 == 0, "new head is not a checkpoint slot");
    let exec_state_root: B256 =
        *store.finalized_header.execution().map_err(|_| anyhow!("execution payload missing"))?.state_root();
    let sync_committee = store.current_sync_committee.tree_hash_root();

    // 2. The three sets, folded in the order the guest folds them.
    let mut set_root = ethr.prior_set_root.0;
    let mut count = ethr.prior_count;
    for co in &ethr.crossouts {
        let leaf = eth_crossout_leaf(&EthCrossOut {
            claim_id: co.claim_id.0,
            dest_chain: co.dest_chain,
            dest_commitment: co.dest_commitment.0,
            asset_id: co.asset_id.0,
        });
        set_root = imt_insert_transition(
            &set_root, &leaf, &co.low_value.0, &co.low_next.0, co.low_index, &path(&co.low_path), co.new_index,
            &path(&co.new_path),
        )
        .ok_or_else(|| anyhow!("crossout imt insert transition"))?;
        count += 1;
    }
    let mut consumed_root = ethr.prior_consumed_root.0;
    let mut consumed_count = ethr.prior_consumed_count;
    for cw in &ethr.consumeds {
        let leaf = eth_consumed_leaf(&EthConsumed { nullifier: cw.nullifier.0, spend_root: cw.spend_root.0 });
        consumed_root = keccak_tree_append_transition(&consumed_root, consumed_count, &path(&cw.append_path), &leaf)
            .ok_or_else(|| anyhow!("consumed append transition"))?;
        consumed_count += 1;
    }
    let mut msg_root = ethr.prior_msg_root.0;
    let mut msg_count = ethr.prior_msg_count;
    for mw in &ethr.messages {
        let leaf = eth_message_leaf(&EthMessage { msg_id: mw.msg_id.0, record: mw.record.0 });
        msg_root = keccak_tree_append_transition(&msg_root, msg_count, &path(&mw.append_path), &leaf)
            .ok_or_else(|| anyhow!("message append transition"))?;
        msg_count += 1;
    }
    let pool = ethr.pool.as_slice();
    let prior_digest = eth_refl_digest(
        pool, ethr.prior_set_root.as_slice(), ethr.prior_count, ethr.prior_consumed_root.as_slice(),
        ethr.prior_consumed_count, ethr.prior_msg_root.as_slice(), ethr.prior_msg_count,
    );
    let new_digest = eth_refl_digest(pool, &set_root, count, &consumed_root, consumed_count, &msg_root, msg_count);

    // 3. abi.encode of the struct: 14 static words.
    let mut pv = Vec::with_capacity(14 * 32);
    let word = |pv: &mut Vec<u8>, b: &[u8]| {
        pv.extend(std::iter::repeat(0u8).take(32 - b.len()));
        pv.extend_from_slice(b);
    };
    word(&mut pv, &prior_digest);
    word(&mut pv, &new_digest);
    word(&mut pv, ethr.pool.as_slice());
    word(&mut pv, &set_root);
    word(&mut pv, &count.to_be_bytes());
    word(&mut pv, &head.to_be_bytes());
    word(&mut pv, exec_state_root.as_slice());
    word(&mut pv, sync_committee.as_slice());
    word(&mut pv, prev_sync_committee.as_slice());
    word(&mut pv, &consumed_root);
    word(&mut pv, &consumed_count.to_be_bytes());
    word(&mut pv, ethr.outbox.as_slice());
    word(&mut pv, &msg_root);
    word(&mut pv, &msg_count.to_be_bytes());
    Ok(pv)
}
