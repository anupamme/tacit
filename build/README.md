# tacit build

Dev-time tooling for the dapp in `../dapp/`. It is not part of the pinned dapp.

`npm run build`:

- bundles the vendor dependencies into `../dapp/vendor/`:
  - `tacit-deps.min.js` (`@noble/secp256k1`, `@noble/hashes`, `@scure/base`, `poseidon-lite`) from `entry.mjs`
  - `tacit-mixer.min.js` (snarkjs), lazy-loaded, from `entry-mixer.mjs`
  - `tacit-satsconnect.min.js` (sats-connect), lazy-loaded, from `entry-satsconnect.mjs`
- rewrites the `?cb=` cache-bust tokens for `tacit.js` and `preboot.js` in `../dapp/classic.html`
  (a short sha256 prefix of each file)
- stamps the header's page links, the footer and the links to `dapp/chrome.css` and `dapp/chrome.js` between the
  `<!-- chrome:nav|foot|head:begin -->` markers of every page listed in `chrome.mjs`; change a link or an icon in
  `build/chrome.mjs` and the build rewrites every page (`npm run verify` fails on a page that differs). A new page
  adds the three marker pairs and its name to `CHROME_PAGES`. `<!-- chrome:head:begin inline -->` (every page's
  marker) writes the stylesheet into the page instead of linking it, so the first paint waits for no request
- writes each page's `modulepreload` links from its `<!-- preload-roots: first | later | on-demand -->` comment; the
  on-demand group goes into the page's `WARM_MODULES` or, for a page with no inline script, into an inert
  `<template id="warm">` between `<!-- warm:begin -->` and `<!-- warm:end -->`, which its script appends to the head
- writes a brotli-q11 copy of `tacit.js` to `build/out/tacit.js.br` for the API's `/tacit.js`
  edge route, and prints the `wrangler kv key put` command that uploads it
- prints SHA-384 integrity hashes for every bundle, `tacit.js` and `index.html`

`npm run verify` reads the existing bundles and prints their hashes without rebuilding or rewriting
anything.

## When to run

```bash
cd build
npm install     # first time, or after a dependency bump
npm run build
```

Run it after any change to `dapp/tacit.js` or `dapp/preboot.js`, so the `?cb=` token in
`index.html` changes and clients fetch the new bytes, and after bumping a bundled dependency.

## Comments in the served modules

The site serves `dapp/` as it is, and its host compresses with a quick setting, so the comments of a large module are a large part of what a visitor downloads (45% of `tacit.js`).
The big, rarely edited modules are kept without comments; `build/strip-comments.mjs` does it and proves it changed nothing else:

```bash
node build/strip-comments.mjs dapp/<module>.js …    # then: npm run build (twice)
```

It rewrites a file only when esbuild minifies the original and the stripped text to the same output, keeps `/*! */`, `@license`, source-map and bundler comments, and leaves a file it cannot prove
equal exactly as it was. Page files (`index.html` and the pages' own `app.js`) are edited every day by several people and keep their comments for now.

## Integrity

All code runs same-origin from the pinned `dapp/` directory; the CSP in `dapp/classic.html` allows
`script-src 'self'` (plus `'wasm-unsafe-eval'`), so nothing loads from a third-party CDN. The
runtime known-answer tests (`runStartupKAT` in `tacit.js`) check the bundled primitives against
published vectors at startup, independently of the bundle hashes.

The build is deterministic: the same `node_modules/`, entry files and esbuild version give a
byte-identical bundle and the same SHA-384.

## Pinning to IPFS

```bash
ipfs add -r dapp
```
