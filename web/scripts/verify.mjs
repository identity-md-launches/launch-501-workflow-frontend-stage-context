import { validateExport } from './manifest-common.mjs'
console.log('Export integrity verified:', JSON.stringify(await validateExport()))
