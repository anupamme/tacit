#!/usr/bin/env node
// Serves a page on localhost that deploys TacitAmmRoute from a browser wallet on Ethereum. The init code (from this checkout's forge build) goes
// through the deterministic CREATE2 proxy with one salt, so it lands at the address dapp/swap/route.js names whoever sends it, and code at that address
// can only be this init code. Before asking the wallet, the page dry-runs the deploy and sends only if it lands there. Once it is on chain the swap
// page offers any token into tacUSD and tacBTC by itself.
//   (cd contracts && forge build) && node contracts/script/deploy-amm-route.mjs [port]
import http from 'node:http';
import { ammRouteInit, SALT, PROXY } from '../../tests/amm-route-deploy.mjs';
import { TACIT_AMM, TACIT_AMM_ROUTE, WETH, POOL_ID, ZERO } from '../../dapp/swap/route.js';

const ETH_ID = POOL_ID[ZERO];
const CHAIN = { id: 1, name: 'Ethereum', rpc: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'], explorer: 'https://etherscan.io' };
if (process.env.RPC_1) CHAIN.rpc = [process.env.RPC_1];     // a local fork, for a dry run of this page
const data = SALT + ammRouteInit().slice(2);

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deploy TacitAmmRoute</title>
<style>
:root{--bg:#f7f6f2;--fg:#1d1c1a;--mut:#6b675f;--line:#dcd8cf;--ok:#1f7a4d;--bad:#a8322d;--btn:#1d1c1a;--btnfg:#f7f6f2}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--mut:#9a968c;--line:#33312d;--ok:#5cc28f;--bad:#e2786f;--btn:#ecebe6;--btnfg:#141413}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px}
h1{font-size:20px;margin:0 0 4px}p{margin:0 0 16px;color:var(--mut)}code{font:13px ui-monospace,monospace;word-break:break-all}
.row{border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:12px 0;display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.row b{display:block}.st{font-size:13px;color:var(--mut)}.ok{color:var(--ok)}.bad{color:var(--bad)}
button{background:var(--btn);color:var(--btnfg);border:0;border-radius:8px;padding:9px 14px;font:inherit;cursor:pointer}button:disabled{opacity:.35;cursor:default}
a{color:inherit}
</style></head><body><main>
<h1>Deploy TacitAmmRoute</h1>
<p>Through the CREATE2 proxy, so it lands at <code>${TACIT_AMM_ROUTE}</code>. Constructor: TacitPublicAmm <code>${TACIT_AMM}</code>, WETH <code>${WETH}</code>, ETH asset <code>${ETH_ID}</code>. Any account can send it.</p>
<button id="conn">Connect wallet</button> <span class="st" id="who"></span>
<div class="row" id="row"><div><b>${CHAIN.name}</b><span class="st">Reading…</span></div><button disabled>Deploy</button></div>
<p class="st">Init code: ${(data.length - 66) / 2} bytes · salt <code>${SALT}</code></p>
</main><script>
const ROUTE=${JSON.stringify(TACIT_AMM_ROUTE)},PROXY=${JSON.stringify(PROXY)},DATA=${JSON.stringify(data)},C=${JSON.stringify(CHAIN)};
const WANT={'0x44a70686':${JSON.stringify(TACIT_AMM)},'0xad5c4648':${JSON.stringify(WETH)},'0xe625a8ea':${JSON.stringify(ETH_ID)}};
const $=(s)=>document.querySelector(s),lc=(s)=>String(s).toLowerCase();
let acct=null,prov=null;
const wallets=[];window.addEventListener('eip6963:announceProvider',(e)=>wallets.push(e.detail));window.dispatchEvent(new Event('eip6963:requestProvider'));
async function rpc(method,params){let err;for(const u of C.rpc){try{const j=await(await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json();if(j.error)throw new Error(j.error.message);return j.result}catch(e){err=e}}throw err}
const btn=()=>$('#row').querySelector('button');
function say(html,cls=''){const s=$('#row').querySelector('.st');s.className='st '+cls;s.innerHTML=html}
async function check(){
  const code=await rpc('eth_getCode',[ROUTE,'latest']);
  if(code&&code!=='0x'){
    const got=await Promise.all(Object.keys(WANT).map((sel)=>rpc('eth_call',[{to:ROUTE,data:sel},'latest'])));
    const wired=Object.values(WANT).every((a,i)=>lc(got[i])===lc('0x'+a.replace(/^0x/,'').padStart(64,'0')));
    say(wired?'Deployed · '+((code.length-2)/2)+' bytes, wired to TacitPublicAmm, WETH and the ETH asset · <a target="_blank" href="'+C.explorer+'/address/'+ROUTE+'">explorer</a>':'Code is there but its wiring does not match',wired?'ok':'bad');
    btn().disabled=true;btn().textContent='Deployed';return true}
  const lands=await rpc('eth_call',[{to:PROXY,data:DATA},'latest']).catch((e)=>'error: '+e.message);
  if(lc('0x'+String(lands).slice(-40))!==lc(ROUTE)){say('Dry run does not land at the route address: '+lands,'bad');btn().disabled=true;return false}
  say('Not deployed yet. The dry run lands at the route address.');btn().disabled=!acct;return false}
async function onChain(){
  const hexId='0x'+C.id.toString(16);
  if(Number(await prov.request({method:'eth_chainId'}))===C.id)return;
  await prov.request({method:'wallet_switchEthereumChain',params:[{chainId:hexId}]});
  if(Number(await prov.request({method:'eth_chainId'}))!==C.id)throw new Error('Switch the wallet to '+C.name)}
async function deploy(){
  btn().disabled=true;
  try{
    if(await check())return;
    say('Switch to '+C.name+' in your wallet…');await onChain();
    say('Confirm the deploy in your wallet…');
    const h=await prov.request({method:'eth_sendTransaction',params:[{from:acct,to:PROXY,data:DATA,value:'0x0'}]});
    say('Sent <a target="_blank" href="'+C.explorer+'/tx/'+h+'">'+h.slice(0,10)+'…</a>, waiting for the block…');
    for(let i=0;i<180;i++){const r=await rpc('eth_getTransactionReceipt',[h]).catch(()=>null);
      if(r){if(r.status!=='0x1')throw new Error('The deploy reverted: '+h);break}
      await new Promise((ok)=>setTimeout(ok,2000))}
    await check()||say('Sent, but no code yet. Reload in a minute.','bad');
  }catch(e){say(String(e.message||e),'bad');btn().disabled=false}}
btn().onclick=deploy;check().catch((e)=>say('Could not read '+C.name+': '+e.message,'bad'));
$('#conn').onclick=async()=>{
  prov=(wallets[0]&&wallets[0].provider)||window.ethereum;
  if(!prov)return($('#who').textContent='No wallet found in this browser.');
  acct=(await prov.request({method:'eth_requestAccounts'}))[0];
  $('#who').textContent='Connected '+acct+(wallets[0]?' ('+wallets[0].info.name+')':'');
  check().catch(()=>{})};
</script></body></html>`;

const port = Number(process.argv[2] || 8798);
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(page);
}).listen(port, '127.0.0.1', () => console.log(`TacitAmmRoute deploy page: http://127.0.0.1:${port}  (route ${TACIT_AMM_ROUTE}, init code ${(data.length - 66) / 2} bytes)`));
