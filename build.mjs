import { build } from 'esbuild';

const shared = {
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: true,
  keepNames: true,
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __hmCreateRequire } from 'node:module';\nconst require = __hmCreateRequire(import.meta.url);",
  },
};

// npm package
await build({ ...shared, outfile: 'dist/hivemind.mjs' });
// Claude Code plugin ships its own copy (plugins install from git, so this one is committed)
await build({ ...shared, outfile: 'plugin/dist/hivemind.mjs' });
