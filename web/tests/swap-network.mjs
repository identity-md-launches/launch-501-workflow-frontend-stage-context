import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { createPublicClient, http, parseEther, zeroAddress } from 'viem';

// Optional read-only diagnostic. Uses only vetted public RPCs from the handoff.
// Never creates a wallet client or sends/signs a transaction.
const server = await createServer({ configFile: false, root: new URL('..', import.meta.url).pathname, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, appType: 'custom' });
try {
  const { poolId, getPoolKey, stateViewAbi, quoterAbi } = await server.ssrLoadModule('/src/swap.ts');
  const handoff = JSON.parse(await readFile(new URL('../deployment-input.json', import.meta.url), 'utf8'));
  const { network } = JSON.parse(await readFile(new URL('../network-input.json', import.meta.url), 'utf8'));
  const deployment = { ...handoff, network };
  const id = poolId(deployment);
  const endpoints = await Promise.all(network.rpcUrls.map(async url => {
    const client = createPublicClient({ transport: http(url, { timeout: 8000, retryCount: 0 }) });
    try {
      const chainId = await client.getChainId();
      if (chainId !== deployment.chainId) return { url, status: 'wrong-chain', chainId };
      const block = await client.getBlockNumber();
      const codes = await Promise.all(Object.entries(network.uniswapV4).map(async ([name, address]) => {
        const code = await client.getCode({ address, blockNumber: block });
        return { name, address, byteLength: code ? (code.length - 2) / 2 : 0 };
      }));
      const [slot0, liquidity] = await Promise.all([
        client.readContract({ address: network.uniswapV4.stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [id], blockNumber: block }),
        client.readContract({ address: network.uniswapV4.stateView, abi: stateViewAbi, functionName: 'getLiquidity', args: [id], blockNumber: block }),
      ]);
      const quotes = await Promise.all([{ direction: 'ETH to GRID', zeroForOne: true, amountIn: parseEther('0.001') }, { direction: 'GRID to ETH', zeroForOne: false, amountIn: parseEther('1000') }].map(async input => {
        try {
          const { result } = await client.simulateContract({ address: network.uniswapV4.quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle', account: zeroAddress, blockNumber: block, args: [{ poolKey: getPoolKey(deployment), zeroForOne: input.zeroForOne, exactAmount: input.amountIn, hookData: '0x' }] });
          return { direction: input.direction, amountIn: input.amountIn, amountOut: result[0], gasEstimate: result[1] };
        } catch (error) { return { direction: input.direction, error: error.shortMessage || error.message }; }
      }));
      return { url, status: 'read', chainId, block, codes, poolId: id, sqrtPriceX96: slot0[0], tick: slot0[1], liquidity, quotes };
    } catch (error) {
      return { url, status: 'unavailable', error: error.shortMessage || error.message };
    }
  }));
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), mode: 'read-only', endpoints }, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
} finally { await server.close(); }
