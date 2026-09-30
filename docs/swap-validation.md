# Swap validation

Run from `web/` after `npm ci`:

```sh
node tests/swap-unit.mjs
node tests/swap-network.mjs
```

The seven source-level checks passed on 2026-09-30. They cover amount precision and limits, slippage bounds, the independently decoded native-buy and token-sale wire formats, runtime router/Permit2 address selection, code/chain/pool failure gates, exact allowance queries, and simulation-only quotes. The test loads the actual TypeScript through Vite. It does not sign or broadcast transactions. Browser interaction coverage is recorded in the main validation document.

Read-only public RPC checks completed at **2026-09-30 09:35:21 UTC**, Sepolia block **11813799**. All three handoff RPCs returned chain ID `11155111`, nonempty code for all six configured Uniswap contracts, and matching pool state. Full output is in [swap-network-results.json](swap-network-results.json).

| Check | Observed result |
| --- | --- |
| Pool ID, derived from handoff economics and token | `0x465d0759a727479501ed08dc967ba9b94ba4d1c03136c7bc94da17139fab527c` |
| Initialized pool | `sqrtPriceX96 = 558987588417524851294219763765435` |
| Active liquidity | `113387377674367368214378` |
| Simulated quote: 0.001 ETH input | `49626.469427204108448295 GRID` |
| Simulated quote: 1000 GRID input | `0.000020028547485448 ETH` |

These are historical test outputs, not prices embedded in the interface. Quotes are `eth_call` simulations of the configured quoter. Actual browser quotes require a connected wallet, deployment verification, fresh pool/code reads, positive balances, and a valid amount. Quotes expire after 60 seconds or any account, readiness, direction, amount, or slippage change. The router receives a 120-second deadline. Selling uses exact token approval to Permit2 followed by exact router authorization expiring after 30 minutes. Native buys approve nothing. The shared transaction executor simulates every proposed transaction and checks wallet identity again before signing.

Review fixed two integration hazards: background state refresh no longer toggles readiness and discards valid approval-flow quotes; `SwapPanel.tsx` rechecks the current wallet/input identity after the asynchronous post-receipt balance/allowance refresh before updating its state. Failed quotes and rejected wallet actions release their local pending locks.

The deployed role mismatch reported by deployment validation keeps the actual application transaction controls locked pending independent resolution. The pool's successful read-only checks do not override that gate. No live approval, wallet signature, router execution, or swap settlement was tested or broadcast. Successful simulated quotes and mocked router interaction do not establish real transaction settlement or future liquidity availability.

Protocol references consulted: [Uniswap swap routing](https://developers.uniswap.org/docs/protocols/v4/guides/swapping/routing), [IV4Quoter](https://github.com/Uniswap/v4-periphery/blob/main/src/interfaces/IV4Quoter.sol), and [IStateView](https://github.com/Uniswap/v4-periphery/blob/main/src/interfaces/IStateView.sol). Router encoding follows the assignment's deployed-interface tuple and prescribed `0x10` command with `0x060c0f` actions; it does not substitute the additional fields present in newer upstream router interfaces.
