import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createPublicClient, fallback, http } from 'viem'
import { inputs, pinnedAbi, repoDir } from './manifest-common.mjs'

const { handoff, networkInput } = await inputs()
const report = {
  checkedAt: new Date().toISOString(),
  sourceCommit: handoff.sourceCommit,
  expectedChainId: handoff.chainId,
  mode: 'Read-only public RPC; no wallet signing or broadcast',
  pinnedAbiHashesVerified: {},
  rpcUrls: networkInput?.network.rpcUrls ?? [],
  expectedWorkflowRole: '0x5b95A971B4583A5f011E9DA082acdD679b870D06',
}
const contracts = handoff.contracts.map(contract => {
  const abi = JSON.parse(pinnedAbi(handoff, contract))
  report.pinnedAbiHashesVerified[contract.name] = contract.abiHash
  return { ...contract, abi }
})
try {
  if (!networkInput) throw new Error('No vetted public RPC is supplied')
  const client = createPublicClient({ transport: fallback(networkInput.network.rpcUrls.map(url => http(url, { timeout: 10_000, retryCount: 0, batch: { wait: 10, batchSize: 50 } })), { retryCount: 0 }) })
  report.chainId = await client.getChainId()
  if (report.chainId !== handoff.chainId) throw new Error('Configured RPC chain does not match handoff')
  const blockNumber = await client.getBlockNumber()
  report.blockNumber = String(blockNumber)
  report.code = await Promise.all(contracts.map(async contract => {
    const bytecode = await client.getCode({ address: contract.address, blockNumber })
    return { name: contract.name, address: contract.address, byteLength: (bytecode?.length ?? 2) / 2 - 1 }
  }))
  if (report.code.some(contract => contract.byteLength <= 0)) throw new Error('A configured contract has no code')
  const read = (name, functionName, args = []) => {
    const contract = contracts.find(entry => entry.name === name)
    return client.readContract({ address: contract.address, abi: contract.abi, functionName, args, blockNumber })
  }
  const [token, executor, treasury, operator, decimals, soldPlots, totalWeight, rewardsPool, resourcePot, heartbeatCount, lastHeartbeatTimestamp, grantsPaused, cities] = await Promise.all([
    read('CityRegistry', 'token'), read('CityRegistry', 'grantExecutor'), read('CityRegistry', 'treasury'), read('GrantExecutor', 'operator'), read('LaunchToken', 'decimals'),
    read('CityRegistry', 'soldPlots'), read('CityRegistry', 'totalWeight'), read('CityRegistry', 'rewardsPool'), read('CityRegistry', 'resourcePot'), read('CityRegistry', 'heartbeatCount'),
    read('CityRegistry', 'lastHeartbeatTimestamp'), read('GrantExecutor', 'grantsPaused'),
    Promise.all(Array.from({ length: 256 }, (_, id) => read('CityRegistry', 'cities', [BigInt(id)]))),
  ])
  report.bindings = { token, executor, treasury, operator, decimals: Number(decimals) }
  report.bindingChecks = {
    token: token.toLowerCase() === contracts.find(contract => contract.name === 'LaunchToken').address.toLowerCase(),
    executor: executor.toLowerCase() === contracts.find(contract => contract.name === 'GrantExecutor').address.toLowerCase(),
    treasuryPolicy: treasury.toLowerCase() === report.expectedWorkflowRole.toLowerCase(),
    operatorPolicy: operator.toLowerCase() === report.expectedWorkflowRole.toLowerCase(),
    decimals: Number(decimals) === 18,
  }
  report.snapshot = { soldPlots, totalWeight, rewardsPool, resourcePot, heartbeatCount, lastHeartbeatTimestamp, grantsPaused, citiesRead: cities.length, ownedCities: cities.filter(([owner]) => owner !== '0x0000000000000000000000000000000000000000').length }
  if (soldPlots < 256n) report.snapshot.purchaseQuote = await read('CityRegistry', 'quote')
  report.result = Object.values(report.bindingChecks).every(Boolean) ? 'Read-only verification passed' : 'Authorization or deployment binding conflict: runtime writes remain disabled'
} catch (error) {
  report.result = 'Live verification unavailable'
  report.error = error.shortMessage ?? error.message
  report.limitations = 'No live state or authorization claims are inferred from failed RPC requests. Browser transaction controls remain locked until runtime verification succeeds.'
}
await writeFile(path.join(repoDir, 'docs', 'deployment-validation.json'), JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n')
console.log(JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2))
