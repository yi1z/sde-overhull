import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
    // Hosted Windows Git/process operations are slower than the local workstation.
    testTimeout: process.env.CI ? 60000 : 20000,
    hookTimeout: process.env.CI ? 90000 : 30000,
    reporters: process.env.CI ? ['verbose'] : ['default'],
    pool: 'forks',
  },
});
