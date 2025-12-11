const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const workspaceDir = path.join(__dirname, '..', 'automation-engine');
const nodeModulesDir = path.join(workspaceDir, 'node_modules');
const lockFile = path.join(workspaceDir, 'package-lock.json');

if (fs.existsSync(nodeModulesDir)) {
  console.log(`[build] automation-engine dependencies already installed at ${nodeModulesDir}`);
  process.exit(0);
}

console.log('[build] installing automation-engine dependencies once before packaging...');
const npmArgs = fs.existsSync(lockFile) ? ['ci'] : ['install'];
const result = spawnSync('npm', npmArgs, {
  cwd: workspaceDir,
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' }
});

if (result.status !== 0) {
  console.error('[build] failed to install automation-engine dependencies');
  process.exit(result.status || 1);
}
