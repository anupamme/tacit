try { if (/[?&]q=/.test(location.search) || localStorage.getItem('tacit-trade-wallet')) document.documentElement.dataset.lookup = ''; } catch { }
