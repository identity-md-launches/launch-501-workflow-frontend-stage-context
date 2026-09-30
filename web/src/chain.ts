import {
  decodeEventLog,
  zeroAddress,
  type Address,
  type PublicClient,
} from "viem";
import {
  errorMessage,
  getContract,
  POLICY_OWNER,
  type Deployment,
  type DeploymentContract,
} from "./config";

export type City = { owner: Address; level: bigint; resources: bigint };
export type Snapshot = {
  cities: City[];
  soldPlots: bigint;
  totalWeight: bigint;
  rewardsPool: bigint;
  resourcePot: bigint;
  heartbeatCount: bigint;
  lastHeartbeatTimestamp: bigint;
  lastHeartbeat: { cityId: bigint; amount: bigint }[];
  quote: readonly [bigint, bigint, bigint] | null;
  balance: bigint;
  allowance: bigint;
  cityOf: bigint;
  operator: Address;
  treasury: Address;
  grantsPaused: boolean;
  decimals: number;
  block: bigint;
};
export type CityDetails = { claimable: bigint; cost: bigint | null };
export type Verification = { ok: boolean; issues: string[] };
export type ActivityEvent = {
  name: string;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
  args: Record<string, unknown>;
};
export type Activity = { events: ActivityEvent[]; status: string };

async function read<T>(
  client: PublicClient,
  contract: DeploymentContract,
  functionName: string,
  args: readonly unknown[] = [],
  blockNumber?: bigint,
): Promise<T> {
  return (await client.readContract({
    address: contract.address,
    abi: contract.abi,
    functionName,
    args,
    blockNumber,
  })) as T;
}

/** Read one coherent block. A failed required read never masquerades as a zero balance or an empty plot. */
export async function readSnapshot(
  deployment: Deployment,
  client: PublicClient,
  account?: Address,
): Promise<Snapshot> {
  const registry = getContract(deployment, "CityRegistry");
  const token = getContract(deployment, "LaunchToken");
  const executor = getContract(deployment, "GrantExecutor");
  const block = await client.getBlockNumber({ cacheTime: 0 });
  const [
    cityRows,
    soldPlots,
    totalWeight,
    rewardsPool,
    resourcePot,
    heartbeatCount,
    lastHeartbeatTimestamp,
    winners,
    balance,
    allowance,
    cityOf,
    operator,
    treasury,
    grantsPaused,
    decimals,
  ] = await Promise.all([
    Promise.all(
      Array.from({ length: 256 }, (_, id) =>
        read<readonly [Address, bigint, bigint]>(
          client,
          registry,
          "cities",
          [BigInt(id)],
          block,
        ),
      ),
    ),
    read<bigint>(client, registry, "soldPlots", [], block),
    read<bigint>(client, registry, "totalWeight", [], block),
    read<bigint>(client, registry, "rewardsPool", [], block),
    read<bigint>(client, registry, "resourcePot", [], block),
    read<bigint>(client, registry, "heartbeatCount", [], block),
    read<bigint>(client, registry, "lastHeartbeatTimestamp", [], block),
    Promise.all(
      [0n, 1n, 2n].map((id) =>
        read<readonly [bigint, bigint]>(
          client,
          registry,
          "lastHeartbeat",
          [id],
          block,
        ),
      ),
    ),
    account
      ? read<bigint>(client, token, "balanceOf", [account], block)
      : Promise.resolve(0n),
    account
      ? read<bigint>(
          client,
          token,
          "allowance",
          [account, registry.address],
          block,
        )
      : Promise.resolve(0n),
    account
      ? read<bigint>(client, registry, "cityOf", [account], block)
      : Promise.resolve(0n),
    read<Address>(client, executor, "operator", [], block),
    read<Address>(client, registry, "treasury", [], block),
    read<boolean>(client, executor, "grantsPaused", [], block),
    read<number>(client, token, "decimals", [], block),
  ]);
  const quote =
    soldPlots < 256n
      ? await read<readonly [bigint, bigint, bigint]>(
          client,
          registry,
          "quote",
          [],
          block,
        )
      : null;
  return {
    cities: cityRows.map(([owner, level, resources]) => ({
      owner,
      level,
      resources,
    })),
    soldPlots,
    totalWeight,
    rewardsPool,
    resourcePot,
    heartbeatCount,
    lastHeartbeatTimestamp,
    lastHeartbeat: winners.map(([cityId, amount]) => ({ cityId, amount })),
    quote,
    balance,
    allowance,
    cityOf,
    operator,
    treasury,
    grantsPaused,
    decimals: Number(decimals),
    block,
  };
}

export async function readCityDetails(
  client: PublicClient,
  deployment: Deployment,
  id: number | bigint,
): Promise<CityDetails> {
  const registry = getContract(deployment, "CityRegistry");
  const block = await client.getBlockNumber({ cacheTime: 0 });
  const [owner, level] = await read<readonly [Address, bigint, bigint]>(
    client,
    registry,
    "cities",
    [BigInt(id)],
    block,
  );
  if (owner.toLowerCase() === zeroAddress) return { claimable: 0n, cost: null };
  const [claimable, cost] = await Promise.all([
    read<bigint>(client, registry, "claimableRewards", [BigInt(id)], block),
    level < 20n
      ? read<bigint>(client, registry, "levelUpCost", [BigInt(id)], block)
      : Promise.resolve(null),
  ]);
  return { claimable, cost };
}

/** A policy role mismatch blocks every write instead of silently accepting a different operator. */
export async function verifyDeployment(
  deployment: Deployment,
  client: PublicClient,
): Promise<Verification> {
  const issues: string[] = [];
  try {
    const actualChain = await client.getChainId();
    if (actualChain !== deployment.chainId)
      return {
        ok: false,
        issues: [
          `RPC reports chain ${actualChain}; expected ${deployment.chainId}.`,
        ],
      };
    const block = await client.getBlockNumber({ cacheTime: 0 });
    await Promise.all(
      deployment.contracts.map(async (contract) => {
        const code = await client.getCode({
          address: contract.address,
          blockNumber: block,
        });
        if (!code || code === "0x")
          issues.push(
            `${contract.name} has no deployed code on the configured chain.`,
          );
      }),
    );
    if (issues.length) return { ok: false, issues };
    const registry = getContract(deployment, "CityRegistry");
    const executor = getContract(deployment, "GrantExecutor");
    const token = getContract(deployment, "LaunchToken");
    const [boundToken, boundExecutor, treasury, operator, decimals] =
      await Promise.all([
        read<Address>(client, registry, "token", [], block),
        read<Address>(client, registry, "grantExecutor", [], block),
        read<Address>(client, registry, "treasury", [], block),
        read<Address>(client, executor, "operator", [], block),
        read<number>(client, token, "decimals", [], block),
      ]);
    if (boundToken.toLowerCase() !== token.address.toLowerCase())
      issues.push(
        "CityRegistry token does not match the attested LaunchToken.",
      );
    if (boundExecutor.toLowerCase() !== executor.address.toLowerCase())
      issues.push(
        "CityRegistry executor does not match the attested GrantExecutor.",
      );
    if (operator.toLowerCase() !== POLICY_OWNER.toLowerCase())
      issues.push(
        `Authorization conflict: executor operator ${operator} does not match workflow wallet ${POLICY_OWNER}.`,
      );
    if (treasury.toLowerCase() !== POLICY_OWNER.toLowerCase())
      issues.push(
        `Authorization conflict: registry treasury ${treasury} does not match workflow wallet ${POLICY_OWNER}.`,
      );
    if (Number(decimals) !== 18)
      issues.push(
        "GRID decimals do not match the 18-decimal deployed implementation.",
      );
  } catch (error) {
    issues.push(`Deployment verification unavailable: ${errorMessage(error)}`);
  }
  return { ok: issues.length === 0, issues };
}

/** Bounded recent history, not an indexer; contract snapshots remain authoritative. */
export async function readRecentEvents(
  deployment: Deployment,
  client: PublicClient,
  atBlock?: bigint,
): Promise<Activity> {
  try {
    const block = atBlock ?? (await client.getBlockNumber({ cacheTime: 0 }));
    const fromBlock = block > 999n ? block - 999n : 0n;
    const registry = getContract(deployment, "CityRegistry");
    const executor = getContract(deployment, "GrantExecutor");
    const logs = await client.getLogs({
      address: [registry.address, executor.address],
      fromBlock,
      toBlock: block,
    });
    const events: ActivityEvent[] = [];
    for (const log of logs) {
      if (
        log.removed ||
        log.blockNumber === null ||
        log.transactionHash === null
      )
        continue;
      const contract =
        log.address.toLowerCase() === registry.address.toLowerCase()
          ? registry
          : executor;
      try {
        const decoded = decodeEventLog({
          abi: contract.abi,
          topics: log.topics,
          data: log.data,
          strict: false,
        });
        if (decoded.eventName)
          events.push({
            name: decoded.eventName,
            blockNumber: log.blockNumber,
            transactionHash: log.transactionHash,
            args: (decoded.args ?? {}) as Record<string, unknown>,
          });
      } catch {
        /* Ignore unrelated or unrecognized log signatures. */
      }
    }
    events.reverse();
    return {
      events: events.slice(0, 18),
      status: `Latest ${Math.min(events.length, 18)} events in blocks ${fromBlock}–${block}. Refreshes may change after a reorganization.`,
    };
  } catch (error) {
    return {
      events: [],
      status: `Recent events unavailable (RPC history may be limited): ${errorMessage(error)}`,
    };
  }
}
