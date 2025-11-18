const fs = require('fs');
const path = 'automation-engine/src/sites/nxCertificate.js';
const lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('const stripCorp')) {
    lines[i] = "    const stripCorp = (value) => toNfkc(value).replace(/\\u3260|\\uC8FC\\uC2DD\\uD68C\\uC0AC|\\(\\uC8FC\\)/gi, '');";
  }
  if (lines[i].includes('if (/공동')) {
    lines[i] = "                if (/\\uACF5\\uB3D9\\uC778\\uC99D|\\uC778\\uC99D\\uC11C\\uC120\\uD0DD|\\uC778\\uC99D\\uC11C\\uB85C\\uADF8\\uC778/.test(compact)) {";
  }
  if (lines[i].includes('return /갱신')) {
    lines[i] = "    const disqualify = (nfkcText) => /\\uAC31\\uC2E0|\\uB9CC\\uB8CC|\\uD3D0\\uC9C0|\\uC5F0\\uC7A5\\uC548\\uB0B4|\\uC5C5\\uB370\\uC774\\uD2B8/i.test(nfkcText || '');";
  }
}
fs.writeFileSync(path, lines.join('\r\n'), 'utf8');
