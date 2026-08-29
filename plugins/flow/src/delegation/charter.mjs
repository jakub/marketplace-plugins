import { readFileSync } from 'node:fs'

export const FLOW_CHARTER = typeof __FLOW_CHARTER__ !== 'undefined'
  ? __FLOW_CHARTER__
  : readFileSync(new URL('../../charter/charter.md', import.meta.url), 'utf8')
