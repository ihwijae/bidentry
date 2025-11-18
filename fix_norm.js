const fs = require('fs');
const path = 'automation-engine/src/sites/nxCertificate.js';
let content = fs.readFileSync(path, 'utf8');
content = content.replace(/replace\(\[/, "replace(/[\\s\\u00a0\-_/()\\[\\]]/g, '");
fs.writeFileSync(path, content, 'utf8');
