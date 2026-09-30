import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
  zeroAddress,
  type Address,
} from "viem";
import { getContract } from "./config";
import { readCityDetails, readRecentEvents } from "./chain";
import { useSwarm, describeError, type ActionRequest } from "./useSwarm";
import { SwapPanel } from "./SwapPanel";

const fmt = (value: bigint | undefined, decimals = 18) =>
  value === undefined
    ? "—"
    : Number(formatUnits(value, decimals)).toLocaleString("en-US", {
        maximumFractionDigits: 4,
      });
const plot = (id: number) => String(id).padStart(3, "0");
function AddressLink({
  address,
  explorer,
  label,
}: {
  address: Address;
  explorer?: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="address">
      <a
        href={explorer ? `${explorer}/address/${address}` : undefined}
        target="_blank"
        rel="noreferrer"
        title={getAddress(address)}
      >
        {label || `${getAddress(address).slice(0, 6)}…${address.slice(-4)}`} ↗
      </a>
      <button
        className="copy"
        aria-label={`Copy ${label || "address"}`}
        onClick={() =>
          void navigator.clipboard
            .writeText(getAddress(address))
            .then(() => setCopied(true))
            .catch(() => setCopied(false))
        }
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}
export default function App() {
  const app = useSwarm();
  const { deployment: d, client, account, snapshot: s } = app;
  const [selected, setSelected] = useState(0),
    [jump, setJump] = useState("0");
  const [details, setDetails] = useState<{
    claimable: bigint;
    cost: bigint | null;
  }>();
  const [detailError, setDetailError] = useState("");
  const [activity, setActivity] =
    useState<Awaited<ReturnType<typeof readRecentEvents>>>();
  const [review, setReview] = useState<{
    title: string;
    body: string;
    request: ActionRequest;
  }>();
  const dialog = useRef<HTMLDialogElement>(null),
    reviewTrigger = useRef<HTMLElement | null>(null);
  const [grantId, setGrantId] = useState("0"),
    [grantAmount, setGrantAmount] = useState("100");
  const [winners, setWinners] = useState(["0", "1", "2"]),
    [awards, setAwards] = useState(["100", "100", "100"]);
  const [formError, setFormError] = useState(""),
    [recipient, setRecipient] = useState(""),
    [sendAmount, setSendAmount] = useState("");
  const city = s?.cities[selected],
    owned = city && city.owner !== zeroAddress,
    mine = Boolean(
      owned && account && city.owner.toLowerCase() === account.toLowerCase(),
    );
  const ownId = s && s.cityOf > 0n ? Number(s.cityOf - 1n) : undefined;
  const registry = d ? getContract(d, "CityRegistry") : undefined,
    token = d ? getContract(d, "LaunchToken") : undefined,
    executor = d ? getContract(d, "GrantExecutor") : undefined;
  const operator = Boolean(
    s && account && s.operator.toLowerCase() === account.toLowerCase(),
  );
  const canAct = app.ready && !app.pending;
  useEffect(() => {
    setDetails(undefined);
    setDetailError("");
    if (!d || !client || !owned) return;
    let active = true;
    readCityDetails(client, d, selected)
      .then((v) => {
        if (active) setDetails(v);
      })
      .catch((e) => {
        if (active) setDetailError(describeError(e));
      });
    return () => {
      active = false;
    };
  }, [d, client, selected, s, owned]);
  useEffect(() => {
    if (!d || !client || !s) return;
    let active = true;
    readRecentEvents(d, client, s.block)
      .then((v) => {
        if (active) setActivity(v);
      })
      .catch(() => {
        if (active)
          setActivity({
            events: [],
            status: "Recent events unavailable. Try refreshing.",
          });
      });
    return () => {
      active = false;
    };
  }, [d, client, s?.block]);
  useEffect(() => {
    if (review) {
      reviewTrigger.current = document.activeElement as HTMLElement;
      dialog.current?.showModal();
    } else {
      dialog.current?.close();
      reviewTrigger.current?.focus();
    }
  }, [review]);
  const select = (id: number) => {
    setSelected(id);
    setJump(String(id));
  };
  const gridKey = (e: KeyboardEvent<HTMLButtonElement>, id: number) => {
    const next =
      e.key === "ArrowRight"
        ? id + 1
        : e.key === "ArrowLeft"
          ? id - 1
          : e.key === "ArrowDown"
            ? id + 16
            : e.key === "ArrowUp"
              ? id - 16
              : e.key === "Home"
                ? 0
                : e.key === "End"
                  ? 255
                  : undefined;
    if (next !== undefined) {
      e.preventDefault();
      const safe = Math.max(0, Math.min(255, next));
      select(safe);
      document.getElementById(`plot-${safe}`)?.focus();
    }
  };
  const primary = async () => {
    if (!account) {
      await app.connect();
      return;
    }
    if (app.chainId !== d?.chainId) {
      await app.switchChain();
      return;
    }
    if (!registry || !token || !s?.quote || !canAct) return;
    if (s.allowance < s.quote[2]) {
      await app.execute("Approve city purchase", {
        address: token.address,
        abi: token.abi,
        functionName: "approve",
        args: [registry.address, s.quote[2]],
      });
      return;
    }
    setReview({
      title: `Buy city #${plot(selected)}`,
      body: `Pay ${formatUnits(s.quote[2], s.decimals)} GRID, including the 4% fee. This city is permanently bound to your wallet and cannot be transferred. If the price rises beyond your exact approval, the purchase reverts. Sepolia ETH pays the network fee.`,
      request: {
        address: registry.address,
        abi: registry.abi,
        functionName: "buyCity",
        args: [BigInt(selected)],
      },
    });
  };
  const buyReason = !s
    ? "Live city state is loading."
    : owned
      ? "This plot is already owned."
      : s.cityOf > 0n
        ? "One city per wallet. Your current city is soulbound."
        : !s.quote
          ? "All plots have been purchased."
          : s.balance < s.quote[2] && account
            ? `You need ${fmt(s.quote[2], s.decimals)} GRID to buy this city.`
            : !app.verified
              ? "Deployment checks must pass before buying."
              : "";
  const purchaseLabel =
    app.pending === "Approve city purchase"
      ? "Approving purchase…"
      : !account
        ? "Connect wallet to buy"
        : app.chainId !== d?.chainId
          ? "Switch network above"
          : s && s.quote && s.allowance < s.quote[2]
            ? "Approve GRID for purchase"
            : "Review purchase";
  const queueGrant = (heartbeat: boolean) => {
    setFormError("");
    if (!executor || !registry || !s || !operator || !canAct) return;
    try {
      const ids = (heartbeat ? winners : [grantId]).map((x) => {
        if (!/^\d+$/.test(x) || Number(x) > 255)
          throw new Error("City IDs must be whole numbers from 0 to 255.");
        return BigInt(x);
      });
      if (new Set(ids.map(String)).size !== ids.length)
        throw new Error("Choose three distinct cities.");
      if (ids.some((id) => s.cities[Number(id)].owner === zeroAddress))
        throw new Error("Every recipient city must be owned.");
      const amounts = (heartbeat ? awards : [grantAmount]).map((x) => {
        if (!/^\d+(\.\d{1,18})?$/.test(x))
          throw new Error("Enter a positive amount with at most 18 decimals.");
        const value = parseUnits(x, 18);
        if (value <= 0n)
          throw new Error("Resource amounts must be greater than zero.");
        return value;
      });
      if (amounts.reduce((a, b) => a + b, 0n) > s.resourcePot)
        throw new Error("The resource pot cannot cover these grants.");
      const args: unknown[] = [registry.address];
      ids.forEach((id, i) => args.push(id, amounts[i]));
      setReview({
        title: heartbeat ? "Record heartbeat" : "Grant resources",
        body: `Allocate ${fmt(amounts.reduce((a, b) => a + b, 0n))} resources from the pot to ${ids.map((id) => `city #${plot(Number(id))}`).join(", ")}. Resource credits cannot be redeemed for GRID.`,
        request: {
          address: executor.address,
          abi: executor.abi,
          functionName: heartbeat ? "recordHeartbeat" : "grantResources",
          args,
        },
      });
    } catch (e) {
      setFormError(describeError(e));
    }
  };
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to city map
      </a>
      <header className="header shell">
        <a className="brand" href="#main" aria-label="Swarm Cities home">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>
            SWARM<span className="brand-small">CITIES</span>
          </span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#main" className="active">
            City map
          </a>
          <a href="#economy">How it works</a>
          <a href="#contracts">Contracts ↗</a>
        </nav>
        <div className="wallet">
          <span className="network-pill">
            <span aria-hidden="true">◇</span> {d?.network?.name || "Sepolia"}{" "}
            <small>TESTNET</small>
          </span>
          {account && d ? (
            <AddressLink address={account} explorer={d.network?.explorer} />
          ) : (
            <button
              onClick={() => void app.connect()}
              disabled={app.connecting}
            >
              {app.connecting ? "Connecting…" : "Connect wallet"}{" "}
              <span aria-hidden="true">↗</span>
            </button>
          )}
        </div>
      </header>
      <main id="main" className="shell">
        <section className="hero">
          <div>
            <div className="eyebrow">
              <span className="tiny-square" /> A COLLECTIVE CITY EXPERIMENT
            </div>
            <h1>
              A small plot.
              <br />
              <span>A shared future.</span>
            </h1>
            <p>
              Buy a city, the fee fills the pots, a heartbeat grows the top
              cities, higher level earns more of the fee.
            </p>
          </div>
          <div className="hero-aside">
            <span className="coordinate-symbol" aria-hidden="true">
              [ 16 × 16 ]
            </span>
            <p>
              256 plots. One living network.
              <br />
              Built together. Owned by you.
            </p>
            <a href="#city-panel">
              Find your place <span aria-hidden="true">↓</span>
            </a>
          </div>
        </section>
        <section className="stats" aria-label="Network statistics">
          <div>
            <span>Plots settled</span>
            <strong>
              {s ? s.soldPlots.toString() : "—"}
              <small> / 256</small>
            </strong>
            <div className="meter">
              <i
                style={{
                  width: `${s ? (Number(s.soldPlots) / 256) * 100 : 0}%`,
                }}
              />
            </div>
          </div>
          <div>
            <span>City rewards pool</span>
            <strong>
              {fmt(s?.rewardsPool)} <small>GRID</small>
            </strong>
            <p>Shared by city weight</p>
          </div>
          <div>
            <span>Resource pot</span>
            <strong>
              {fmt(s?.resourcePot)} <small>GRID</small>
            </strong>
            <p>Fuel for the next heartbeat</p>
          </div>
          <div>
            <span>Next plot · total</span>
            <strong>
              {s?.quote ? fmt(s.quote[2]) : s ? "Sold out" : "—"}{" "}
              <small>{s?.quote ? "GRID" : ""}</small>
            </strong>
            <p>Includes the 4% city fee</p>
          </div>
        </section>
        <div className="sync-bar">
          <span>
            <span className={`status-dot ${app.verified ? "online" : ""}`} />
            {app.loading
              ? "Syncing live contracts…"
              : s
                ? `Block ${s.block.toLocaleString()} · ${app.verified ? "deployment verified" : "verification required"}`
                : "Waiting for live state"}
          </span>
          <button
            className="text-button"
            onClick={() => void app.refresh()}
            disabled={app.loading || Boolean(app.pending)}
          >
            ↻ Refresh
          </button>
        </div>
        {account && d && app.chainId !== d.chainId && (
          <div className="callout warning">
            <span>
              Your wallet is on a different network. Switch before making a
              transaction.
            </span>
            <button
              onClick={() => void app.switchChain()}
              disabled={app.connecting}
            >
              Switch to {d.network?.name}
            </button>
          </div>
        )}
        <div className="persistent-status" role="status">
          {app.notice}
          {app.txHash && d && (
            <>
              {" "}
              <a
                href={`${d.network?.explorer}/tx/${app.txHash}`}
                target="_blank"
                rel="noreferrer"
              >
                View transaction ↗
              </a>
            </>
          )}
        </div>
        {app.error && (
          <div className="callout error" role="alert">
            {app.error}
          </div>
        )}
        <div className="city-layout">
          <section className="map-panel panel" aria-labelledby="map-title">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">01 / THE TERRITORY</span>
                <h2 id="map-title">Choose your coordinates</h2>
              </div>
              <span className="map-badge">16 × 16</span>
            </div>
            <div className="map-toolbar">
              <div className="legend">
                <span>□ Empty</span>
                <span>▣ Owned</span>
                <span>⌖ Selected</span>
              </div>
              {ownId !== undefined && (
                <button className="text-button" onClick={() => select(ownId)}>
                  Find my city ↗
                </button>
              )}
            </div>
            <p className="mobile-hint">
              Scroll the map sideways, use arrow keys, or select a plot below.
            </p>
            <div
              className="map-scroll"
              tabIndex={0}
              aria-label="City map, scroll horizontally on small screens"
            >
              <div className="axis" aria-hidden="true">
                {Array.from({ length: 16 }, (_, i) => (
                  <span key={i}>{i.toString(16).toUpperCase()}</span>
                ))}
              </div>
              <div
                className="plot-grid"
                role="group"
                aria-label="256 city plots"
              >
                {Array.from({ length: 256 }, (_, id) => {
                  const c = s?.cities[id],
                    taken = c && c.owner !== zeroAddress;
                  return (
                    <button
                      id={`plot-${id}`}
                      key={id}
                      tabIndex={selected === id ? 0 : -1}
                      className={`plot ${selected === id ? "selected" : ""} ${taken ? "owned" : ""} ${account && c?.owner.toLowerCase() === account.toLowerCase() ? "mine" : ""}`}
                      aria-pressed={selected === id}
                      aria-label={`Plot ${id}, ${!c ? "loading" : taken ? `owned, level ${c.level}` : "empty"}, coordinates ${id % 16}, ${Math.floor(id / 16)}`}
                      onClick={() => select(id)}
                      onKeyDown={(e) => gridKey(e, id)}
                    >
                      <span>
                        {taken ? `L${c.level}` : selected === id ? "⌖" : "·"}
                      </span>
                      <small>{plot(id)}</small>
                    </button>
                  );
                })}
              </div>
            </div>
            <form
              className="plot-jump"
              onSubmit={(e) => {
                e.preventDefault();
                if (/^\d+$/.test(jump) && Number(jump) <= 255)
                  select(Number(jump));
              }}
            >
              <label htmlFor="jump">Jump to plot</label>
              <input
                id="jump"
                type="number"
                min="0"
                max="255"
                required
                value={jump}
                onChange={(e) => setJump(e.target.value)}
              />
              <button type="submit">Select plot</button>
              <span className="muted">
                X = ID mod 16 · Y = ID ÷ 16, rounded down
              </span>
            </form>
          </section>
          <aside id="city-panel" className="city-panel panel">
            <div className="panel-heading">
              <span className="eyebrow">02 / YOUR NEXT CHAPTER</span>
              <span className="tag">
                {!city ? "Loading" : owned ? "Owned" : "Available"}
              </span>
            </div>
            <div className="city-illustration" aria-hidden="true">
              <svg viewBox="0 0 300 130">
                <g fill="none" stroke="currentColor" strokeWidth="1">
                  <path d="m150 26 109 47-109 47L41 73Z" />
                  <path d="m150 37 83 36-83 36-83-36Z" strokeDasharray="3 4" />
                  <path d="m150 55 42 18-42 18-42-18Z" />
                  <path d="M108 73V49l42-18 42 18v24M150 91V67l42-18M150 67l-42-18M150 31V10m-5 5 5-5 5 5" />
                  <path d="m67 84 83 36 83-36M150 120v7" />
                </g>
              </svg>
              <span>
                COORDINATES [{String(selected % 16).padStart(2, "0")},{" "}
                {String(Math.floor(selected / 16)).padStart(2, "0")}]
              </span>
            </div>
            <div className="city-title">
              <h2>City #{plot(selected)}</h2>
              <span>{owned ? `LEVEL ${city.level}` : "UNSETTLED"}</span>
            </div>
            {owned && d ? (
              <>
                <p className="muted">
                  {mine
                    ? "Your city. Your place in the network."
                    : "A city claimed by a fellow builder."}
                </p>
                <AddressLink
                  address={city.owner}
                  explorer={d.network?.explorer}
                />
                <dl className="city-values">
                  <div>
                    <dt>Resources</dt>
                    <dd>{fmt(city.resources)}</dd>
                  </div>
                  <div>
                    <dt>Reward weight</dt>
                    <dd>{(city.level * city.level).toString()}</dd>
                  </div>
                  <div>
                    <dt>Claimable rewards</dt>
                    <dd>{fmt(details?.claimable)} GRID</dd>
                  </div>
                  <div>
                    <dt>Next level cost</dt>
                    <dd>
                      {city.level >= 20n
                        ? "Maximum level"
                        : details?.cost !== null
                          ? `${fmt(details?.cost)} resources`
                          : "—"}
                    </dd>
                  </div>
                </dl>
                {detailError && (
                  <p role="alert" className="error-text">
                    {detailError}
                  </p>
                )}
                <button
                  className="primary full"
                  disabled={
                    !canAct || !mine || !details || details.claimable === 0n
                  }
                  onClick={() =>
                    registry &&
                    void app.execute("Claim rewards", {
                      address: registry.address,
                      abi: registry.abi,
                      functionName: "claimRewards",
                      args: [BigInt(selected)],
                    })
                  }
                >
                  {app.pending === "Claim rewards"
                    ? "Claiming rewards…"
                    : "Claim GRID rewards"}
                </button>
                <button
                  className="full"
                  disabled={
                    !canAct ||
                    !mine ||
                    !details ||
                    details.cost === null ||
                    city.resources < (details.cost || 0n) ||
                    city.level >= 20n
                  }
                  onClick={() =>
                    registry &&
                    details &&
                    setReview({
                      title: "Level up city",
                      body: `Spend ${fmt(details.cost ?? 0n)} resources to reach level ${city.level + 1n}. Your reward weight becomes ${(city.level + 1n) ** 2n}.`,
                      request: {
                        address: registry.address,
                        abi: registry.abi,
                        functionName: "levelUp",
                        args: [BigInt(selected)],
                      },
                    })
                  }
                >
                  {app.pending === "Level up city"
                    ? "Leveling up…"
                    : "Level up city"}
                </button>
                {!mine && (
                  <p className="helper">
                    Only the city owner can claim or level up.
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="muted">
                  A blank coordinate. Make it yours and grow with the Swarm.
                </p>
                <dl className="city-values">
                  <div>
                    <dt>Plot price</dt>
                    <dd>{fmt(s?.quote?.[0])} GRID</dd>
                  </div>
                  <div>
                    <dt>
                      City fee <span className="muted">4%</span>
                    </dt>
                    <dd>{fmt(s?.quote?.[1])} GRID</dd>
                  </div>
                  <div className="total">
                    <dt>Total to settle</dt>
                    <dd>{fmt(s?.quote?.[2])} GRID</dd>
                  </div>
                </dl>
                <button
                  className="primary full"
                  disabled={
                    Boolean(app.pending) ||
                    app.connecting ||
                    Boolean(
                      account &&
                        (app.chainId !== d?.chainId || !canAct || buyReason),
                    )
                  }
                  onClick={() => void primary()}
                >
                  {purchaseLabel} <span aria-hidden="true">↗</span>
                </button>
                <p className="helper">
                  {buyReason ||
                    "Approval allows only the displayed total. Purchase is a separate transaction."}
                </p>
                <p className="permanent">
                  ⌘ One wallet. One city. Permanently yours.
                </p>
              </>
            )}
            {account && (
              <div className="balance">
                Wallet balance{" "}
                <strong>{fmt(s?.balance, s?.decimals)} GRID</strong>
              </div>
            )}
          </aside>
        </div>
        <div className="lower-layout">
          <section className="panel heartbeat">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">03 / COLLECTIVE GROWTH</span>
                <h2>Last heartbeat</h2>
              </div>
              <span className="tag">
                {s ? `#${s.heartbeatCount.toString()}` : "—"}
              </span>
            </div>
            <p className="muted">Three cities. A new pulse of resources.</p>
            {s && s.heartbeatCount > 0n ? (
              <>
                <ol className="winners">
                  {s.lastHeartbeat.map((w, i) => (
                    <li key={i}>
                      <span className="rank">0{i + 1}</span>
                      <button
                        className="text-button"
                        onClick={() => select(Number(w.cityId))}
                      >
                        City #{plot(Number(w.cityId))} ↗
                      </button>
                      <strong>
                        +{fmt(w.amount)} <small>resources</small>
                      </strong>
                    </li>
                  ))}
                </ol>
                <p className="helper">
                  Recorded{" "}
                  {new Date(
                    Number(s.lastHeartbeatTimestamp) * 1000,
                  ).toLocaleString()}
                </p>
              </>
            ) : (
              <div className="empty">
                <span aria-hidden="true">⌁</span>
                <h3>
                  {s ? "Waiting for the first pulse" : "Reading heartbeats…"}
                </h3>
                <p>
                  The latest three winners will appear here after the operator
                  records a heartbeat.
                </p>
              </div>
            )}
          </section>
          {d && client ? (
            <SwapPanel
              deployment={d}
              client={client}
              account={account}
              ready={app.ready}
              busy={Boolean(app.pending)}
              execute={app.execute}
              balance={s?.balance ?? 0n}
              onRefresh={() => void app.refresh()}
            />
          ) : (
            <section className="panel">
              <h2>Swap for GRID</h2>
              <p className="muted">Loading the configured market…</p>
            </section>
          )}
        </div>
        <section id="economy" className="economy">
          <span className="eyebrow">THE CITY ECONOMY</span>
          <h2>Every new neighbor grows the network.</h2>
          <div className="economy-steps">
            <div>
              <span>01 — SETTLE</span>
              <h3>Find your place</h3>
              <p>
                Buy an empty plot with GRID. The base price goes to the
                permanent token sink. Each new city begins at level 1.
              </p>
            </div>
            <div>
              <span>02 — CONTRIBUTE</span>
              <h3>A fee with a purpose</h3>
              <p>
                Of the 4% fee: 50% funds city rewards, 30% resources, 10% is
                burned and 10% goes to the treasury.
              </p>
            </div>
            <div>
              <span>03 — GROW</span>
              <h3>Build your influence</h3>
              <p>
                Operator grants add resources. Spend 100 × next level² to level
                up, to a maximum of 20. Reward weight is your level squared.
              </p>
            </div>
          </div>
          <p className="helper">
            Testnet tokens only. Resources cannot be redeemed. USD context is
            unavailable because no price feed is configured.
          </p>
        </section>
        <section className="panel activity">
          <div className="panel-heading">
            <h2>Network activity</h2>
            <span className="eyebrow">RECENT CONTRACT EVENTS</span>
          </div>
          <p className="helper">
            {activity?.status || "Reading recent events…"}
          </p>
          {activity && activity.events.length > 0 && (
            <ul>
              {activity.events.slice(0, 12).map((event, i) => (
                <li key={`${event.transactionHash}-${i}`}>
                  <span>{event.name}</span>
                  <span>Block {event.blockNumber?.toLocaleString()}</span>
                  <a
                    href={`${d?.network?.explorer}/tx/${event.transactionHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View transaction ↗
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
        <details className="panel operator">
          <summary>
            Operator console{" "}
            <span className="muted">Resource grants & heartbeat controls</span>
          </summary>
          <p>
            Only the deployed operator can grant resources, record heartbeats or
            pause grants. Buys and claims stay live when grants are paused.
          </p>
          {s && d && (
            <p>
              Operator:{" "}
              <AddressLink
                address={s.operator}
                explorer={d.network?.explorer}
              />{" "}
              · Grants {s.grantsPaused ? "paused" : "live"}
            </p>
          )}
          {!operator && (
            <p className="helper">
              Connect the operator wallet to enable these controls.
            </p>
          )}
          <fieldset disabled={!canAct || !operator}>
            <legend>Grant resources</legend>
            <div className="fields">
              <label>
                City ID
                <input
                  inputMode="numeric"
                  value={grantId}
                  onChange={(e) => setGrantId(e.target.value)}
                />
              </label>
              <label>
                Resources
                <input
                  inputMode="decimal"
                  value={grantAmount}
                  onChange={(e) => setGrantAmount(e.target.value)}
                />
              </label>
              <button
                disabled={s?.grantsPaused}
                onClick={() => queueGrant(false)}
              >
                Review resource grant
              </button>
            </div>
            <h3>Record a heartbeat</h3>
            {winners.map((w, i) => (
              <div className="fields" key={i}>
                <label>
                  Winner {i + 1} city ID
                  <input
                    inputMode="numeric"
                    value={w}
                    onChange={(e) =>
                      setWinners((v) =>
                        v.map((x, j) => (j === i ? e.target.value : x)),
                      )
                    }
                  />
                </label>
                <label>
                  Winner {i + 1} resources
                  <input
                    inputMode="decimal"
                    value={awards[i]}
                    onChange={(e) =>
                      setAwards((v) =>
                        v.map((x, j) => (j === i ? e.target.value : x)),
                      )
                    }
                  />
                </label>
              </div>
            ))}
            <div className="actions">
              <button
                disabled={s?.grantsPaused}
                onClick={() => queueGrant(true)}
              >
                Review heartbeat
              </button>
              <button
                onClick={() =>
                  executor &&
                  setReview({
                    title: s?.grantsPaused ? "Resume grants" : "Pause grants",
                    body: "This affects operator resource grants and heartbeats only. City buys, claims and level ups stay available.",
                    request: {
                      address: executor.address,
                      abi: executor.abi,
                      functionName: s?.grantsPaused
                        ? "unpauseGrants"
                        : "pauseGrants",
                    },
                  })
                }
              >
                {s?.grantsPaused ? "Resume grants" : "Pause grants"}
              </button>
            </div>
          </fieldset>
          {formError && (
            <p role="alert" className="error-text">
              {formError}
            </p>
          )}
        </details>
        <details className="panel">
          <summary>
            Transfer GRID{" "}
            <span className="muted">Send tokens to another wallet</span>
          </summary>
          <p>
            This transfers GRID tokens; soulbound cities cannot be transferred.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setFormError("");
              try {
                if (
                  !isAddress(recipient.trim()) ||
                  recipient.trim().toLowerCase() === zeroAddress
                )
                  throw new Error("Enter a valid nonzero Ethereum address.");
                if (!/^\d+(\.\d{1,18})?$/.test(sendAmount))
                  throw new Error(
                    "Enter a valid GRID amount with at most 18 decimals.",
                  );
                const amount = parseUnits(sendAmount, s?.decimals ?? 18);
                if (amount <= 0n || amount > (s?.balance ?? 0n))
                  throw new Error(
                    "Enter a positive amount within your GRID balance.",
                  );
                if (token)
                  setReview({
                    title: "Transfer GRID",
                    body: `Send ${formatUnits(amount, s?.decimals ?? 18)} GRID to ${getAddress(recipient.trim())}. Confirm the full recipient address before signing.`,
                    request: {
                      address: token.address,
                      abi: token.abi,
                      functionName: "transfer",
                      args: [getAddress(recipient.trim()), amount],
                    },
                  });
              } catch (e) {
                setFormError(describeError(e));
              }
            }}
          >
            <div className="fields">
              <label>
                Recipient address
                <input
                  value={recipient}
                  placeholder="0x…"
                  autoComplete="off"
                  onChange={(e) => setRecipient(e.target.value)}
                />
              </label>
              <label>
                Amount in GRID
                <input
                  inputMode="decimal"
                  value={sendAmount}
                  onChange={(e) => setSendAmount(e.target.value)}
                />
              </label>
              <button disabled={!canAct}>Review transfer</button>
            </div>
            {formError && (
              <p role="alert" className="error-text">
                {formError}
              </p>
            )}
          </form>
        </details>
        <footer id="contracts">
          <div>
            <a href="#main" className="footer-brand">
              SWARM CITIES
            </a>
            <p>
              A shared experiment on {d?.network?.name || "Sepolia"}.<br />
              256 coordinates. Countless possibilities.
            </p>
          </div>
          <div className="contract-links">
            <span className="eyebrow">DEPLOYED CONTRACTS</span>
            {d?.contracts.map((c) => (
              <AddressLink
                key={c.name}
                address={c.address}
                explorer={d.network?.explorer}
                label={c.name}
              />
            ))}
            <a href="./imd-deployment.json">Deployment manifest ↗</a>
          </div>
          <div>
            <span className="eyebrow">NETWORK NOTES</span>
            <p>
              Read-only until you connect.
              <br />
              Refreshes every 20 seconds.
              <br />
              No mainnet funds required.
            </p>
            {d?.network?.faucets?.[0] && (
              <a href={d.network.faucets[0]} target="_blank" rel="noreferrer">
                Get testnet ETH ↗
              </a>
            )}
          </div>
        </footer>
      </main>
      <dialog
        ref={dialog}
        onCancel={() => setReview(undefined)}
        onClose={() => setReview(undefined)}
        aria-labelledby="review-title"
      >
        <div className="dialog-content">
          <span className="eyebrow">REVIEW TRANSACTION</span>
          <h2 id="review-title">{review?.title}</h2>
          <p>{review?.body}</p>
          <p className="helper">
            The transaction is simulated first. Your wallet will show the
            network fee before you sign.
          </p>
          <div className="actions">
            <button onClick={() => setReview(undefined)}>Cancel</button>
            <button
              className="primary"
              disabled={!canAct}
              onClick={() => {
                const next = review;
                setReview(undefined);
                if (next) void app.execute(next.title, next.request);
              }}
            >
              Confirm {review?.title.toLowerCase()}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
