const fs = require('fs');
const path = 'automation-engine/src/sites/nxCertificate.js';
let content = fs.readFileSync(path, 'utf8');
content = content.replace(/const normalized = raw.toLowerCase\(\);\s+const compact = normalized.replace\(/\\s\+/g, ''\);\s+const tags = \[normalized\];\s+if \(\/usb\|move\|remov\/\.test\(normalized\) \|\| .*? tags\.push\('hsm'\);/s,
`const normalized = raw.toLowerCase();
    const tags = [normalized];
    if (/usb|move|remov/.test(normalized)) tags.push('usb');
    if (/hdd|hard|disk|pc|local/.test(normalized)) tags.push('hdd');
    if (/browser|web/.test(normalized)) tags.push('browser');
    if (/file|pfx|p12|finder/.test(normalized)) tags.push('fcert');
    if (/token|hsm|bio/.test(normalized)) tags.push('hsm');`);
fs.writeFileSync(path, content, 'utf8');
