/** Production-export browser fixture. No RPC request or signed transaction leaves the process. */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, extname } from 'node:path';
import { decodeFunctionData, encodeFunctionResult, parseAbi, zeroAddress, parseEther } from 'viem';

export const buyer = '0x1111111111111111111111111111111111111111';
export const operator = '0x5b95A971B4583A5f011E9DA082acdD679b870D06';
export const otherOwner = '0x2222222222222222222222222222222222222222';
const txHash = `0x${'ab'.repeat(32)}`;
const blockHash = `0x${'cd'.repeat(32)}`;
const protocolAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
  'function allowance(address user,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)',
  'function approve(address token,address spender,uint160 amount,uint48 expiration)',
  'function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)',
  'function execute(bytes commands,bytes[] inputs,uint256 deadline) payable',
]);

export async function startFixtureServer() {
  const base = resolve(import.meta.dirname, '../../dist');
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/preview/')) { res.writeHead(404); return res.end(); }
      const relative = decodeURIComponent(url.pathname.slice('/preview/'.length)) || 'index.html';
      const path = resolve(base, relative);
      if (!path.startsWith(base + '/')) { res.writeHead(403); return res.end(); }
      const file = await readFile(path);
      res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' })[extname(path)] || 'application/octet-stream' });
      res.end(file);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/preview/`, close: () => new Promise(r => server.close(r)) };
}

export async function makeFixture(page, options = {}) {
  const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, '../../dist/imd-deployment.json'), 'utf8'));
  const byName = Object.fromEntries(manifest.contracts.map(c => [c.name, c]));
  const abis = Object.fromEntries(await Promise.all(manifest.contracts.map(async c => [c.address.toLowerCase(), JSON.parse(await readFile(resolve(import.meta.dirname, '../../dist', c.abiPath), 'utf8'))])));
  const token = byName.LaunchToken.address;
  const registry = byName.CityRegistry.address;
  const executor = byName.GrantExecutor.address;
  const account = options.account || buyer;
  const cities = new Map([
    [3, [otherOwner, 4n, parseEther('3000')]],
    [17, [options.ownsCity ? account : otherOwner, 2n, parseEther('2500')]],
    [81, [otherOwner, 3n, parseEther('1900')]],
  ]);
  const state = { account, cities, allowance: 0n, permitTokenAllowance: 0n, permitAllowance: 0n, paused: false, claimable: parseEther('125'), balance: parseEther('50000'), transactions: [], requests: [], errors: [], quoteFails: false, readFails: false, simulateFails: false, receiptDelay: 0, ...options };
  const price = () => 10000n * 10n ** 18n * (256n + BigInt(cities.size)) ** 2n / 65536n;
  const quote = () => { const p = price(); return [p, p * 4n / 100n, p + p * 4n / 100n]; };
  const block = { number: '0xb44800', hash: blockHash, parentHash: blockHash, nonce: '0x0000000000000000', sha3Uncles: blockHash, logsBloom: `0x${'00'.repeat(256)}`, transactionsRoot: blockHash, stateRoot: blockHash, receiptsRoot: blockHash, miner: zeroAddress, difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', size: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: `0x${Math.floor(Date.now()/1000).toString(16)}`, transactions: [], uncles: [], baseFeePerGas: '0x3b9aca00', mixHash: blockHash };
  function decode(tx) {
    const abi = abis[tx.to?.toLowerCase()] || protocolAbi;
    return { abi, ...decodeFunctionData({ abi, data: tx.data || tx.input }) };
  }
  function call(tx) {
    if (state.readFails) throw { code: -32000, message: 'Fixture RPC unavailable. Try again.' };
    const { abi, functionName: name, args = [] } = decode(tx);
    const target = tx.to?.toLowerCase();
    let result;
    switch (name) {
      case 'name': result = 'Swarm Cities'; break;
      case 'symbol': result = 'GRID'; break;
      case 'decimals': result = 18; break;
      case 'totalSupply': result = parseEther('1000000000'); break;
      case 'balanceOf': result = state.balance; break;
      case 'allowance': result = target === token.toLowerCase() ? (String(args[1]).toLowerCase() === registry.toLowerCase() ? state.allowance : state.permitTokenAllowance) : [state.permitAllowance, 281474976710655, 0]; break;
      case 'operator': case 'treasury': result = state.roleMismatch ? '0x09EC38170E94532EDdB57c69DfC4F1fDCD0d4a60' : operator; break;
      case 'token': result = token; break;
      case 'grantExecutor': result = executor; break;
      case 'grantsPaused': result = state.paused; break;
      case 'soldPlots': result = BigInt(cities.size); break;
      case 'cities': result = cities.get(Number(args[0])) || [zeroAddress, 0n, 0n]; break;
      case 'cityOf': result = BigInt([...cities.entries()].find(([, c]) => c[0].toLowerCase() === String(args[0]).toLowerCase())?.[0] + 1 || 0); break;
      case 'quote': result = quote(); break;
      case 'price': result = price(); break;
      case 'rewardsPool': result = parseEther('1250.4'); break;
      case 'resourcePot': result = parseEther('24000'); break;
      case 'resourcesAllocated': result = parseEther('7400'); break;
      case 'heartbeatCount': result = 6n; break;
      case 'lastHeartbeatTimestamp': result = 1790773200n; break;
      case 'lastHeartbeat': result = [[17n, parseEther('900')], [3n, parseEther('600')], [81n, parseEther('300')]][Number(args[0])]; break;
      case 'claimableRewards': result = cities.has(Number(args[0])) ? state.claimable : 0n; break;
      case 'levelUpCost': result = 100n * (cities.get(Number(args[0]))[1] + 1n) ** 2n * 10n ** 18n; break;
      case 'coordinates': result = [args[0] % 16n, args[0] / 16n]; break;
      case 'MAX_LEVEL': result = 20n; break;
      case 'MIN_HOLDING': result = parseEther('1000'); break;
      case 'PLOT_COUNT': result = 256n; break;
      case 'RESOURCE_UNIT': result = parseEther('1'); break;
      case 'REWARD_SCALE': result = 10n ** 36n; break;
      case 'rewardIndex': result = parseEther('1'); break;
      case 'totalWeight': result = 29n; break;
      case 'getSlot0': result = [2n ** 96n, 0, 0, 3000]; break;
      case 'getLiquidity': result = state.emptyLiquidity ? 0n : 1000000000000000000n; break;
      case 'quoteExactInputSingle': if (state.quoteFails) throw { code: 3, message: 'execution reverted: insufficient liquidity' }; result = [parseEther(args[0].zeroForOne ? '1500' : '0.003'), 150000n]; break;
      case 'approve': result = target === token.toLowerCase() ? true : undefined; break;
      case 'claimRewards': result = state.claimable; break;
      case 'buyCity': case 'levelUp': case 'grantResources': case 'recordHeartbeat': case 'pauseGrants': case 'unpauseGrants': case 'execute': case 'transfer': case 'transferFrom':
        if (state.simulateFails) throw { code: 3, message: 'execution reverted: fixture simulation failure' };
        result = name.startsWith('transfer') ? true : undefined; break;
      default: throw new Error(`Unhandled function ${name}`);
    }
    return encodeFunctionResult({ abi, functionName: name, result });
  }
  function mutate(tx) {
    const { functionName: name, args = [] } = decode(tx);
    state.transactions.push({ name, args, ...tx });
    switch (name) {
      case 'approve':
        if (tx.to.toLowerCase() !== token.toLowerCase()) state.permitAllowance = args[2];
        else if (String(args[0]).toLowerCase() === registry.toLowerCase()) state.allowance = args[1];
        else state.permitTokenAllowance = args[1];
        break;
      case 'buyCity': cities.set(Number(args[0]), [account, 1n, 0n]); state.allowance = 0n; state.balance -= quote()[2]; break;
      case 'levelUp': { const c = cities.get(Number(args[0])); c[2] -= 100n * (c[1] + 1n) ** 2n * 10n ** 18n; c[1]++; break; }
      case 'claimRewards': state.claimable = 0n; break;
      case 'pauseGrants': state.paused = true; break;
      case 'unpauseGrants': state.paused = false; break;
      case 'grantResources': { const c = cities.get(Number(args[1])); c[2] += args[2]; break; }
      case 'recordHeartbeat': for (let i = 1; i < 7; i += 2) cities.get(Number(args[i]))[2] += args[i+1]; break;
    }
    return txHash;
  }
  async function rpc(request) {
    const { method, params = [] } = request;
    state.requests.push(request);
    switch (method) {
      case 'eth_chainId': return '0xaa36a7';
      case 'eth_getCode': return state.missingCode ? '0x' : '0x6001600055';
      case 'eth_call': return call(params[0]);
      case 'eth_getBalance': return '0x8ac7230489e80000';
      case 'eth_blockNumber': return block.number;
      case 'eth_getBlockByNumber': case 'eth_getBlockByHash': return block;
      case 'eth_getLogs': return [];
      case 'eth_gasPrice': case 'eth_maxPriorityFeePerGas': return '0x3b9aca00';
      case 'eth_estimateGas': return '0x493e0';
      case 'eth_getTransactionCount': return '0x0';
      case 'eth_sendTransaction': return mutate(params[0]);
      case 'eth_getTransactionByHash': return { ...state.transactions.at(-1), hash: txHash, blockHash, blockNumber: block.number, transactionIndex: '0x0', nonce: '0x0', gas: '0x493e0', gasPrice: '0x3b9aca00', value: '0x0', input: state.transactions.at(-1)?.data || '0x', type: '0x0', v: '0x1b', r: txHash, s: txHash };
      case 'eth_getTransactionReceipt':
        if (state.receiptDelay) await new Promise(r => setTimeout(r, state.receiptDelay));
        return { transactionHash: txHash, transactionIndex: '0x0', blockHash, blockNumber: block.number, from: account, to: state.transactions.at(-1)?.to || registry, cumulativeGasUsed: '0x10000', gasUsed: '0x10000', contractAddress: null, logs: [], logsBloom: `0x${'00'.repeat(256)}`, status: '0x1', effectiveGasPrice: '0x3b9aca00', type: '0x0' };
      default: throw new Error(`Unhandled RPC ${method}`);
    }
  }
  await page.route('https://**/*', async route => {
    if (!manifest.network.rpcUrls.some(url => route.request().url().replace(/\/$/, '') === url.replace(/\/$/, ''))) { state.errors.push(`Unexpected external request: ${route.request().url()}`); return route.abort(); }
    try {
      const request = route.request().postDataJSON();
      const respond = async q => { try { return { jsonrpc: '2.0', id: q.id, result: await rpc(q) }; } catch (error) { return { jsonrpc: '2.0', id: q.id, error: { code: error.code || -32603, message: error.message } }; } };
      const result = Array.isArray(request) ? await Promise.all(request.map(respond)) : await respond(request);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
    } catch (error) { state.errors.push(error.message); await route.abort(); }
  });
  await page.exposeFunction('__fixtureRpc', rpc);
  if (options.wallet !== false) await page.addInitScript(({ account, wrongChain, rejectConnect }) => {
    const listeners = {};
    const wallet = { chainId: wrongChain ? '0x1' : '0xaa36a7', account, connected: false, rejectNext: rejectConnect ? 'eth_requestAccounts' : '', added: false, switchRequests: 0, requests: [],
      on(event, callback) { (listeners[event] ||= []).push(callback); }, removeListener(event, callback) { listeners[event] = listeners[event]?.filter(x => x !== callback) || []; },
      emit(event, value) { for (const cb of listeners[event] || []) cb(value); },
      async request(q) { wallet.requests.push(q); if (wallet.rejectNext === q.method) { wallet.rejectNext = ''; throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); }
        if (q.method === 'eth_chainId') return wallet.chainId;
        if (q.method === 'eth_accounts') return wallet.connected ? [wallet.account] : [];
        if (q.method === 'eth_requestAccounts') { wallet.connected = true; return [wallet.account]; }
        if (q.method === 'wallet_switchEthereumChain') { wallet.switchRequests++; if (wrongChain && !wallet.added) throw Object.assign(new Error('Unknown chain'), { code: 4902 }); wallet.chainId = q.params[0].chainId; wallet.emit('chainChanged', wallet.chainId); return null; }
        if (q.method === 'wallet_addEthereumChain') { wallet.added = true; return null; }
        if (q.method === 'wallet_getCapabilities') return {};
        return window.__fixtureRpc(q);
      },
    };
    window.ethereum = wallet; window.__wallet = wallet;
  }, { account, wrongChain: !!options.wrongChain, rejectConnect: !!options.rejectConnect });
  return { state, manifest, byName, rpc };
}
