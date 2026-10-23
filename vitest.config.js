import { defineConfig } from 'vitest/config';

// Keep service/model unit tests separate from Playwright browser tests.
export default defineConfig({ test: { include: ['src/**/*.test.js'] } });
