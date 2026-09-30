import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { distDir, inputs, pinnedAbi, inventory, sha256, validateExport } from './manifest-common.mjs'

const { handoff, networkInput } = await inputs()
await mkdir(path.join(distDir, 'abi'), { recursive: true })
const contracts = []
for (const contract of handoff.contracts) {
  const abiPath = `abi/${contract.name}.json`
  await writeFile(path.join(distDir, abiPath), pinnedAbi(handoff, contract))
  contracts.push({ name: contract.name, address: contract.address, abiHash: contract.abiHash, abiPath })
}
const assets = []
for (const filename of await inventory()) assets.push({ path: filename, sha256: sha256(await readFile(path.join(distDir, filename))) })
const { version, launchId, chainId, sourceCommit, attestationHash } = handoff
const manifest = { version, launchId, chainId, sourceCommit, attestationHash, contracts, assets,
  ...(networkInput ? { network: networkInput.network } : {}),
  ...(networkInput?.walletAddChain ? { walletAddChain: networkInput.walletAddChain } : {}),
}
await writeFile(path.join(distDir, 'imd-deployment.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log('Export verified:', JSON.stringify(await validateExport()))
