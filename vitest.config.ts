import { defineConfig } from 'vitest/config';

export default defineConfig({
  // install/uninstall tests shell out to the real claude and codex CLIs (sandboxed), which can take a few seconds.
  test: { setupFiles: ['test/setup.ts'], testTimeout: 30_000 },
});
