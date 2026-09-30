import { useCallback, useEffect, useRef, useState } from "react";
import {
  createWalletClient,
  custom,
  getAddress,
  type Abi,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { loadDeployment, makeClient, type Deployment } from "./config";
import { readSnapshot, verifyDeployment, type Snapshot } from "./chain";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}
export type ActionRequest = {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
};
export function describeError(error: unknown): string {
  const e = error as {
    code?: number;
    shortMessage?: string;
    message?: string;
    cause?: unknown;
    data?: { errorName?: string };
  };
  const message = e?.shortMessage || e?.message || "";
  const names: Record<string, string> = {
    CityOccupied: "This plot was purchased. Select another plot.",
    AlreadyOwnsCity: "This wallet already owns a soulbound city.",
    InsufficientHolding: "You need at least 1,000 GRID before buying.",
    InsufficientResources: "This city needs more resources to level up.",
    MaximumLevel: "This city is already at level 20.",
    NothingToClaim: "There are no rewards to claim yet.",
    Unauthorized: "This wallet is not authorized for this action.",
    GrantsPaused: "Resource grants are paused.",
    DuplicateWinner: "Choose three different owned cities.",
    ERC20InsufficientAllowance:
      "The price or allowance changed. Refresh and approve the current total.",
    ERC20InsufficientBalance: "Your GRID balance is too low for this action.",
    InsufficientResourcePot: "The resource pot cannot cover this grant.",
    NotCityOwner: "Only this city’s owner can perform this action.",
  };
  for (const [key, value] of Object.entries(names))
    if (message.includes(key) || e?.data?.errorName === key) return value;
  if (e?.code === 4001 || /rejected|denied/i.test(message))
    return "Request rejected in your wallet. Nothing was submitted; you can try again.";
  if (/insufficient funds/i.test(message))
    return "Your wallet needs more Sepolia ETH to pay network fees.";
  if (e?.cause && e.cause !== error) {
    const nested = describeError(e.cause);
    if (!nested.startsWith("Unable to")) return nested;
  }
  return message && !/0x[0-9a-f]{8}/i.test(message)
    ? message.slice(0, 230)
    : "Unable to complete the request. Refresh live state and try again.";
}
export function useSwarm() {
  const [deployment, setDeployment] = useState<Deployment>();
  const [client, setClient] = useState<ReturnType<typeof makeClient>>();
  const [account, setAccount] = useState<Address>();
  const [chainId, setChainId] = useState<number>();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [verified, setVerified] = useState(false);
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [verificationError, setVerificationError] = useState("");
  const [notice, setNotice] = useState("Loading deployment configuration…");
  const [pending, setPending] = useState("");
  const [txHash, setTxHash] = useState<Hex>();
  const lock = useRef(false),
    generation = useRef(0),
    refreshPromise = useRef<Promise<void> | undefined>(undefined);
  useEffect(() => {
    let active = true;
    loadDeployment()
      .then((d) => {
        if (active) {
          setDeployment(d);
          setClient(makeClient(d));
          setNotice("Reading the city network…");
        }
      })
      .catch((e) => {
        if (active) {
          setError(describeError(e));
          setNotice("Deployment unavailable. Reload to retry.");
        }
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const provider = window.ethereum;
    if (!provider) return;
    const accounts = (values: unknown) => {
      const a = values as string[];
      generation.current++;
      setAccount(a[0] ? getAddress(a[0]) : undefined);
      setSnapshot(undefined);
      setVerified(false);
    };
    const chain = (id: unknown) => {
      generation.current++;
      setChainId(Number(id));
      setVerified(false);
    };
    const disconnect = () => {
      generation.current++;
      setAccount(undefined);
      setVerified(false);
      setSnapshot(undefined);
    };
    provider.on("accountsChanged", accounts);
    provider.on("chainChanged", chain);
    provider.on("disconnect", disconnect);
    provider
      .request({ method: "eth_accounts" })
      .then(accounts)
      .catch(() => {});
    provider
      .request({ method: "eth_chainId" })
      .then(chain)
      .catch(() => {});
    return () => {
      provider.removeListener("accountsChanged", accounts);
      provider.removeListener("chainChanged", chain);
      provider.removeListener("disconnect", disconnect);
    };
  }, []);
  useEffect(() => {
    if (deployment)
      setClient(
        makeClient(
          deployment,
          account && chainId === deployment.chainId
            ? window.ethereum
            : undefined,
        ),
      );
  }, [deployment, account, chainId]);
  const latestRefresh = useRef<() => Promise<void>>(async () => {});
  const refresh = useCallback(async () => {
    if (!deployment || !client) return;
    if (refreshPromise.current) {
      await refreshPromise.current;
      return latestRefresh.current();
    }
    const run = (async () => {
      setLoading(true);
      const version = generation.current;
      try {
        const check = await verifyDeployment(deployment, client);
        const next = await readSnapshot(deployment, client, account);
        if (version !== generation.current) return;
        setSnapshot(next);
        setVerified(check.ok);
        setVerificationError(check.issues.join(" "));
        if (!lock.current)
          setNotice(`State updated at block ${next.block.toLocaleString()}.`);
      } catch (e) {
        if (version === generation.current) {
          setVerified(false);
          setVerificationError(describeError(e));
          if (!lock.current)
            setNotice(
              "Live state unavailable. Transaction controls are locked.",
            );
        }
      } finally {
        setLoading(false);
      }
    })();
    refreshPromise.current = run;
    try {
      await run;
    } finally {
      refreshPromise.current = undefined;
    }
  }, [deployment, client, account]);
  latestRefresh.current = refresh;
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden && !lock.current) void refresh();
    }, 20000);
    return () => clearInterval(timer);
  }, [refresh]);
  const connect = async () => {
    setError("");
    if (!window.ethereum) {
      setError(
        "No browser wallet detected. Open this site in an Ethereum wallet browser or install a browser wallet, then reload.",
      );
      return;
    }
    setConnecting(true);
    try {
      const addresses = await window.ethereum.request({
        method: "eth_requestAccounts",
      });
      generation.current++;
      setSnapshot(undefined);
      setVerified(false);
      setAccount(addresses[0] ? getAddress(addresses[0]) : undefined);
      setChainId(
        Number(await window.ethereum.request({ method: "eth_chainId" })),
      );
    } catch (e) {
      setError(describeError(e));
    } finally {
      setConnecting(false);
    }
  };
  const switchChain = async () => {
    if (!deployment || !window.ethereum) return;
    setConnecting(true);
    setError("");
    const params = [{ chainId: `0x${deployment.chainId.toString(16)}` }] as [
      { chainId: Hex },
    ];
    try {
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params,
        });
      } catch (e) {
        const x = e as { code?: number; message?: string };
        if (
          (x.code === 4902 ||
            /unknown chain|unrecognized chain|not added/i.test(
              x.message || "",
            )) &&
          deployment.walletAddChain
        ) {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [deployment.walletAddChain],
          });
          await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params,
          });
        } else throw e;
      }
      setChainId(
        Number(await window.ethereum.request({ method: "eth_chainId" })),
      );
    } catch (e) {
      setError(describeError(e));
    } finally {
      setConnecting(false);
    }
  };
  const ready = Boolean(
    account &&
      deployment &&
      client &&
      verified &&
      chainId === deployment.chainId &&
      snapshot,
  );
  const execute = async (
    label: string,
    request: ActionRequest,
  ): Promise<boolean> => {
    if (
      lock.current ||
      !ready ||
      !account ||
      !deployment ||
      !client ||
      !window.ethereum
    )
      return false;
    lock.current = true;
    setPending(label);
    setError("");
    setTxHash(undefined);
    const expectedAccount = account;
    try {
      const assertWallet = async () => {
        const current = await window.ethereum!.request({
          method: "eth_accounts",
        });
        const currentChain = Number(
          await window.ethereum!.request({ method: "eth_chainId" }),
        );
        if (
          current[0]?.toLowerCase() !== expectedAccount.toLowerCase() ||
          currentChain !== deployment.chainId
        )
          throw new Error(
            "Wallet account or network changed. Refresh before trying again.",
          );
      };
      await assertWallet();
      const verification = await verifyDeployment(deployment, client);
      if (!verification.ok) throw new Error(verification.issues.join(" "));
      setNotice(`${label}: checking the transaction…`);
      const simulation = await client.simulateContract({
        ...request,
        account: expectedAccount,
      });
      await assertWallet();
      setNotice(`${label}: confirm in your wallet.`);
      const wallet = createWalletClient({
        chain: client.chain,
        transport: custom(window.ethereum),
      });
      const hash = await wallet.writeContract(simulation.request);
      setTxHash(hash);
      setNotice(`${label}: waiting for confirmation…`);
      const receipt = await client.waitForTransactionReceipt({
        hash,
        confirmations: 1,
        timeout: 120000,
      });
      if (receipt.status !== "success")
        throw new Error(
          "Transaction reverted. No action completed; network fees may still apply.",
        );
      setNotice(`${label}: confirmed. Refreshing live state…`);
      await refresh();
      setNotice(`${label}: confirmed.`);
      return true;
    } catch (e) {
      setError(describeError(e));
      setNotice(
        `${label}: not completed. Check the transaction link if one is shown.`,
      );
      return false;
    } finally {
      lock.current = false;
      setPending("");
    }
  };
  return {
    deployment,
    client,
    account,
    chainId,
    snapshot,
    verified,
    loading,
    connecting,
    error: [verificationError, error].filter(Boolean).join(" "),
    notice,
    pending,
    txHash,
    ready,
    refresh,
    connect,
    switchChain,
    execute,
  };
}
