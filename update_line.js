const fs = require('fs');
const path = 'automation-engine/src/sites/nxCertificate.js';
const lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('rawText.replace(')) {
    lines[i] = "                const compact = rawText.replace(/\\s+/g, '');";
    break;
  }
}
fs.writeFileSync(path, lines.join('\r\n'), 'utf8');
