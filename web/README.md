# Swarm Cities frontend

A static React + TypeScript interface for the already deployed Swarm Cities contracts. Source and frontend configuration live here; the ready-to-host export is `../dist/`. The page includes the 256-plot map, purchase approval and review, owner claims and level ups, pool/pot balances, heartbeat winners, recent events, GRID transfers, guarded operator controls, and native ETH/GRID Uniswap v4 swaps.

**Current deployment limitation:** live Sepolia reads found both immutable operator and treasury set to `0x09EC38170E94532EDdB57c69DfC4F1fDCD0d4a60`, while the approved workflow requires `0x5b95A971B4583A5f011E9DA082acdD679b870D06`. The frontend displays this conflict and disables transactions. The source and deployed contracts are preserved. See [deployment evidence](../docs/deployment-validation.json); changing the frontend's expected role would conceal the conflict and is not a repair.

## Install, build and preview

Use Node 22.12+ and npm. From the repository root:

```sh
npm ci --prefix web --cache /tmp/swarm-npm-cache
npm --prefix web run typecheck
npm --prefix web run build
npm --prefix web run verify
npm --prefix web run preview
```

Open the preview URL printed by Vite. Development: build once, then run `npm --prefix web run dev`; development middleware serves the same generated deployment manifest and ABI files from `dist/`. Use the production preview for export validation. The export uses `base: './'`, locally bundled assets and page anchors, so it works on an IPFS gateway subpath without rewrites. No backend is needed.

The build calls `web/scripts/export.mjs` after Vite. It obtains each ABI using `git show <deployed sourceCommit>:docs/abi/<Contract>.json`, verifies the canonical Keccak hash against the handoff, and generates `dist/imd-deployment.json` from the final bytes. Keep the pinned source commit in Git history when rebuilding. Initial pinned `.imd/reads/` inputs are preserved as `web/deployment-input.json` and `web/network-input.json`, so removing the worker-only inputs does not prevent a rebuild.

## Runtime configuration

`dist/imd-deployment.json` is the single runtime source for deployed addresses, chain ID, ABI paths and public RPCs. `web/src/config.ts` loads it and verifies every ABI's recursively key-sorted canonical JSON Keccak hash. It never imports an independent deployed address table. The build input supplies only the attested pool parameters (fee, tick spacing and paired currency); the pool's token comes from the runtime manifest. All Uniswap addresses come from `manifest.network.uniswapV4`.

The manifest contains exactly the required metadata, full contract set, `network`, `walletAddChain`, and SHA-256 inventory of every other exported file. Network data is copied unchanged. `npm run verify` checks exact handoff binding, all ABI hashes, complete inventory, safe paths, file limits and manifest schema. Regenerate it after every export change; it intentionally excludes its own hash.

Public RPCs are tried in the supplied order, followed by a connected wallet on the correct chain. Reads are block-pinned and batched; the complete 256-city snapshot refreshes every 20 seconds while the tab is visible, after confirmation, and on request. Recent events cover only the most recent 1,000 blocks, including registry and executor events. RPC failures are visible and lock transactions. Deployment checks verify RPC chain ID, nonempty code, token/executor linkage, GRID decimals and both workflow roles. Checks repeat before simulation/signing.

An injected EIP-1193 browser wallet is supported; no WalletConnect project ID, private RPC key, signing key or backend credential is required. The app attempts chain switching, then adds the supplied chain on error 4902/unknown-chain and switches again. Account/network changes invalidate wallet state. There is no WalletConnect modal without a supplied public project ID. Missing-wallet instructions appear on connection.

## Transaction behavior

- Purchase requires an empty plot, no existing city, enough GRID and deployment verification. Approval is the exact current purchase total and requires a separate confirmed transaction. The purchase review explains permanent ownership and the 4% fee. A price rise beyond approval causes simulation or execution to revert.
- Level ups and claims require ownership and current resources/rewards. Credits use 18 decimals. Resources cannot be redeemed. The actual contract enforces the 1,000 GRID holding prerequisite; the displayed purchase balance requirement is stricter.
- Operator controls target GrantExecutor with the registry address from the manifest. The frontend checks operator identity, grants pause, owned recipients, distinct heartbeat winners, positive amounts and pot coverage. Pausing affects grants/heartbeats only.
- Swaps simulate the configured quoter, apply the entered slippage, and use universal router `execute` with command `0x10`, actions `0x060c0f`. Native ETH input sends transaction value and requests no approval. GRID input explicitly approves Permit2, then authorizes the router for the exact amount for 30 minutes. Quotes expire after 60 seconds and invalidate when inputs/account/network eligibility change. Router transactions carry a two-minute deadline and are simulated before wallet signing.
- All writes recheck account/chain and deployment, simulate, wait for a successful receipt, then refetch. Error and receipt links persist. A rejection unlocks controls. No frontend validation broadcasts live transactions.

## Validate

```sh
cd web
npm test
npm run check:live
```

`npm test` runs seven protocol helper checks and the production-export browser scenarios. It starts and closes a temporary local HTTP server under `/preview/`, mocks the configured RPCs and browser wallet, and never broadcasts. It uses Playwright Chromium. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` if a browser is provided externally, or install Playwright's browser with `npx playwright install chromium` (set `PLAYWRIGHT_BROWSERS_PATH` to a writable scratch directory when needed).

`check:live` is **read-only**: verifies actual deployment/roles and queries the configured pool/quoter. Its successful RPC calls do not mean the workflow roles match; inspect the reported `result`. See [validation](../docs/validation.md), [design](../docs/DESIGN.md) and [swap validation](../docs/swap-validation.md) for coverage, screenshots, findings and limits. Mocked happy paths use authorized synthetic roles; the actual deployment remains transaction-locked.

No live funded transaction, physical wallet signing session, publication, IPFS pin or named gateway verification was performed. Absolute social-image URLs await the published host; no unknown URL is invented.

## Delivery scope and size

Only `web/**`, `dist/**` and `docs/**` are delivered. `web/.gitignore` is the explicitly budgeted ignore path; it excludes nested dependency, npm/Vite cache and test-report directories. No root configuration, deployed source, dependency archive or submodule is changed. Root `DESIGN.md` is outside the strict write budget; its content is in `docs/DESIGN.md`.

Dependencies are restored from `package-lock.json`; `node_modules` and package caches are never submitted. The export is about 534 KB across eight inventoried files plus its manifest, well below the file/count and HTTP response-budget limits. The final source/export/documentation bundle is checked against 8 MiB.
