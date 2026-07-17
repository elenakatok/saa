// ═══════════════════════════════════════════════════════════════════════════════
// SAA resolution — public entry point (barrel).
//
// Phase 1 landed the 5-call resolver-consumption proof here. Phase 2 Slice 1
// promoted the real core into src/auction/ (valueMatrix + increment schedule +
// carry-over round resolution). This barrel keeps `./roundResolution` as the
// stable import surface for the rest of SAA.
// ═══════════════════════════════════════════════════════════════════════════════

export * from './auction/valueMatrix'
export * from './auction/increment'
export * from './auction/resolution'
