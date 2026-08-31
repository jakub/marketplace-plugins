import { readFileSync } from 'node:fs'

export const FLOW_SEAT_CONTRACT = typeof __FLOW_SEAT_CONTRACT__ !== 'undefined'
  ? __FLOW_SEAT_CONTRACT__
  : readFileSync(new URL('../../seat-contract.md', import.meta.url), 'utf8')
