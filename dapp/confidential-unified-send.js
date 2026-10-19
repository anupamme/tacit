
import { scanHealth } from './confidential-scan-health.js';
import { shownTicker } from './confidential-deployments.js';

function shortfallReason(base, diag) {
  const h = scanHealth(diag);
  return h.ok ? base : `${base}. ${h.text}`;
}

export function makeUnifiedSend(deps) {
  const {
    parseRecipient,
    currentNetworkName,
    isCrosslaneConfigured,
    buildAndBroadcastCXferMulti,
    sendSats,
    getPoolUx,
  } = deps;

  function laneOfAsset(asset) {
    if (!asset) return null;
    if (asset.kind === 'sats') return 'sats';
    if (asset.kind === 'btc')  return 'btc';
    if (asset.kind === 'pool') return 'evm';
    return null;
  }

  function chainHintForAsset(asset) {
    const lane = laneOfAsset(asset);
    if (lane === 'evm') return 'evm';
    if (lane === 'btc' || lane === 'sats') return 'btc';
    return undefined;
  }

  function resolveLeg(parsed, asset) {
    const lane = laneOfAsset(asset);
    if (parsed.kind === 'tacit') {
      if (lane === 'evm') {
        if (!parsed.lanes.evm) return { error: 'this Tacit address does not advertise an Ethereum lane' };
        return { path: 'evm-transfer', pubHex: '0x' + bytesHex(parsed.lanes.evm.ownerPub) };
      }
      if (lane === 'sats') {
        return { path: 'sats-sp', scanPub: parsed.lanes.btc.scanPub, spendPub: parsed.lanes.btc.spendPub };
      }
      return { path: 'cxfer-pubkey', pubHex: bytesHex(parsed.lanes.btc.spendPub) };
    }
    if (lane === 'evm') {
      if (parsed.path !== 'evm-transfer') return { error: 'recipient is not an Ethereum shielded pubkey' };
      return { path: 'evm-transfer', pubHex: parsed.pubHex };
    }
    if (lane === 'sats') {
      if (parsed.path === 'sats-p2wpkh' || parsed.path === 'sats-sp') return { ...parsed };
      return { error: 'sats sends go to a bech32 address or silent-payment address' };
    }
    if (parsed.path === 'cxfer-pubkey' || parsed.path === 'cxfer-stealth') return { ...parsed };
    return { error: 'recipient is not a Bitcoin asset target' };
  }

  function bytesHex(u8) {
    return Array.from(u8, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  async function dispatchSend({ wallet, recipientRaw, asset, amount, opts = {} }) {
    const network = currentNetworkName();
    const parsed = parseRecipient(recipientRaw, { network, chainHint: chainHintForAsset(asset) });

    if (parsed.kind === 'empty') return { ok: false, reason: 'enter a recipient' };
    if (parsed.kind === 'error') return { ok: false, reason: parsed.message };
    if (parsed.kind === 'ambiguous') {
      return { ok: false, ambiguous: true, candidates: parsed.candidates,
        reason: 'recipient pubkey is valid on both chains — choose Bitcoin or Ethereum' };
    }

    const lane = laneOfAsset(asset);
    if (!lane) return { ok: false, reason: 'choose an asset to send' };

    if (lane === 'evm' && !isCrosslaneConfigured(network)) {
      return { ok: false, blocked: true, reason: 'Ethereum sends are not live on this network yet' };
    }

    const leg = resolveLeg(parsed, asset);
    if (leg.error) return { ok: false, reason: leg.error };

    if (lane === 'btc') {
      const recipients = leg.path === 'cxfer-stealth'
        ? [{ stealthAddress: leg.raw, amount }]
        : [{ pubHex: leg.pubHex, amount }];
      const r = await buildAndBroadcastCXferMulti({ assetIdHex: asset.assetId, recipients, ...opts });
      return { ok: true, lane, path: leg.path, result: r };
    }

    if (lane === 'sats') {
      const r = await sendSats({ parsed: leg, amountSats: amount, opts });
      return { ok: true, lane, path: leg.path, result: r };
    }

    const ux = getPoolUx && getPoolUx();
    if (!ux) return { ok: false, blocked: true, reason: 'Ethereum pool is not available' };
    return await dispatchEvm({ wallet, ux, recipientPubHex: leg.pubHex, asset, amount, opts });
  }

  async function dispatchEvm({ wallet, ux, recipientPubHex, asset, amount, opts }) {
    const onPhase = opts.onPhase || (() => {});
    const ticker = asset.ticker || ux.tickerOf(asset.assetId) || 'cETH';
    const fee = opts.fee || 0n;

    const myPubHex = ux.identity(wallet.priv).pubHex;
    const isSelf = String(recipientPubHex).toLowerCase() === String(myPubHex).toLowerCase();

    if (!isSelf) return dispatchEvmStealth({ wallet, ux, recipientPubHex, asset, amount, opts, ticker });

    const bal = await ux.balance(wallet.priv);
    const notes = (bal.notes || []).filter((n) => n.asset === asset.assetId);
    const shielded = notes.reduce((s, n) => s + BigInt(n.value), 0n);
    const need = amount + fee;

    if (shielded < need) {
      if (!opts.allowWrap) {
        return { ok: false, reason: shortfallReason(`insufficient shielded ${shownTicker(ticker)}; enable wrap-and-send to top up from your balance`, bal.diag) };
      }
      const shortfall = need - shielded;

      if (shielded === 0n && ux.wrapAndSend && ux.routerConfigured && ux.routerConfigured()) {
        onPhase({ phase: 'wrap-and-send', ticker, atomic: true });
        const r = await ux.wrapAndSend({
          walletPriv: wallet.priv, amountWei: shortfall, ticker, recipientPubHex, amount, fee,
        });
        return { ok: true, lane: 'evm', path: 'wrap-and-settle', atomic: true, result: r };
      }

      onPhase({ phase: 'wrap', shortfall, ticker });
      const wrapFn = (ux.routerConfigured && ux.routerConfigured() && ux.routerWrap) ? ux.routerWrap : ux.wrap;
      await wrapFn.call(ux, { walletPriv: wallet.priv, amountWei: shortfall, ticker });
      await pollForBalance(ux, wallet.priv, asset.assetId, need, opts);
    }

    onPhase({ phase: 'send', ticker });
    const fresh = await ux.balance(wallet.priv);
    const picked = selectNotes((fresh.notes || []), asset.assetId, need);
    if (!picked) return { ok: false, reason: 'shielded balance did not settle in time; retry the send' };
    const r = await ux.transfer({
      walletPriv: wallet.priv, notes: picked, recipientPubHex, amount, fee,
      selfRelay: !!opts.selfRelay, waitOpts: opts.waitOpts,
    });
    return { ok: true, lane: 'evm', path: 'evm-transfer', result: r };
  }

  async function dispatchEvmStealth({ wallet, ux, recipientPubHex, asset, amount, opts, ticker }) {
    const onPhase = opts.onPhase || (() => {});
    const bal = await ux.balance(wallet.priv);
    const myAssetNotes = (bal.notes || []).filter((n) => n.asset === asset.assetId);
    const usable = myAssetNotes.some((n) => BigInt(n.value) >= amount);

    let sendNotes = usable ? myAssetNotes : null;
    if (!sendNotes) {
      if (!opts.allowWrap) {
        return { ok: false, reason: shortfallReason(`no single existing ${shownTicker(ticker)} note covers that amount; enable wrap-and-send to fund a fresh one`, bal.diag) };
      }
      const unitScale = BigInt((ux.assetByTicker[ticker] || {}).unitScale || '1');
      onPhase({ phase: 'wrap', shortfall: amount, ticker });
      const wrapFn = (ux.routerConfigured && ux.routerConfigured() && ux.routerWrap) ? ux.routerWrap : ux.wrap;
      await wrapFn.call(ux, { walletPriv: wallet.priv, amountWei: amount * unitScale, ticker });
      const ok = await pollForBalance(ux, wallet.priv, asset.assetId, amount, opts);
      if (!ok) return { ok: false, reason: 'the wrap did not settle in time; retry the send' };
      const fresh = await ux.balance(wallet.priv);
      sendNotes = (fresh.notes || []).filter((n) => n.asset === asset.assetId);
    }

    onPhase({ phase: 'lock', ticker });
    const r = await ux.stealthSend({
      walletPriv: wallet.priv, recipientPubHex, notes: sendNotes, amount,
      selfRelay: !!opts.selfRelay, waitOpts: opts.waitOpts, onBuilt: opts.onBuilt,
    });
    return { ok: true, lane: 'evm', path: 'stealth-lock', result: r };
  }

  function selectNotes(notes, assetId, need) {
    const pool = notes.filter((n) => n.asset === assetId)
      .sort((a, b) => (BigInt(b.value) - BigInt(a.value) > 0n ? 1 : -1));
    const picked = [];
    let sum = 0n;
    for (const n of pool) { picked.push(n); sum += BigInt(n.value); if (sum >= need) break; }
    return sum >= need ? picked : null;
  }

  async function pollForBalance(ux, priv, assetId, need, opts) {
    const tries = opts.wrapPollTries || 30;
    const delayMs = opts.wrapPollDelayMs || 4000;
    for (let i = 0; i < tries; i++) {
      const bal = await ux.balance(priv);
      const have = (bal.notes || []).filter((n) => n.asset === assetId)
        .reduce((s, n) => s + BigInt(n.value), 0n);
      if (have >= need) return true;
      await new Promise((res) => setTimeout(res, delayMs));
    }
    return false;
  }

  return { dispatchSend, laneOfAsset, chainHintForAsset, resolveLeg };
}
