const fs = require('node:fs');
const path = require('node:path');

const packageManager = process.env.npm_config_user_agent ?? '';
if (!packageManager.startsWith('pnpm/')) {
  console.error('Use pnpm instead');
  process.exit(1);
}

const workspaceRoot = path.resolve(__dirname, '..');
for (const lockfile of ['package-lock.json', 'yarn.lock']) {
  fs.rmSync(path.join(workspaceRoot, lockfile), { force: true });
}
