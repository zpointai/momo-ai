import { defineConfig } from 'vitest/config';
// Calendar fixtures use this timezone; set it before workers load application defaults.
// Production still derives its timezone from the user's operating system.
process.env.TZ = 'Europe/Amsterdam';
export default defineConfig({ test: { include: ['tests/**/*.test.{ts,tsx}'], environment: 'node', maxWorkers: 4 } });
