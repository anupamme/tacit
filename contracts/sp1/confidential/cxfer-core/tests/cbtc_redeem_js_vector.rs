//! Runs a redeem reveal built by dapp/cbtc-redeem.js through the guest's own functions: extract_taproot_envelope,
//! parse_cbtc_redeem_envelope, scan_tx_spends, fold_cbtc_redeem and the rug scan. The JS test writes the vector when
//! CBTC_REDEEM_VECTOR_OUT is set; run this with CBTC_REDEEM_VECTOR=<file>. A valid redeem retires the lock; a forged kernel
//! signature is rejected and the same transaction then reads as a rug.
use cxfer_core::bitcoin;
use cxfer_core::*;

fn arr32(h: &str) -> [u8; 32] {
    let b = hex::decode(h.trim_start_matches("0x")).unwrap();
    b.try_into().unwrap()
}
fn raw_txid(display: &str) -> [u8; 32] {
    let mut a = arr32(display);
    a.reverse();
    a
}

#[test]
fn js_built_redeem_folds_as_an_honest_exit() {
    let Ok(path) = std::env::var("CBTC_REDEEM_VECTOR") else {
        eprintln!("CBTC_REDEEM_VECTOR not set; skipping");
        return;
    };
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let tx = hex::decode(v["revealHex"].as_str().unwrap()).unwrap();
    let auth = arr32(v["authKey"].as_str().unwrap());
    let lock_txid = raw_txid(v["lock"]["txid"].as_str().unwrap());
    let lock_vout = v["lock"]["vout"].as_u64().unwrap() as u32;
    let lock_value = v["lock"]["value"].as_u64().unwrap();

    // the envelope, read where the guest reads it (vin[0].witness[1])
    let env = bitcoin::extract_taproot_envelope(&tx).expect("envelope at vin0");
    let rd = bitcoin::parse_cbtc_redeem_envelope(&env).expect("a 109-byte 0x67 frame");
    assert_eq!(rd.lock_txid, lock_txid, "lock_txid is the raw txid bytes, as the vin carries them");
    assert_eq!(rd.lock_vout, lock_vout);
    assert_eq!(rd.v_btc, lock_value);

    // the live set: the notes, keyed by raw outpoint, asset cBTC.zk, spend authority the key's x-only form
    let mut openings = std::collections::HashMap::new();
    let mut entries = Vec::new();
    for n in v["notes"].as_array().unwrap() {
        let txid = raw_txid(n["txid"].as_str().unwrap());
        let vout = n["vout"].as_u64().unwrap() as u32;
        let (cx, cy) = (arr32(n["cx"].as_str().unwrap()), arr32(n["cy"].as_str().unwrap()));
        let key = outpoint_key(&txid, vout);
        entries.push((key, commitment_hash(&cx, &cy), CBTC_ZK_ASSET_ID, auth));
        openings.insert(key, (cx, cy));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    let fresh = || {
        let mut st = ScanReflection::genesis();
        let lk = outpoint_key(&lock_txid, lock_vout);
        let mut v32 = [0u8; 32];
        v32[24..].copy_from_slice(&lock_value.to_be_bytes());
        st.cbtc_locks = LiveUtxoSet::from_sorted(vec![(lk, v32, CBTC_ZK_ASSET_ID, [0u8; 32])]).unwrap();
        st.cbtc_backing_sats = lock_value;
        st.live = LiveUtxoSet::from_sorted(entries.clone()).unwrap();
        st
    };
    let run = |st: &mut ScanReflection, kernel_sig: &[u8; 64]| {
        // vin scan, in vin order, each opening bound to the stored commitment (a forged opening is a hard reject)
        let ins = bitcoin::extract_inputs(&tx).unwrap();
        let mut order = ins.iter().filter_map(|(t, o)| openings.get(&outpoint_key(t, *o)).copied()).collect::<Vec<_>>().into_iter();
        let spends = scan_tx_spends(&tx, &mut st.live, &[0u8; 32], || order.next().unwrap()).expect("scan");
        assert_eq!(spends.len(), v["notes"].as_array().unwrap().len(), "every note the JS spends is a live pool note");
        let cbtc: Vec<_> = spends.iter().filter(|s| s.asset == CBTC_ZK_ASSET_ID).collect();
        let in_ops: Vec<_> = cbtc.iter().map(|s| (s.prev_txid, s.prev_vout)).collect();
        let in_pts: Vec<_> = cbtc.iter().map(|s| from_affine_xy(&s.cx, &s.cy).unwrap()).collect();
        let r = st.fold_cbtc_redeem(&rd.lock_txid, rd.lock_vout, rd.v_btc, &ins, &in_ops, &in_pts, kernel_sig);
        let rug = st.fold_cbtc_lock_spends(&tx);
        (r, rug)
    };

    // honest: retires the lock and the rug scan finds nothing
    let mut st = fresh();
    let (r, rug) = run(&mut st, &rd.kernel_sig);
    assert_eq!(r, Ok(outpoint_key(&lock_txid, lock_vout)), "the guest folds the JS-built redeem");
    assert!(rug.is_empty(), "a valid redeem is never a rug");
    assert_eq!(st.cbtc_backing_sats, 0);

    // tampered kernel signature: rejected, and the same transaction now reads as a rug
    let mut bad = rd.kernel_sig;
    bad[10] ^= 1;
    let mut st = fresh();
    let (r, rug) = run(&mut st, &bad);
    assert!(r.is_err(), "a forged kernel signature is rejected");
    assert_eq!(rug, vec![outpoint_key(&lock_txid, lock_vout)], "...and the lock spend is then folded as a rug (the failure the JS checks prevent)");
}
