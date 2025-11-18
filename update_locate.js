const fs = require('fs');
const path = 'automation-engine/src/sites/nxCertificate.js';
let content = fs.readFileSync(path, 'utf8');
const start = content.indexOf('async function locateModal()');
const end = content.indexOf('async function applyMediaPreference', start);
if (start === -1 || end === -1) {
  throw new Error('locateModal block not found');
}
const newBlock = `async function locateModal() {
    const reopenIntervalMs = 1500;
    let lastReopenTs = 0;
    let reopenAttempts = 0;
    while (Date.now() - start < timeoutMs) {
      const pages = context ? context.pages() : [page];
      for (const current of pages) {
        const scopes = [current, ...(current.frames?.() || [])];
        for (const scope of scopes) {
          for (const sel of selectors) {
            if (!sel) continue;
            try {
              const handle = await scope.$(sel);
              if (handle) {
                return { certPage: current, scope };
              }
            } catch {}
          }
        }
      }
      const now = Date.now();
      if (now - lastReopenTs > reopenIntervalMs && reopenAttempts < 3) {
        lastReopenTs = now;
        reopenAttempts += 1;
        try {
          await page.evaluate(() => {
            const tryInvokeApi = () => {
              const api = window.NX_Issue_pubUi || window.NX_Issue_pubUi_360 || window.NX_Issue_pubUi64;
              if (!api) return false;
              const candidates = ['selectCertShow', 'openCertDialog', 'showCertWindow', 'open'];
              for (const name of candidates) {
                const fn = api[name];
                if (typeof fn === 'function') {
                  try {
                    fn.call(api);
                    return true;
                  } catch (err) {}
                }
              }
              if (typeof api.selectCert === 'function') {
                try {
                  api.selectCert();
                  return true;
                } catch (err) {}
              }
              if (typeof api.openCertificate === 'function') {
                try {
                  api.openCertificate();
                  return true;
                } catch (err) {}
              }
              return false;
            };
            const tryClickButton = () => {
              const nodes = Array.from(document.querySelectorAll('button, a, div, span'));
              for (const el of nodes) {
                const rawText = (el.innerText || el.textContent || '');
                const compact = rawText.replace(/\s+/g, '');
                if (!compact) continue;
                if (/\uACF5\uB3D9\uC778\uC99D|\uC778\uC99D\uC11C\uC120\uD0DD|\uC778\uC99D\uC11C\uB85C\uADF8\uC778/.test(compact)) {
                  try {
                    el.click();
                    return true;
                  } catch (err) {}
                }
              }
              return false;
            };
            if (!tryInvokeApi()) {
              tryClickButton();
            }
          });
          log('debug', '[' + (siteLabel || 'CERT') + '] triggered certificate dialog attempt ' + reopenAttempts);
        } catch (err) {
          const msg = (err && err.message) ? err.message : String(err);
          log('debug', '[' + (siteLabel || 'CERT') + '] certificate trigger attempt failed: ' + msg);
        }
      }
      await sleep(200);
    }
    return null;
  }

`;
content = content.slice(0, start) + newBlock + content.slice(end);
fs.writeFileSync(path, content, 'utf8');
