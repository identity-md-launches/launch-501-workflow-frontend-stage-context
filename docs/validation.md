# Frontend validation

Frontend implementation and worker checks are complete. Live transaction activation is blocked by an existing deployment authorization conflict: both immutable treasury and operator are `0x09EC38170E94532EDdB57c69DfC4F1fDCD0d4a60`, while the approved workflow requires `0x5b95A971B4583A5f011E9DA082acdD679b870D06`. The frontend reports this conflict and disables writes. This is worker validation evidence, not an independent certification of the contracts or publication. The app is built from the deployed handoff and served as plain files below `/preview/`; source is under `web/`, the production export prepared for submission is `dist/`.

## Scope and assumptions

The approved visual direction is an intentionally dark terminal interface. The single English page covers the 256-plot map, city purchase/approval, owner upgrades and reward claims, rewards/resource pots, heartbeat winners, recent contract events, GRID transfers, operator grants/heartbeat/pause controls, and ETH/GRID swaps. Read-only visitors use the configured public RPCs. Every signing path requires a connected wallet on the configured chain and successful deployment checks.

The strict write scope excludes root `DESIGN.md`. Its requested content is delivered as `docs/DESIGN.md`; root configuration and deployed Solidity source remain untouched. The brief's hosting/publication stage occurs after this worker submission.

Browser test data is synthetic and clearly confined to `web/tests/fixture.mjs`. The fixture loads the actual production manifest and ABI JSON, intercepts the listed public RPC URLs, and injects an EIP-1193 wallet. Wallet requests and receipt transitions are simulated; no transactions are broadcast. Test balances, city ownership, resources, winners and pool liquidity in screenshots are fixture data, not claims about live Sepolia.

## Verification commands

- Dependencies installed with `npm install --prefix web --cache /tmp/swarm-npm-cache --no-audit --no-fund` (exit 0); `npm ci --prefix web --cache /tmp/swarm-npm-cache` is the reproducible lockfile installation command.
- `cd web && npm run typecheck`: TypeScript verification.
- `cd web && npm run build`: production export followed by deployment/asset manifest generation.
- `cd web && npm run verify`: exact handoff binding, ABI canonical Keccak hashes and all exported SHA-256 hashes.
- `cd web && npm test`: bounded Playwright process, its own temporary foreground HTTP server, and mocked contract/wallet interactions against the actual export. Browser and server are closed on success or failure.

Final results: TypeScript, production build, manifest verification and `npm test` all exited 0. The test command passed **7 swap helper checks and 15 browser scenarios**. The export contains 8 inventoried assets plus the manifest, totaling **533,673 bytes**. All three pinned implementation ABIs matched their handoff canonical Keccak hashes; the complete asset inventory matched its SHA-256 hashes.

A bounded development-server browser check also rendered live state with zero page errors and confirmed byte-identical manifest/ABI delivery through the development middleware. The production rebuild after that configuration change reproduced the exact same tested manifest hash.

The final browser run used Chromium `145.0.7632.6` on 2026-09-30. [Machine-readable interaction evidence](evidence/interaction-results.json) records each scenario, rendered metrics and the exact tested manifest SHA-256. Browser coverage includes missing wallet, connection/transaction rejection, wrong-chain 4902 → add → switch recovery, exact city approval and purchase review, pending receipt lock, dialog focus return, owner/non-owner level/claim controls, operator grants/duplicate-winner validation/heartbeat/pause/resume, valid/invalid GRID transfers, simulation failure before signing, missing code, actual role conflict, both swap directions, exact router commands and settlements, two separate sell approvals, invalid input/slippage, quote expiry, empty liquidity, ABI tampering and RPC failure/recovery. All browser scenarios had zero JavaScript console errors, uncaught page errors or local asset failures.

Production subpath layouts were checked at **1440×1000, 900×1000, 390×1000 and 320×1000** CSS pixels. No document or body overflow was measured; the map alone scrolls on narrow screens. All 13 inputs measured 16px at 320px. The DOM check found zero unnamed buttons and zero unlabelled inputs. Keyboard movement selected the adjacent and next-row plots; the rendered 2px focus outline was inspected in its screenshot.

The root worker also inspected the live production export with the supplied browser tool at **1440×1100 and 320×850**. It observed live Sepolia state and the actual authorization conflict, 256 city buttons, no page overflow, zero browser console errors/warnings, and HTTP 200 for the accessed ABIs/RPC responses. No live wallet action was signed.

Screenshots inspected: [desktop fixture](evidence/desktop-1440.png), [390px fixture](evidence/desktop-390.png), [320px fixture](evidence/desktop-320.png), [keyboard focus](evidence/keyboard-focus.png), [mobile city panel](evidence/mobile-city-panel.png), plus [live desktop](evidence/live-desktop.png) and [live mobile](evidence/live-mobile.png). Fixture and live screenshots are intentionally distinguished. Each is below 1 MiB.

## Better Interface review

The pinned workflow and core principles in all six domains were read before review. Supporting ETH frontend UX guidance was also read. Product language, dark-only design and contract authorization take precedence over generic design preferences.

| Domain | Coverage | Unperformed or inapplicable checks |
| --- | --- | --- |
| Accessibility | Native buttons/inputs/dialog; explicit input labels and plot names; roving map focus; keyboard arrow movement; selected/owned text cues; review-dialog cancel/focus return; transaction status/error regions. Browser tests inspect control naming and computed focus; the focused screenshot was visually reviewed. | No screen-reader session, physical touch-device session, or full automated accessibility audit. A browser DOM check is not a claim of full WCAG conformance. |
| Layout | Production subpath; desktop, intermediate and narrow viewport reflow; document overflow checks; map-specific scroll region and explicit alternative jump control; normal-flow transaction controls and disclosure sections. | Native browser 200% zoom and translated/RTL layouts are not verified. English is the only implemented locale. |
| Writing | Action labels checked against invoked functions; network/rejection/revert/empty-state recovery; exact 4% split, soulbound consequence, resource units and testnet copy; no fabricated USD feed. | No additional locales requested. |
| Typography | Heading order/size, system font stack, numeric values and address wrapping reviewed in source and rendered at representative widths. Mobile input sizing checked. | Platform font differences and native iOS input behavior are not verified. |
| Colors | Semantic tokens and dark-only states reviewed; selected opaque rendered text/background pairs measured by the browser script. Selected/owned status also has labels and glyphs. | No light theme requested. Contrast of unmeasured hover/disabled/forced-color states is not claimed. |
| UI | Loading, rejection, approval, receipt, success, unavailable, selected, modal and disclosure states exercised; restrained interaction transitions and reduced-motion preference reviewed. | Browser animation-panel playback at 10% speed and physical-device gesture behavior are not verified. |

## Findings and fixes

- **Medium, `web/src/useSwarm.ts:151` refresh scheduling:** source review identified that connecting while a disconnected snapshot was loading could suppress the new-account refresh until the poll. The implementation now invalidates wallet snapshots and serializes refresh promises, including receipt-triggered refreshes; browser tests connect during initial loading and then use live wallet balances/allowances.
- **Medium, `web/src/SwapPanel.tsx:65` quote identity / `web/src/useSwarm.ts:265` readiness:** source review identified that using a transient refresh flag in readiness could erase an approval flow's quote when its receipt refreshed state. Readiness and account/chain invalidation were separated; the two explicit token approval steps are tested through to router execution.
- **Medium, `web/src/App.tsx:214` wrong-network actions:** review found duplicate switch controls. The page keeps one network-switch action and disables transaction prerequisites until the chain is corrected.

- **Medium, `web/src/useSwarm.ts:75` / `web/src/useSwarm.ts:167` error persistence:** the first full browser run reproduced a rejected approval message disappearing when a queued refresh finished. Verification errors and wallet/action errors now have separate state; background reads preserve action failures. The final full suite passed the rejection/retry flow and RPC recovery.
- **Medium, `web/src/styles.css:408` / `web/src/styles.css:479` small functional text:** source/render review identified 7px plot IDs and 8px coordinate labels. Both were raised to 10px. Final screenshots were regenerated, inspected, and reflow checks passed at all four widths. Other compact metadata retains the deliberate terminal density; primary amounts/actions use larger text.

All reported frontend findings were fixed and rechecked. Measured opaque rendered text/background pairs: hero text **16.64:1**, hero/eyebrow secondary text **8.14:1**, panel secondary/helper text **7.57:1**, primary/selected text **12.96:1**, owned-plot text **9.41:1**. Every sampled pair exceeds 4.5:1. These measurements apply to the recorded selectors/states only; they are not a claim about all possible browser states.

## Live read-only evidence

[Deployment validation](deployment-validation.json) records the configured Sepolia RPC, chain ID `11155111`, nonempty code for all three handoff contracts, token/executor binding and 18 decimals, all 256 city reads and the unowned initial grid. Treasury/operator checks failed against the approved role wallet, as stated above. This mismatch predates the frontend and cannot be corrected within its write scope. The app does not substitute the observed wallet or silently enable transactions. [Read-only pool and quote evidence](swap-validation.md) records successful swap preflight/quotes; those reads do not resolve the role conflict.

## Completion and limits

**Frontend source/export and worker validation complete; local Git commit blocked.** The worker attempted `git add web dist docs`, but the environment rejected `.git/index.lock` creation with `Read-only file system` (exit 128). Source/export/evidence are present in the working tree for the submission publisher; this report does not claim they were locally committed. Live write activation remains blocked by the attested deployment’s immutable role mismatch. Publication and contract remediation belong to their later/owning stages. Required frontend controls, static source/export, hashes, browser checks and evidence are delivered within the allowed paths. `docs/delivery-check.json` records scope, dependency/submodule exclusion and byte checks: all candidate tracked/submission file bytes total about 3.6 MB against the 8 MiB budget; the export is 533,673 bytes. The only added ignore file is the explicitly allowed `web/.gitignore`.

## Limits

Mocked interaction tests validate app behavior and ABI/router request construction, not transaction acceptance by the deployed network. Real funded buys, approvals, swaps, level ups, claims, transfers, operator actions, pool price/liquidity changes and chain reorganizations are unperformed. The worker does not deploy contracts, publish the site, pin IPFS, verify a named gateway, or treat later HTTP/RPC publication checks as browser proof. ENS resolution is not used; Sepolia addresses are checksummed and link to the configured explorer. Social preview URLs remain pending until a host is assigned.
