import { useEffect, useRef, useState } from "react";
import { formatUnits, type Abi, type Address, type PublicClient } from "viem";
import { getContract, POOL_PARAMETERS, type Deployment } from "./config";
import {
  encodeSwap,
  fetchSwapState,
  parseSlippage,
  parseSwapAmount,
  permit2Abi,
  QUOTE_TTL,
  quoteSwap,
  swapError,
  swapNetwork,
  type SwapState,
} from "./swap";

interface SwapPanelProps {
  deployment: Deployment;
  client: PublicClient;
  account?: Address;
  ready: boolean;
  busy: boolean;
  execute: (
    label: string,
    request: {
      address: Address;
      abi: Abi;
      functionName: string;
      args?: readonly unknown[];
      value?: bigint;
    },
  ) => Promise<boolean>;
  balance: bigint;
  onRefresh?: () => void;
}
interface Quote {
  amountIn: bigint;
  amountOut: bigint;
  minimumOut: bigint;
  created: number;
  key: string;
}
type Operation = "quote" | "token" | "router" | "swap" | null;

export function SwapPanel({
  deployment,
  client,
  account,
  ready,
  busy,
  execute,
  balance,
  onRefresh,
}: SwapPanelProps) {
  const [direction, setDirection] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("0.5");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [state, setState] = useState<SwapState | null>(null);
  const [error, setError] = useState("");
  const [operation, setOperation] = useState<Operation>(null);
  const [clock, setClock] = useState(Date.now());
  const inFlight = useRef(false);
  const requestId = useRef(0);
  const key = `${account}:${ready}:${direction}:${amount}:${slippage}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  const inputSymbol = direction === "buy" ? "ETH" : "GRID";
  const outputSymbol = direction === "buy" ? "GRID" : "ETH";
  const inputDecimals = direction === "buy" ? 18 : (state?.decimals ?? 18);
  const outputDecimals = direction === "buy" ? (state?.decimals ?? 18) : 18;
  const quoteCurrent =
    !!quote && quote.key === key && clock - quote.created < QUOTE_TTL;
  const locked = busy || operation !== null;
  const networkAvailable = !!deployment.network?.uniswapV4;
  const available = ready && !!account && networkAvailable;
  const tokenApprovalNeeded =
    !!quote &&
    direction === "sell" &&
    (!state || state.tokenAllowance < quote.amountIn);
  const routerApprovalNeeded =
    !!quote &&
    direction === "sell" &&
    (!state ||
      state.routerAllowance < quote.amountIn ||
      state.routerExpiration <= Math.floor(clock / 1000) + 120);

  useEffect(() => {
    requestId.current += 1;
    setQuote(null);
    setError("");
  }, [key]);
  useEffect(() => {
    setState(null);
  }, [account, ready, deployment]);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function getQuote() {
    if (!available || !account || inFlight.current) return;
    inFlight.current = true;
    setOperation("quote");
    setError("");
    setQuote(null);
    const id = ++requestId.current;
    const startKey = key;
    try {
      const bps = parseSlippage(slippage);
      const latest = await fetchSwapState(client, deployment, account);
      const parsed = parseSwapAmount(
        amount,
        direction === "buy" ? 18 : latest.decimals,
      );
      if (
        parsed >
        (direction === "buy" ? latest.nativeBalance : latest.tokenBalance)
      )
        throw new Error(`Insufficient ${inputSymbol} balance for this swap.`);
      if (direction === "buy" && parsed === latest.nativeBalance)
        throw new Error("Leave some ETH in your wallet for the network fee.");
      const output = await quoteSwap(
        client,
        deployment,
        account,
        direction === "buy",
        parsed,
      );
      const minimum = (output * BigInt(10_000 - bps)) / 10_000n;
      if (minimum === 0n)
        throw new Error(
          "The minimum output is too small. Increase the input amount.",
        );
      if (id !== requestId.current || startKey !== currentKey.current) return;
      const created = Date.now();
      setState(latest);
      setClock(created);
      setQuote({
        amountIn: parsed,
        amountOut: output,
        minimumOut: minimum,
        created,
        key: startKey,
      });
    } catch (err) {
      if (id === requestId.current && startKey === currentKey.current)
        setError(swapError(err));
    } finally {
      inFlight.current = false;
      setOperation(null);
    }
  }

  async function act(action: "token" | "router" | "swap") {
    if (
      !available ||
      !account ||
      inFlight.current ||
      !quote ||
      quote.key !== key ||
      Date.now() - quote.created >= QUOTE_TTL
    ) {
      setError("Get a fresh quote before continuing.");
      return;
    }
    inFlight.current = true;
    setOperation(action);
    setError("");
    const startKey = key;
    try {
      const latest = await fetchSwapState(client, deployment, account);
      if (startKey !== currentKey.current) return;
      setState(latest);
      if (
        quote.amountIn >
        (direction === "buy" ? latest.nativeBalance : latest.tokenBalance)
      )
        throw new Error(`Insufficient ${inputSymbol} balance for this swap.`);
      const network = swapNetwork(deployment);
      const token = getContract(deployment, "LaunchToken");
      let confirmed = false;
      if (action === "token") {
        confirmed = await execute(
          `Approve ${formatUnits(quote.amountIn, latest.decimals)} GRID for Permit2`,
          {
            address: token.address,
            abi: token.abi,
            functionName: "approve",
            args: [network.permit2, quote.amountIn],
          },
        );
      } else if (action === "router") {
        if (latest.tokenAllowance < quote.amountIn)
          throw new Error("Approve GRID for Permit2 first.");
        confirmed = await execute("Authorize the swap router for 30 minutes", {
          address: network.permit2,
          abi: permit2Abi,
          functionName: "approve",
          args: [
            token.address,
            network.universalRouter,
            quote.amountIn,
            Math.floor(Date.now() / 1000) + 1800,
          ],
        });
      } else {
        if (Date.now() - quote.created >= QUOTE_TTL)
          throw new Error("This quote expired. Get a fresh quote to continue.");
        if (
          direction === "sell" &&
          (latest.tokenAllowance < quote.amountIn ||
            latest.routerAllowance < quote.amountIn ||
            latest.routerExpiration <= Math.floor(Date.now() / 1000) + 120)
        ) {
          throw new Error(
            "The token approvals need refreshing. Complete the approval step shown below.",
          );
        }
        confirmed = await execute(
          `Swap ${formatUnits(quote.amountIn, inputDecimals)} ${inputSymbol}; receive at least ${formatUnits(quote.minimumOut, outputDecimals)} ${outputSymbol}`,
          encodeSwap(
            deployment,
            direction === "buy",
            quote.amountIn,
            quote.minimumOut,
            BigInt(Math.floor(Date.now() / 1000) + 120),
          ),
        );
      }
      if (confirmed && startKey === currentKey.current) {
        // Remain locked until confirmed balances and allowances replace the previous state.
        const confirmedState = await fetchSwapState(
          client,
          deployment,
          account,
        );
        if (startKey !== currentKey.current) return;
        setState(confirmedState);
        onRefresh?.();
        if (action === "swap") {
          setQuote(null);
          setAmount("");
        }
      }
    } catch (err) {
      if (startKey === currentKey.current) setError(swapError(err));
    } finally {
      inFlight.current = false;
      setOperation(null);
    }
  }

  return (
    <section className="panel swap-panel" aria-labelledby="swap-title">
      <div className="section-title">
        <span className="eyebrow">02 / EXCHANGE</span>
        <h2 id="swap-title">Get GRID</h2>
      </div>
      <p className="muted">
        Swap Sepolia ETH and GRID through the project’s Uniswap v4 pool. Testnet
        tokens only.
      </p>
      <div className="swap-direction" role="group" aria-label="Swap direction">
        <button
          type="button"
          className={`button ${direction === "buy" ? "active" : ""}`}
          aria-pressed={direction === "buy"}
          disabled={locked}
          onClick={() => setDirection("buy")}
        >
          ETH → GRID
        </button>
        <button
          type="button"
          className={`button ${direction === "sell" ? "active" : ""}`}
          aria-pressed={direction === "sell"}
          disabled={locked}
          onClick={() => setDirection("sell")}
        >
          GRID → ETH
        </button>
      </div>
      <label className="field" htmlFor="swap-amount">
        <span>You pay ({inputSymbol})</span>
        <input
          id="swap-amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder={direction === "buy" ? "0.01" : "1000"}
          value={amount}
          disabled={locked}
          onChange={(event) => setAmount(event.target.value)}
        />
      </label>
      <p className="muted amount-hint">
        {direction === "sell"
          ? `${formatUnits(state?.tokenBalance ?? balance, state?.decimals ?? 18)} GRID available`
          : state
            ? `${formatUnits(state.nativeBalance, 18)} ETH available · leave ETH for gas`
            : "Keep some ETH for the network fee."}
      </p>
      <label className="field" htmlFor="swap-slippage">
        <span>Maximum slippage (%)</span>
        <input
          id="swap-slippage"
          inputMode="decimal"
          autoComplete="off"
          value={slippage}
          disabled={locked}
          onChange={(event) => setSlippage(event.target.value)}
        />
      </label>
      <p className="muted">
        Pool fee: {POOL_PARAMETERS.fee / 10_000}%. Quotes expire after 60
        seconds. USD values are unavailable.
      </p>
      {!networkAvailable && (
        <p className="status">
          Swaps are unavailable: the deployment has no vetted network
          configuration.
        </p>
      )}
      {!account && (
        <p className="muted">Connect your wallet above to quote and swap.</p>
      )}
      {account && !ready && (
        <p className="status">
          Connect to the configured network and wait for contract verification
          before swapping.
        </p>
      )}
      <button
        className="button"
        type="button"
        disabled={!available || locked || !amount}
        onClick={() => void getQuote()}
      >
        {operation === "quote"
          ? "Getting quote…"
          : quote
            ? "Refresh quote"
            : "Get quote"}
      </button>
      {quote && (
        <div className="quote-summary" aria-live="polite">
          <dl>
            <div>
              <dt>Expected output</dt>
              <dd>
                {formatUnits(quote.amountOut, outputDecimals)} {outputSymbol}
              </dd>
            </div>
            <div>
              <dt>Minimum received</dt>
              <dd>
                {formatUnits(quote.minimumOut, outputDecimals)} {outputSymbol}
              </dd>
            </div>
            <div>
              <dt>Exchange rate</dt>
              <dd>
                1 {inputSymbol} ≈{" "}
                {new Intl.NumberFormat("en", {
                  maximumSignificantDigits: 8,
                }).format(
                  Number(formatUnits(quote.amountOut, outputDecimals)) /
                    Number(formatUnits(quote.amountIn, inputDecimals)),
                )}{" "}
                {outputSymbol}
              </dd>
            </div>
          </dl>
          {!quoteCurrent && (
            <p className="status">
              Quote expired or inputs changed. Refresh the quote to continue.
            </p>
          )}
          {direction === "sell" && (
            <p className="muted">
              Selling needs two approvals: the exact GRID amount to Permit2,
              then the same amount to the router for 30 minutes. Each approval
              is a separate transaction.
            </p>
          )}
          {tokenApprovalNeeded ? (
            <button
              type="button"
              className="button primary"
              disabled={!available || locked || !quoteCurrent}
              onClick={() => void act("token")}
            >
              {operation === "token"
                ? "Approving GRID…"
                : "1. Approve GRID for Permit2"}
            </button>
          ) : routerApprovalNeeded ? (
            <button
              type="button"
              className="button primary"
              disabled={!available || locked || !quoteCurrent}
              onClick={() => void act("router")}
            >
              {operation === "router"
                ? "Authorizing router…"
                : "2. Authorize swap router"}
            </button>
          ) : (
            <button
              type="button"
              className="button primary"
              disabled={!available || locked || !quoteCurrent}
              onClick={() => void act("swap")}
            >
              {operation === "swap"
                ? "Swapping…"
                : `Swap ${inputSymbol} for ${outputSymbol}`}
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
