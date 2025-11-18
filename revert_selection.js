const fs = require('fs');
const path = 'automation-engine/src/sites/nxCertificate.js';
let content = fs.readFileSync(path, 'utf8');
const markerStart = "const preferSubject =";
const markerEnd = "let pinHandle = null;";
const startIdx = content.indexOf(markerStart);
const endIdx = content.indexOf(markerEnd);
if (startIdx === -1 || endIdx === -1) {
  throw new Error('Markers not found for revert block');
}
const before = content.slice(0, startIdx);
const after = content.slice(endIdx);
const newBlock = `const preferSubject = String(cert.subjectMatch || cert.subject || extra?.subject || extra?.company?.name || '').trim();
  const preferIssuer = String(cert.issuerMatch || cert.provider || '').trim();
  const preferSerial = String(cert.serialMatch || cert.serial || '').trim();

  await applyMediaPreference();

  const selection = await scope.evaluate((prefs) => {
    const norm = (s) => (s || '').toLowerCase().replace(/[\\s\\u00a0\-_/()\[\]]/g, '');
    const wantSubject = norm(prefs.subject);
    const wantIssuer = norm(prefs.issuer);
    const wantSerial = norm(prefs.serial);

    const selectors = (prefs.rowSelectors && prefs.rowSelectors.length)
      ? prefs.rowSelectors
      : ['#NXcertList tr', '.nx-cert-list tr', '.cert-list tbody tr', '.cert-list tr'];

    const rows = [];
    const seen = new Set();
    for (const sel of selectors) {
      if (!sel) continue;
      try {
        const found = Array.from(document.querySelectorAll(sel));
        for (const row of found) {
          if (!seen.has(row)) {
            seen.add(row);
            rows.push(row);
          }
        }
      } catch {}
    }

    if (!rows.length) {
      const fallback = Array.from(document.querySelectorAll('table tr'));
      for (const row of fallback) {
        if (!seen.has(row)) {
          seen.add(row);
          rows.push(row);
        }
      }
    }

    if (!rows.length) {
      return { ok: false, reason: 'no_rows' };
    }

    let bestIdx = -1;
    let bestScore = -Infinity;
    rows.forEach((row, idx) => {
      const text = row.innerText || row.textContent || '';
      const ntext = norm(text);
      let score = 0;
      if (wantSerial && ntext.includes(wantSerial)) score += 500;
      if (wantSubject && ntext.includes(wantSubject)) score += 220;
      if (wantIssuer && ntext.includes(wantIssuer)) score += 80;
      if (!wantSerial && !wantSubject && !wantIssuer) score += Math.max(0, rows.length - idx);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = idx;
      }
    });

    if (bestIdx < 0) bestIdx = 0;
    const target = rows[bestIdx];
    if (!target) {
      return { ok: false, reason: 'no_target' };
    }
    target.scrollIntoView?.({ block: 'center' });
    target.click?.();
    target.focus?.();
    target.classList?.add('on');
    const cells = Array.from(target.querySelectorAll('td, th')).map((c) => (c.innerText || c.textContent || '').trim());
    return { ok: true, index: bestIdx, text: (target.innerText || '').trim(), cells };
  }, {
    subject: preferSubject,
    issuer: preferIssuer,
    serial: preferSerial,
    rowSelectors
  }).catch(() => null);

`;
content = before + newBlock + after;
fs.writeFileSync(path, content, 'utf8');
