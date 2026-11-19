import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Blocks all network access during tests (money rule 1). See tests/setup.ts.
    setupFiles: ['tests/setup.ts'],
  },
});
