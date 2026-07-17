import { defineConfig, configDefaults } from 'vitest/config'

// Phase-1 SAA: pure unit tests only (no emulator). Compiled lib/ output is CommonJS
// that vitest can't import, so it is excluded alongside the vitest defaults.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'lib/**'],
  },
})
