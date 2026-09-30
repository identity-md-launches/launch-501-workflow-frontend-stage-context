import {
  BaseError,
  createPublicClient,
  custom,
  defineChain,
  fallback,
  http,
  isAddress,
  keccak256,
  stringToHex,
  type Abi,
  type Address,
  type EIP1193Provider,
  type PublicClient,
  type Transport,
} from "viem";
import { manifest as buildManifest } from "../deployment-input.json";

/** Pool economics from the attested build input; deployment addresses come only from the runtime manifest. */
export const POOL_PARAMETERS = buildManifest.pool;
/** Authorization required by the approved workflow; deliberately checked against both immutable roles. */
export const POLICY_OWNER: Address =
  "0x5b95A971B4583A5f011E9DA082acdD679b870D06";

export type Network = {
  chainId: number;
  name: string;
  testnet: boolean;
  rpcUrls: string[];
  explorer: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  faucets: string[];
  uniswapV4: Record<
    | "poolManager"
    | "universalRouter"
    | "quoter"
    | "stateView"
    | "positionManager"
    | "permit2",
    Address
  >;
};
export type DeploymentContract = {
  name: string;
  address: Address;
  abiHash: string;
  abiPath: string;
  abi: Abi;
};
export type Deployment = {
  version: 1;
  launchId: string;
  chainId: number;
  sourceCommit: string;
  attestationHash: string;
  contracts: DeploymentContract[];
  assets: { path: string; sha256: string }[];
  network?: Network;
  walletAddChain?: {
    chainId: string;
    chainName: string;
    rpcUrls: string[];
    nativeCurrency: Network["nativeCurrency"];
    blockExplorerUrls: string[];
  };
};

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function safePath(path: string): boolean {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes(":") &&
    !path
      .split("/")
      .some((part) => part === ".." || part === "." || part === "")
  );
}

export async function loadDeployment(): Promise<Deployment> {
  const manifestUrl = new URL("imd-deployment.json", document.baseURI);
  const response = await fetch(manifestUrl, { cache: "no-cache" });
  if (!response.ok)
    throw new Error(
      `Deployment configuration could not be loaded (${response.status}).`,
    );
  const deployment = (await response.json()) as Deployment;
  const allowed = [
    "version",
    "launchId",
    "chainId",
    "sourceCommit",
    "attestationHash",
    "contracts",
    "assets",
    "network",
    "walletAddChain",
  ];
  if (
    Object.keys(deployment).some((key) => !allowed.includes(key)) ||
    deployment.version !== 1 ||
    !Number.isSafeInteger(deployment.chainId) ||
    !Array.isArray(deployment.contracts) ||
    !Array.isArray(deployment.assets) ||
    deployment.assets.length > 128
  )
    throw new Error("Invalid deployment configuration.");
  if (deployment.network && deployment.network.chainId !== deployment.chainId)
    throw new Error("Network and deployment chain IDs disagree.");
  if (
    deployment.walletAddChain &&
    Number(BigInt(deployment.walletAddChain.chainId)) !== deployment.chainId
  )
    throw new Error("Wallet chain configuration disagrees with deployment.");
  const expectedNames = ["LaunchToken", "GrantExecutor", "CityRegistry"];
  if (
    deployment.contracts.length !== expectedNames.length ||
    expectedNames.some(
      (name) =>
        deployment.contracts.filter((contract) => contract.name === name)
          .length !== 1,
    )
  ) {
    throw new Error(
      "Deployment contract set is incomplete or contains duplicates.",
    );
  }
  if (
    deployment.assets.some(
      (asset) => !safePath(asset.path) || !/^[0-9a-f]{64}$/.test(asset.sha256),
    )
  )
    throw new Error("Invalid exported asset inventory.");
  deployment.contracts = await Promise.all(
    deployment.contracts.map(async (contract) => {
      if (
        !isAddress(contract.address) ||
        !safePath(contract.abiPath) ||
        !/^[0-9a-f]{64}$/.test(contract.abiHash)
      )
        throw new Error(`Invalid ${contract.name} deployment binding.`);
      if (!deployment.assets.some((asset) => asset.path === contract.abiPath))
        throw new Error(`Missing ${contract.name} ABI in asset inventory.`);
      const abiResponse = await fetch(new URL(contract.abiPath, manifestUrl));
      if (!abiResponse.ok)
        throw new Error(`${contract.name} ABI could not be loaded.`);
      const abi = (await abiResponse.json()) as Abi;
      if (
        !Array.isArray(abi) ||
        keccak256(stringToHex(canonicalJson(abi))).slice(2) !== contract.abiHash
      )
        throw new Error(`${contract.name} ABI integrity check failed.`);
      return { ...contract, abi };
    }),
  );
  return deployment;
}

export function getContract(
  deployment: Deployment,
  name: string,
): DeploymentContract {
  const contract = deployment.contracts.find((entry) => entry.name === name);
  if (!contract) throw new Error(`Missing ${name} deployment.`);
  return contract;
}

export function makeClient(
  deployment: Deployment,
  provider?: EIP1193Provider,
): PublicClient {
  const network = deployment.network;
  if (!network?.rpcUrls.length && !provider)
    throw new Error(
      "No public RPC is configured. Connect a supported wallet to read state.",
    );
  const chain = defineChain({
    id: deployment.chainId,
    name: network?.name ?? `Chain ${deployment.chainId}`,
    nativeCurrency: network?.nativeCurrency ?? {
      name: "Ether",
      symbol: "ETH",
      decimals: 18,
    },
    rpcUrls: { default: { http: network?.rpcUrls ?? [] } },
    ...(network
      ? {
          blockExplorers: {
            default: { name: network.name, url: network.explorer },
          },
          testnet: network.testnet,
        }
      : {}),
  });
  const transports: Transport[] = (network?.rpcUrls ?? []).map((url) =>
    http(url, {
      timeout: 12_000,
      retryCount: 1,
      batch: { wait: 12, batchSize: 50 },
    }),
  );
  if (provider) transports.push(custom(provider, { retryCount: 0 }));
  return createPublicClient({
    chain,
    transport: fallback(transports, { rank: false, retryCount: 0 }),
  }) as PublicClient;
}

export function errorMessage(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage || error.message;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error)
    return String(error.message);
  return "The request failed. Please try again.";
}
