import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/test/**/*.test.mjs'],
    environment: 'node',
  },
});
