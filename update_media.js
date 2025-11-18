const fs = require('fs');
const path = 'automation-engine/src/sites/nxCertificate.js';
let content = fs.readFileSync(path, 'utf8');
content = content.replace(
/(const normalized = raw\.toLowerCase\(\);\s+const tags = \[normalized\];\s+)(if \(\/usb\|move\|remov\/\.test\(normalized\)\) tags\.push\('usb'\);\s+if \(\/hdd\|hard\|disk\|pc\|local\/\.test\(normalized\)\) tags\.push\('hdd'\);\s+if \(\/browser\|web\/\.test\(normalized\)\) tags\.push\('browser'\);\s+if \(\/file\|pfx\|p12\|finder\/\.test\(normalized\)\) tags\.push\('fcert'\);\s+if \(\/token\|hsm\|bio\/\.test\(normalized\)\) tags\.push\('hsm'\);)/,
`const normalized = raw.toLowerCase();
    const compact = normalized.replace(/\\s+/g, '');
    const tags = [normalized];
    if (/usb|move|remov/.test(normalized) || /usb|\\uC774\\uB3D9|\\uC6B0\\uC154/.test(compact)) tags.push('usb');
    if (/hdd|hard|disk|pc|local/.test(normalized) || /\\uD558\\uB4DC|\\uB514\\uC2A4\\uD06C|pc|\\uB0B4\\uC7A5/.test(compact)) tags.push('hdd');
    if (/browser|web/.test(normalized) || /\\uBE0C\\uB77C\\uC6B0\\uC800|\\uC6F9/.test(compact)) tags.push('browser');
    if (/file|pfx|p12|finder/.test(normalized) || /\\uD30C\\uC77C|pfx|p12/.test(compact)) tags.push('fcert');
    if (/token|hsm|bio/.test(normalized) || /\\uD1A0\\uD06C\\uB11B|\\uBCF4\\uC548|\\uC9C0\\uBB38|\\uC0DD\\uCCB4/.test(compact)) tags.push('hsm');`
);
fs.writeFileSync(path, content, 'utf8');
