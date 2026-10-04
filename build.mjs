import { build } from 'esbuild';

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/hivemind.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __hmCreateRequire } from 'node:module';\nconst require = __hmCreateRequire(import.meta.url);",
  },
});
