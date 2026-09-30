import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { decodeAbiParameters, parseAbiParameters, parseEther, zeroAddress } from 'viem';

// Load the actual TypeScript source through the project's existing Vite dependency.
const server = await createServer({ configFile: false, root: new URL('..', import.meta.url).pathname, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, appType: 'custom' });
try {
  const swap = await server.ssrLoadModule('/src/swap.ts');
  const handoff = JSON.parse(await readFile(new URL('../deployment-input.json', import.meta.url), 'utf8'));
  const network = JSON.parse(await readFile(new URL('../network-input.json', import.meta.url), 'utf8'));
  const contracts = await Promise.all(handoff.contracts.map(async contract => ({ ...contract, abi: JSON.parse(await readFile(new URL(`../../docs/abi/${contract.name}.json`, import.meta.url), 'utf8')) })));
  const deployment = { ...handoff, ...network, contracts };
  const token = contracts.find(contract => contract.name === 'LaunchToken');
  const protocols = deployment.network.uniswapV4;
  const account = '0x1111111111111111111111111111111111111111';
  let checks = 0;
  const test = async (label, run) => { await run(); checks++; console.log(`PASS ${label}`); };

  await test('amount parsing rejects rounding, negative, zero and over-range values', () => {
    assert.equal(swap.parseSwapAmount('1.000000000000000001', 18), 1000000000000000001n);
    assert.equal(swap.parseSwapAmount('1.25', 6), 1250000n);
    for (const value of ['0', '-1', '1e3', '1.0000000000000000001', '340282366920938463464']) assert.throws(() => swap.parseSwapAmount(value, 18));
  });
  await test('slippage accepts precise basis points and rejects unsafe input', () => {
    assert.equal(swap.parseSlippage('0.01'), 1);
    assert.equal(swap.parseSlippage('0.5'), 50);
    assert.equal(swap.parseSlippage('5'), 500);
    for (const value of ['0', '5.01', '-1', '0.001', 'NaN', '']) assert.throws(() => swap.parseSlippage(value));
  });
  await test('native swap wire encoding binds exact amount, pool, slippage and deadline', () => {
    const request = swap.encodeSwap(deployment, true, parseEther('0.01'), parseEther('12.34'), 1900000000n);
    assert.equal(request.address, protocols.universalRouter);
    assert.equal(request.value, parseEther('0.01'));
    assert.equal(request.args[0], '0x10');
    assert.equal(request.args[2], 1900000000n);
    const [actions, params] = decodeAbiParameters(parseAbiParameters('bytes,bytes[]'), request.args[1][0]);
    assert.equal(actions, '0x060c0f');
    assert.equal(params.length, 3);
    const [trade] = decodeAbiParameters(parseAbiParameters('((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)'), params[0]);
    assert.equal(trade.poolKey.currency0, zeroAddress);
    assert.equal(trade.poolKey.currency1.toLowerCase(), token.address.toLowerCase());
    assert.equal(trade.poolKey.fee, handoff.manifest.pool.fee);
    assert.equal(trade.poolKey.tickSpacing, handoff.manifest.pool.tickSpacing);
    assert.equal(trade.poolKey.hooks, zeroAddress);
    assert.equal(trade.zeroForOne, true);
    assert.equal(trade.amountIn, parseEther('0.01'));
    assert.equal(trade.amountOutMinimum, parseEther('12.34'));
    assert.equal(trade.hookData, '0x');
    assert.deepEqual(decodeAbiParameters(parseAbiParameters('address,uint256'), params[1]), [zeroAddress, parseEther('0.01')]);
    const take = decodeAbiParameters(parseAbiParameters('address,uint256'), params[2]);
    assert.equal(take[0].toLowerCase(), token.address.toLowerCase());
    assert.equal(take[1], parseEther('12.34'));
  });
  await test('token sale settles GRID, takes native ETH, and sends no transaction value', () => {
    const request = swap.encodeSwap(deployment, false, parseEther('1000'), parseEther('0.02'), 1900000000n);
    assert.equal(request.value, 0n);
    const [, params] = decodeAbiParameters(parseAbiParameters('bytes,bytes[]'), request.args[1][0]);
    const settle = decodeAbiParameters(parseAbiParameters('address,uint256'), params[1]);
    assert.equal(settle[0].toLowerCase(), token.address.toLowerCase());
    assert.equal(settle[1], parseEther('1000'));
    assert.deepEqual(decodeAbiParameters(parseAbiParameters('address,uint256'), params[2]), [zeroAddress, parseEther('0.02')]);
  });

  const calls = [];
  let chain = deployment.chainId;
  let missingCode = false;
  let initialized = true;
  let liquidity = 1000n;
  const client = {
    getChainId: async () => chain,
    getCode: async request => { calls.push(['code', request]); return missingCode ? '0x' : '0x6001'; },
    getBalance: async () => parseEther('1'),
    readContract: async request => {
      calls.push(['read', request]);
      switch (request.functionName) {
        case 'getSlot0': return [initialized ? 2n ** 96n : 0n, 0, 0, 3000];
        case 'getLiquidity': return liquidity;
        case 'balanceOf': return parseEther('2000');
        case 'decimals': return 18;
        case 'allowance': return request.address === protocols.permit2 ? [parseEther('1000'), 1900000000, 0] : parseEther('1000');
        default: throw new Error(`Unexpected call ${request.functionName}`);
      }
    },
  };
  await test('swap preflight uses runtime network addresses and actual pool and allowance reads', async () => {
    const state = await swap.fetchSwapState(client, deployment, account);
    assert.equal(state.tokenBalance, parseEther('2000'));
    assert.equal(state.routerAllowance, parseEther('1000'));
    assert.equal(state.routerExpiration, 1900000000);
    assert.equal(state.liquidity, 1000n);
    const codes = calls.filter(([type]) => type === 'code').map(([, request]) => request.address);
    assert.deepEqual(codes.sort(), ['poolManager', 'quoter', 'universalRouter', 'stateView', 'permit2'].map(name => protocols[name]).sort());
    assert(calls.some(([, r]) => r.functionName === 'allowance' && r.address === token.address && r.args[1] === protocols.permit2));
    assert(calls.some(([, r]) => r.functionName === 'allowance' && r.address === protocols.permit2 && r.args[1] === token.address && r.args[2] === protocols.universalRouter));
  });
  await test('wrong chain, missing code, uninitialized pool, and empty liquidity fail closed', async () => {
    chain = 1;
    await assert.rejects(swap.fetchSwapState(client, deployment, account), /wrong network/);
    chain = deployment.chainId; missingCode = true;
    await assert.rejects(swap.fetchSwapState(client, deployment, account), /has no code/);
    missingCode = false; initialized = false;
    await assert.rejects(swap.fetchSwapState(client, deployment, account), /not been initialized/);
    initialized = true; liquidity = 0n;
    await assert.rejects(swap.fetchSwapState(client, deployment, account), /no active liquidity/);
    assert.throws(() => swap.encodeSwap({ ...deployment, network: undefined }, true, 1n, 1n, 1n), /no vetted/);
  });
  await test('quote invokes simulation only and rejects unsupported zero output', async () => {
    let output = parseEther('30');
    let request;
    const quoteClient = { simulateContract: async value => { request = value; return { result: [output, 150000n] }; } };
    assert.equal(await swap.quoteSwap(quoteClient, deployment, account, true, parseEther('0.01')), output);
    assert.equal(request.address, protocols.quoter);
    assert.equal(request.functionName, 'quoteExactInputSingle');
    assert.equal(request.account, account);
    assert.equal(request.args[0].exactAmount, parseEther('0.01'));
    output = 0n;
    await assert.rejects(swap.quoteSwap(quoteClient, deployment, account, true, 1n), /No supported output/);
  });
  console.log(`${checks} swap checks passed. No live RPC calls or transactions.`);
} finally { await server.close(); }
