const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'automation-engine', 'node_modules', 'playwright-core', '.local-browsers');
try {
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`[clean] removed Playwright browsers at ${target}`);
} catch (err) {
  console.log(`[clean] skip removing Playwright browsers: ${(err && err.message) || err}`);
}
