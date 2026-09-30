import {
  encodeAbiParameters,
  keccak256,
  parseAbi,
  parseAbiParameters,
  parseUnits,
  zeroAddress,
  type Address,
  type PublicClient,
} from "viem";
import {
  errorMessage,
  getContract,
  POOL_PARAMETERS,
  type Deployment,
} from "./config";

// Interfaces for the network-supplied Uniswap contracts; project ABIs load from the manifest.
export const quoterAbi = parseAbi([
  "function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
  "error NotEnoughLiquidity(bytes32 poolId)",
]);
export const routerAbi = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
  "error ExecutionFailed(uint256 commandIndex, bytes message)",
  "error TransactionDeadlinePassed()",
  "error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)",
]);
export const permit2Abi = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);
export const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);
export const QUOTE_TTL = 60_000;
export const MAX_UINT128 = (1n << 128n) - 1n;
const poolKeyParameters = parseAbiParameters(
  "(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)",
);
const singleSwapParameters = parseAbiParameters(
  "((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)",
);

export function swapError(error: unknown): string {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const item = current as {
      data?: { errorName?: string };
      message?: string;
      cause?: unknown;
    };
    const detail = `${item.data?.errorName ?? ""} ${item.message ?? ""}`;
    if (/NotEnoughLiquidity|PoolNotInitialized/i.test(detail))
      return "The pool cannot fill this quote. It may be uninitialized or lack liquidity. Try a smaller amount or refresh later.";
    if (/V4TooLittleReceived|TooLittleReceived/i.test(detail))
      return "The price moved beyond your slippage limit. Get a fresh quote.";
    if (/rejected|denied/i.test(detail))
      return "Request rejected in your wallet. You can try again.";
    current = item.cause;
  }
  const message = errorMessage(error);
  return /0x[0-9a-f]{8}/i.test(message)
    ? "The swap request could not be completed. Refresh the quote or try a smaller amount."
    : message;
}

export function swapNetwork(deployment: Deployment) {
  const network = deployment.network;
  if (!network?.uniswapV4)
    throw new Error(
      "Swaps are unavailable: this deployment has no vetted Uniswap network configuration.",
    );
  return network.uniswapV4;
}

export function getPoolKey(deployment: Deployment) {
  const token = getContract(deployment, "LaunchToken").address;
  const paired = POOL_PARAMETERS.pairedCurrency as Address;
  const [currency0, currency1] = [paired, token].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  );
  return {
    currency0,
    currency1,
    fee: POOL_PARAMETERS.fee,
    tickSpacing: POOL_PARAMETERS.tickSpacing,
    hooks: zeroAddress,
  };
}

export function poolId(deployment: Deployment) {
  return keccak256(
    encodeAbiParameters(poolKeyParameters, [getPoolKey(deployment)]),
  );
}

export function parseSwapAmount(value: string, decimals: number): bigint {
  if (
    !/^(?:0|[1-9]\d*)(?:\.\d*)?$/.test(value) ||
    (value.split(".")[1]?.length ?? 0) > decimals
  ) {
    throw new Error(
      `Enter a positive amount with at most ${decimals} decimal places.`,
    );
  }
  const amount = parseUnits(value, decimals);
  if (amount <= 0n || amount > MAX_UINT128)
    throw new Error(
      "Enter a positive amount within the pool’s supported range.",
    );
  return amount;
}

export function parseSlippage(value: string): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value))
    throw new Error(
      "Enter slippage from 0.01% to 5%, with at most two decimal places.",
    );
  const basisPoints = Math.round(Number(value) * 100);
  if (basisPoints < 1 || basisPoints > 500)
    throw new Error("Slippage must be between 0.01% and 5%.");
  return basisPoints;
}

export function encodeSwap(
  deployment: Deployment,
  zeroForOne: boolean,
  amountIn: bigint,
  minimumOut: bigint,
  deadline: bigint,
) {
  const poolKey = getPoolKey(deployment);
  const network = swapNetwork(deployment);
  const inputCurrency = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const outputCurrency = zeroForOne ? poolKey.currency1 : poolKey.currency0;
  const swap = encodeAbiParameters(singleSwapParameters, [
    {
      poolKey,
      zeroForOne,
      amountIn,
      amountOutMinimum: minimumOut,
      hookData: "0x",
    },
  ]);
  const settle = encodeAbiParameters(parseAbiParameters("address, uint256"), [
    inputCurrency,
    amountIn,
  ]);
  const take = encodeAbiParameters(parseAbiParameters("address, uint256"), [
    outputCurrency,
    minimumOut,
  ]);
  const input = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [
    "0x060c0f",
    [swap, settle, take],
  ]);
  return {
    address: network.universalRouter,
    abi: routerAbi,
    functionName: "execute",
    args: ["0x10", [input], deadline] as const,
    value: inputCurrency === zeroAddress ? amountIn : 0n,
  };
}

export interface SwapState {
  decimals: number;
  nativeBalance: bigint;
  tokenBalance: bigint;
  tokenAllowance: bigint;
  routerAllowance: bigint;
  routerExpiration: number;
  liquidity: bigint;
}

export async function fetchSwapState(
  client: PublicClient,
  deployment: Deployment,
  account: Address,
): Promise<SwapState> {
  const network = swapNetwork(deployment);
  if ((await client.getChainId()) !== deployment.chainId)
    throw new Error("The RPC returned the wrong network. Swaps are disabled.");
  const names = [
    "poolManager",
    "universalRouter",
    "quoter",
    "stateView",
    "permit2",
  ] as const;
  await Promise.all(
    names.map(async (name) => {
      const code = await client.getCode({ address: network[name] });
      if (!code || code === "0x")
        throw new Error(
          `Swaps are unavailable: ${name} has no code on the configured network.`,
        );
    }),
  );
  const token = getContract(deployment, "LaunchToken");
  const id = poolId(deployment);
  const [
    slot0,
    liquidity,
    nativeBalance,
    tokenBalance,
    decimals,
    tokenAllowance,
    permit,
  ] = await Promise.all([
    client.readContract({
      address: network.stateView,
      abi: stateViewAbi,
      functionName: "getSlot0",
      args: [id],
    }),
    client.readContract({
      address: network.stateView,
      abi: stateViewAbi,
      functionName: "getLiquidity",
      args: [id],
    }),
    client.getBalance({ address: account }),
    client.readContract({
      address: token.address,
      abi: token.abi,
      functionName: "balanceOf",
      args: [account],
    }) as Promise<bigint>,
    client.readContract({
      address: token.address,
      abi: token.abi,
      functionName: "decimals",
    }) as Promise<number>,
    client.readContract({
      address: token.address,
      abi: token.abi,
      functionName: "allowance",
      args: [account, network.permit2],
    }) as Promise<bigint>,
    client.readContract({
      address: network.permit2,
      abi: permit2Abi,
      functionName: "allowance",
      args: [account, token.address, network.universalRouter],
    }),
  ]);
  if (slot0[0] === 0n)
    throw new Error(
      "This ETH / GRID pool has not been initialized. Swaps are unavailable.",
    );
  if (liquidity === 0n)
    throw new Error(
      "This ETH / GRID pool has no active liquidity. Swaps are unavailable.",
    );
  return {
    decimals: Number(decimals),
    nativeBalance,
    tokenBalance,
    tokenAllowance,
    routerAllowance: permit[0],
    routerExpiration: permit[1],
    liquidity,
  };
}

export async function quoteSwap(
  client: PublicClient,
  deployment: Deployment,
  account: Address,
  zeroForOne: boolean,
  amountIn: bigint,
) {
  const { result } = await client.simulateContract({
    address: swapNetwork(deployment).quoter,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    account,
    args: [
      {
        poolKey: getPoolKey(deployment),
        zeroForOne,
        exactAmount: amountIn,
        hookData: "0x",
      },
    ],
  });
  if (result[0] <= 0n || result[0] > MAX_UINT128)
    throw new Error(
      "No supported output is available for this amount. Try a smaller amount.",
    );
  return result[0];
}
