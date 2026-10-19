(function toStandalonePage() {
  var PAGES = ['sats', 'secret-sats', 'ceremony', 'tacit-v1'];
  var m = window.location.pathname.match(/^\/([a-z0-9-]+)$/i);
  if (m && PAGES.indexOf(m[1].toLowerCase()) !== -1) {
    window.location.replace('/' + m[1].toLowerCase() + '/' + window.location.search + window.location.hash);
  }
})();

(function refuseFraming() {
  if (window.top === window.self) return;
  var s = document.createElement('style');
  s.textContent = 'html{display:none!important}';
  document.head.appendChild(s);
  try { window.top.location.replace(window.self.location.href); } catch (_) { }
})();

(function silenceExtensionEthereumCollision() {
  try {
    window.addEventListener('error', function (e) {
      if (!e || typeof e.filename !== 'string') return;
      if (!/inpage\.js(\?|$|:)/.test(e.filename)) return;
      var msg = (e.error && e.error.message) || e.message || '';
      if (!/Cannot redefine property: ethereum/.test(msg)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  } catch (_) { }
})();

(function normalizePathRoute() {
  try {
    if (window.location.hash) return;
    var TABS = ['wallet', 'holdings', 'transfer', 'discover', 'market', 'pool',
      'farms', 'etch', 'factory', 'drops', 'claim', 'about', 'mixer',
      'confidential-pool', 'otc', 'cdp', 'csend', 'cswap', 'earn', 'airdrop', 'points', 'govern'];
    var m = window.location.pathname.match(/^\/([a-z][a-z-]*)\/?$/i);
    if (!m) return;
    var tab = m[1].toLowerCase();
    if (TABS.indexOf(tab) === -1) return;
    var qs = new URLSearchParams(window.location.search);
    var aid = qs.get('aid') || '';
    var lane = qs.get('lane') || '';
    var hash = '#tab=' + tab;
    if (/^[0-9a-f]{64}$/i.test(aid)) hash += '&aid=' + aid.toLowerCase();
    if (/^[0-9a-f]{64}$/i.test(aid) && (lane === 'btc' || lane === 'eth')) hash += '&lane=' + lane;
    window.history.replaceState(null, '', window.location.pathname + window.location.search + hash);
  } catch (e) { }
})();

(function preActivateTabFromHash() {
  try {
    var m = (window.location.hash || '').match(/[#&]tab=([a-z-]+)/i);
    var target = m && m[1] && m[1].toLowerCase();
    if (target === 'csend') target = 'transfer';
    else if (target === 'cswap' || target === 'otc' || target === 'cdp') target = 'market';
    else if (target === 'farms') target = 'earn';
    else if (target === 'claim') target = 'wallet';
    else if (target === 'confidential-pool' || target === 'mixer' || target === 'pool') target = 'about';
    if (!target || target === 'wallet') return;
    window._tacitDeeplinkTab = target;
    var styleEl = document.createElement('style');
    styleEl.id = '_tacit-preactivate-style';
    styleEl.textContent =
      '#tab-wallet{display:none!important;animation:none!important}' +
      '#tab-' + target + '{display:block!important}';
    document.head.appendChild(styleEl);
    document.addEventListener('DOMContentLoaded', function () {
      var GROUP_OF = {
        wallet: 'wallet', holdings: 'wallet', points: 'wallet',
        transfer: 'send',
        market: 'trade', cswap: 'trade', otc: 'trade', cdp: 'trade',
        earn: 'earn',
        etch: 'create', factory: 'create', drops: 'create',
        discover: 'discover',
        mixer: 'advanced', about: 'advanced',
        'confidential-pool': 'advanced', pool: 'advanced', farms: 'advanced'
      };
      var group = GROUP_OF[target] || target;
      var nextPanel = document.getElementById('tab-' + target);
      if (!nextPanel) return;
      var prevPanel = document.querySelector('.tab-panel.active');
      if (prevPanel) prevPanel.classList.remove('active');
      nextPanel.classList.add('active');
      var primaries = document.querySelectorAll('.tabs-primary .tab');
      for (var i = 0; i < primaries.length; i++) {
        if (primaries[i].dataset.group === group) primaries[i].classList.add('active');
        else primaries[i].classList.remove('active');
      }
      var rows = document.querySelectorAll('.tabs.subtabs');
      for (var j = 0; j < rows.length; j++) {
        rows[j].style.display = (rows[j].dataset.group === group) ? '' : 'none';
      }
      var subs = document.querySelectorAll('.tabs.subtabs .tab');
      for (var k = 0; k < subs.length; k++) {
        if (subs[k].dataset.tab === target) subs[k].classList.add('active');
        else subs[k].classList.remove('active');
      }
      var pre = document.getElementById('_tacit-preactivate-style');
      if (pre && pre.parentNode) pre.parentNode.removeChild(pre);
    });
  } catch (e) { }
})();
