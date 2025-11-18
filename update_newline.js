const fs = require('fs');
const path = 'automation-engine/src/sites/nxCertificate.js';
let content = fs.readFileSync(path, 'utf8');
content = content.replace(/if \(Array\.isArray\(extra\?\.company\?\.aliases\)\) extra\.company\.aliases\.forEach\(pushExtra\);\s*await applyMediaPreference\(\);/, "if (Array.isArray(extra?.company?.aliases)) extra.company.aliases.forEach(pushExtra);\n\n  await applyMediaPreference();");
fs.writeFileSync(path, content, 'utf8');
