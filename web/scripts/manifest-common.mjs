import { readFile, readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { keccak256, stringToHex, isAddress } from 'viem'

export const webDir = fileURLToPath(new URL('..', import.meta.url))
export const repoDir = path.resolve(webDir, '..')
export const distDir = path.resolve(repoDir, 'dist')
export const json = async filename => JSON.parse(await readFile(filename, 'utf8'))
export function assert(condition, message) { if (!condition) throw new Error(message) }
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
export const abiHash = abi => keccak256(stringToHex(canonical(abi))).slice(2)
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const equal = (left, right) => canonical(left) === canonical(right)
export const safePath = name => typeof name === 'string' && name.length > 0 && !name.startsWith('/') && !name.includes('\\') && !name.includes(':') && !name.split('/').some(part => ['', '.', '..'].includes(part))

export async function inputs() {
  const handoff = await json(path.join(webDir, 'deployment-input.json'))
  let networkInput
  try { networkInput = await json(path.join(webDir, 'network-input.json')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  assert(handoff.version === 1 && Number.isSafeInteger(handoff.chainId), 'Invalid handoff version or chain ID')
  assert(/^[0-9a-f]{40}$/.test(handoff.sourceCommit), 'Source commit must be a pinned commit SHA')
  assert(/^[0-9a-f]{64}$/.test(handoff.attestationHash), 'Invalid attestation hash')
  assert(typeof handoff.launchId === 'string' && handoff.launchId.length > 0, 'Missing launch ID')
  assert(Array.isArray(handoff.contracts) && handoff.contracts.length === 3, 'Unexpected contract set')
  assert(new Set(handoff.contracts.map(contract => contract.name)).size === handoff.contracts.length, 'Duplicate contracts')
  for (const contract of handoff.contracts) {
    assert(['CityRegistry', 'LaunchToken', 'GrantExecutor'].includes(contract.name), `Unexpected contract ${contract.name}`)
    assert(isAddress(contract.address) && /^[0-9a-f]{64}$/.test(contract.abiHash), `Invalid handoff contract ${contract.name}`)
  }
  if (networkInput) {
    assert(networkInput.network.chainId === handoff.chainId, 'Handoff/network chain mismatch')
    assert(networkInput.network.rpcUrls.every(url => new URL(url).protocol === 'https:'), 'Public RPC URLs must use HTTPS')
    if (networkInput.walletAddChain) assert(Number(BigInt(networkInput.walletAddChain.chainId)) === handoff.chainId, 'Wallet chain mismatch')
  }
  // During assignment validation, copies must match the pinned read-only inputs. Rebuilds remain self-contained after those inputs are removed.
  for (const [name, value] of [['deployment', handoff], ['network', networkInput]]) {
    try { assert(equal(await json(path.join(repoDir, '.imd', 'reads', `${name}.json`)), value), `Saved ${name} input differs from the assignment handoff`) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return { handoff, networkInput }
}

export function pinnedAbi(handoff, contract) {
  const bytes = execFileSync('git', ['show', `${handoff.sourceCommit}:docs/abi/${contract.name}.json`], { cwd: repoDir, maxBuffer: 8 * 1024 * 1024 })
  const abi = JSON.parse(bytes.toString('utf8'))
  assert(Array.isArray(abi), `${contract.name} ABI must be a raw JSON array`)
  assert(abiHash(abi) === contract.abiHash, `${contract.name} pinned ABI hash does not match handoff`)
  return bytes
}

export async function inventory(directory = distDir, prefix = '') {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name
    assert(!entry.isSymbolicLink(), `Export cannot contain symlink ${relative}`)
    if (entry.isDirectory()) files.push(...await inventory(path.join(directory, entry.name), relative + '/'))
    else if (entry.isFile() && relative !== 'imd-deployment.json') files.push(relative)
  }
  return files.sort()
}

export async function validateExport() {
  const { handoff, networkInput } = await inputs()
  const manifest = await json(path.join(distDir, 'imd-deployment.json'))
  const keys = ['version', 'launchId', 'chainId', 'sourceCommit', 'attestationHash', 'contracts', 'assets']
  if (networkInput) keys.push('network')
  if (networkInput?.walletAddChain) keys.push('walletAddChain')
  assert(equal(Object.keys(manifest).sort(), keys.sort()), 'Manifest top-level schema differs from the required schema')
  for (const key of ['version', 'launchId', 'chainId', 'sourceCommit', 'attestationHash']) assert(manifest[key] === handoff[key], `Manifest ${key} differs from handoff`)
  if (networkInput) assert(equal(manifest.network, networkInput.network), 'Manifest network block differs from chain table')
  if (networkInput?.walletAddChain) assert(equal(manifest.walletAddChain, networkInput.walletAddChain), 'Manifest walletAddChain differs from chain table')
  const expectedContracts = handoff.contracts.map(({ name, address, abiHash }) => ({ name, address, abiHash, abiPath: `abi/${name}.json` }))
  assert(equal(manifest.contracts, expectedContracts), 'Manifest contract set/bindings differ from handoff')
  for (const contract of manifest.contracts) {
    const exported = await readFile(path.join(distDir, contract.abiPath))
    assert(exported.equals(pinnedAbi(handoff, contract)), `${contract.name} ABI bytes differ from the pinned source export`)
    assert(abiHash(JSON.parse(exported)) === contract.abiHash, `${contract.name} exported ABI hash is invalid`)
  }
  const files = await inventory()
  assert(Array.isArray(manifest.assets) && files.length <= 128, 'Export asset count exceeds 128')
  assert(equal(files, manifest.assets.map(asset => asset.path).sort()), 'Manifest does not enumerate exactly every exported file')
  assert(files.includes('index.html'), 'Export is missing index.html')
  let totalBytes = (await stat(path.join(distDir, 'imd-deployment.json'))).size
  for (const asset of manifest.assets) {
    assert(equal(Object.keys(asset).sort(), ['path', 'sha256']), `Invalid asset fields for ${asset.path}`)
    assert(safePath(asset.path), `Unsafe asset path ${asset.path}`)
    assert(/^[0-9a-f]{64}$/.test(asset.sha256), `Invalid hash format for ${asset.path}`)
    const bytes = await readFile(path.join(distDir, asset.path))
    assert(bytes.length <= 8 * 1024 * 1024, `Asset exceeds 8 MiB: ${asset.path}`)
    assert(sha256(bytes) === asset.sha256, `Asset hash mismatch: ${asset.path}`)
    totalBytes += bytes.length
  }
  assert(totalBytes < 30 * 1024 * 1024, 'Export leaves insufficient room in the publication HTTP budget')
  return { assets: files.length, bytes: totalBytes, sourceCommit: handoff.sourceCommit, abiHashes: Object.fromEntries(handoff.contracts.map(contract => [contract.name, contract.abiHash])) }
}
