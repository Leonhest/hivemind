import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Never let a test touch the developer's real agent configs: install/uninstall (and the
// `claude`/`codex` CLIs they call) resolve every config dir from these variables, and
// child processes inherit them.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-test-home-'));
for (const dir of ['claude', 'codex', 'cursor', 'hivemind', 'linkbin']) fs.mkdirSync(path.join(sandbox, dir));
Object.assign(process.env, {
  HOME: sandbox,
  CLAUDE_CONFIG_DIR: path.join(sandbox, 'claude'),
  CODEX_HOME: path.join(sandbox, 'codex'),
  CURSOR_CONFIG_DIR: path.join(sandbox, 'cursor'),
  HIVEMIND_HOME: path.join(sandbox, 'hivemind'),
  HIVEMIND_LINK_DIRS: path.join(sandbox, 'linkbin'),
  SHELL: '/bin/sh',
});
