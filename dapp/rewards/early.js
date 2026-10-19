// A lookup is on its way: a link with ?q=, or a wallet connected here before that comes back at once. The page keeps the place of its answer,
// so the lists below it do not move when the answer arrives. A script of its own, in the head, because the page's CSP has no inline script.
try { if (/[?&]q=/.test(location.search) || localStorage.getItem('tacit-trade-wallet')) document.documentElement.dataset.lookup = ''; } catch { /* storage is a convenience */ }
