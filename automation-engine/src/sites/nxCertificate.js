"use strict";

async function handleNxCertificate(siteLabel, page, emit, cert = {}, extra = {}) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const prefix = `[${siteLabel || 'CERT'}]`;
  const log = (level, msg) => emit && emit({ type: 'log', level, msg: `${prefix} ${msg}` });

  if (!page) {
    log('error', 'Playwright page handle missing');
    return { ok: false, error: 'Playwright page handle missing' };
  }

  const context = page.context?.();
  const knownPages = new Set(context ? context.pages() : [page]);


  const fastMode = extra?.fastMode === true;
  const pollDelay = fastMode ? 80 : 200;
  const mediaDelay = fastMode ? 80 : 150;
  const confirmDelay = fastMode ? 150 : 300;
  const identityDelay = fastMode ? 120 : 250;
  const passwordDelay = fastMode ? 100 : 200;
  const postCloseDelay = fastMode ? 250 : 500;
  const retryBaseDelay = fastMode ? 60 : 120;
  const retryStepDelay = fastMode ? 40 : 80;
  const selectionAttempts = fastMode ? 2 : 4;
  const defaultSelectors = [
    '#browser-guide-added-wrapper #nx-cert-select',
    '#nx-cert-select',
    '.nx-cert-select',
    '#browser-guide-added-wrapper'
  ];
  const selectors = [...(Array.isArray(extra?.selectors) ? extra.selectors : []), ...defaultSelectors];

  const rowSelectors = [
    ...(Array.isArray(extra?.rowSelectors) ? extra.rowSelectors : []),
    '#NXcertList tr',
    '.nx-cert-list tr',
    '.nx-cert-list li',
    '.cert-list tbody tr',
    '.cert-list tr',
    '.cert-list li',
    '.nx-cert-row',
    '.cert-row',
    '.cert-item',
    'li[data-cert-index]',
    'li[data-idx]',
    '[data-cert-index]',
    '[data-row-index]',
    '[role="row"]'
  ];
  const pinSelectors = [
    ...(Array.isArray(extra?.pinSelectors) ? extra.pinSelectors : []),
    '#certPwd',
    'input#certPwd',
    'input[name="certPwd"]',
    '#nx_cert_pin',
    'input[name="nx_cert_pin"]',
    'input[type="password"]'
  ];
  const confirmSelectors = [

    ...(Array.isArray(extra?.confirmSelectors) ? extra.confirmSelectors : []),
    '#nx-cert-select button.btn-ok',
    '#browser-guide-added-wrapper button.btn-ok',
    '.pki-bottom button.btn-ok',
    'button:has-text("확인")'
  ];

  let scopeCandidates = [];

  const registerScopeCandidate = (candidate) => {
    if (!candidate) return;
    if (!scopeCandidates.includes(candidate)) scopeCandidates.push(candidate);
  };

  const prioritizeScope = (candidate) => {
    if (!candidate) return;
    const unique = [];
    const seen = new Set();
    const push = (ctx) => {
      if (!ctx || seen.has(ctx)) return;
      seen.add(ctx);
      unique.push(ctx);
    };
    push(candidate);
    for (const ctx of scopeCandidates) push(ctx);
    scopeCandidates = unique;
  };


  const timeoutMs = Number(extra?.timeoutMs) || 20000;
  const start = Date.now();

  async function locateModal() {
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
      await sleep(pollDelay);
    }
    return null;
  }

  const located = await locateModal();
  if (!located) {
    log('error', 'Certificate modal not detected within timeout');
    return { ok: false, error: 'Certificate modal not detected' };
  }

  const certPage = located.certPage;
  let scope = located.scope;

  const enqueueFrameCandidates = (ctx) => {
    if (!ctx) return;
    try {
      if (typeof ctx.frames === 'function') {
        const frames = ctx.frames();
        if (Array.isArray(frames)) {
          for (const fr of frames) registerScopeCandidate(fr);
        }
      }
    } catch {}
    try {
      if (typeof ctx.childFrames === 'function') {
        const frames = ctx.childFrames();
        if (Array.isArray(frames)) {
          for (const fr of frames) registerScopeCandidate(fr);
        }
      }
    } catch {}
  };

  registerScopeCandidate(scope);
  registerScopeCandidate(certPage);
  enqueueFrameCandidates(certPage);
  enqueueFrameCandidates(scope);
  try {
    const parent = typeof scope?.parentFrame === 'function' ? scope.parentFrame() : null;
    if (parent) registerScopeCandidate(parent);
  } catch {}
  prioritizeScope(scope);

  log('info', `Certificate modal located (url=${certPage.url?.() || ''})`);

  const preferSubject = String(cert.subjectMatch || cert.subject || extra?.subject || extra?.company?.name || '').trim();
  const preferIssuer = String(cert.issuerMatch || cert.provider || '').trim();
  const preferSerial = String(cert.serialMatch || cert.serial || '').trim();
  const pinValue = String(cert.pin || cert.password || '').trim();

  async function applyMediaPreference(contexts) {
    const raw = String(cert.media || cert.storage || '').trim();
    if (!raw) return false;
    const normalized = raw.toLowerCase();
    const tags = [normalized];
    if (/usb|move|remov/.test(normalized)) tags.push('usb');
    if (/hdd|hard|disk|pc|local/.test(normalized)) tags.push('hdd');
    if (/browser|web/.test(normalized)) tags.push('browser');
    if (/file|pfx|p12|finder/.test(normalized)) tags.push('fcert');
    if (/token|hsm|bio/.test(normalized)) tags.push('hsm');
    const candidates = Array.isArray(contexts) ? contexts.filter(Boolean) : [contexts].filter(Boolean);
    if (!candidates.length) return false;
    for (const ctx of candidates) {
      let clicked = false;
      try {
        clicked = await ctx.evaluate((prefs) => {
          const norm = (s) => (s || '').toLowerCase();
          const buttons = Array.from(document.querySelectorAll('#cert-location-area-select-media button, #cert-location-area-targetMedia button, #cert-location-area button'));
          for (const btn of buttons) {
            const id = norm(btn.id);
            const text = norm(btn.textContent || '');
            const title = norm(btn.getAttribute('title') || '');
            const dataset = norm(btn.getAttribute('onclick') || '');
            for (const pref of prefs) {
              if (!pref) continue;
              if (id.includes(pref) || text.includes(pref) || title.includes(pref) || dataset.includes(pref)) {
                btn.click();
                btn.classList?.add('active');
                return true;
              }
            }
          }
          return false;
        }, tags).catch(() => false);
      } catch {}
      if (clicked) {
        scope = ctx;
        prioritizeScope(ctx);
        log('info', `Media preference applied (${raw})`);
        await sleep(mediaDelay);
        return true;
      }
    }
    log('warn', `Requested media '${raw}' not found; defaulting to active media`);
    return false;
  }



  await applyMediaPreference(scopeCandidates);

  const probeSelectors = rowSelectors.filter(Boolean);
  for (const ctx of scopeCandidates) {
    let hasRows = false;
    try {
      hasRows = await ctx.evaluate((sels) => {
        if (!Array.isArray(sels)) return false;
        for (const sel of sels) {
          if (!sel) continue;
          try {
            if (document.querySelector(sel)) return true;
          } catch {}
        }
        return false;
      }, probeSelectors).catch(() => false);
    } catch {}
    if (hasRows) {
      scope = ctx;
      prioritizeScope(ctx);
      break;
    }
  }


  const preferBizNo = String(extra?.company?.bizNo || cert.bizNo || '').replace(/[^0-9]/g, '');

  const selectionPrefs = {
    subject: preferSubject,
    issuer: preferIssuer,
    serial: preferSerial,
    bizNo: preferBizNo,
    rowSelectors
  };

  const attemptSelection = async (ctx) => ctx.evaluate((prefs) => {
    const normalizeCorporateMarks = (s) => (s || '')
      .replace(/㈜/g, '')
      .replace(/\(주\)/gi, '')
      .replace(/주식회사/gi, '')
      .replace(/유한회사/gi, '')
      .replace(/co\.?,?ltd/gi, '')
      .replace(/limited/gi, '')
      .replace(/corp\.?/gi, '');
    const norm = (s) => normalizeCorporateMarks(s)
      .toLowerCase()
      .replace(/[\s\u00a0\-_/()\[\]]/g, '');
    const onlyDigits = (s) => (s || '').replace(/[^0-9]/g, '');
    const wantSubject = norm(prefs.subject);
    const wantIssuer = norm(prefs.issuer);
    const wantSerial = norm(prefs.serial);
    const wantBiz = onlyDigits(prefs.bizNo);
    const selectors = (Array.isArray(prefs.rowSelectors) && prefs.rowSelectors.length)
      ? prefs.rowSelectors
      : ['#NXcertList tr', '.nx-cert-list tr', '.nx-cert-list li', '.cert-list tbody tr', '.cert-list tr', '.cert-list li', '.nx-cert-row', '.cert-row', '.cert-item', '[role="row"]'];
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
      const rowDigits = onlyDigits(text);
      if (wantSerial && ntext.includes(wantSerial)) score += 500;
      if (wantSubject && ntext.includes(wantSubject)) score += 220;
      if (wantIssuer && ntext.includes(wantIssuer)) score += 80;
      if (wantBiz && rowDigits.includes(wantBiz)) score += 400;
      if (!wantSerial && !wantSubject && !wantIssuer && !wantBiz) {
        score += Math.max(0, rows.length - idx);
      }
      if (score > bestScore) {
        bestScore = score;
        bestIdx = idx;
      }
    });
    if (bestScore <= 0 || bestIdx < 0) {
      return { ok: false, reason: 'no_match' };
    }
    const target = rows[bestIdx];
    if (!target) {
      return { ok: false, reason: 'no_target' };
    }
    target.scrollIntoView?.({ block: 'center' });
    target.click?.();
    target.focus?.();
    target.classList?.add('on');
    const cells = Array.from(target.querySelectorAll('td, th, div, span')).map((c) => (c.innerText || c.textContent || '').trim());
    return { ok: true, index: bestIdx, text: (target.innerText || '').trim(), cells };
  }, selectionPrefs).catch(() => null);

  let selection = null;
  let selectionScope = scope;
  const maxAttempts = selectionAttempts;
  for (const ctx of scopeCandidates) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      selection = await attemptSelection(ctx);
      if (selection?.ok) {
        selectionScope = ctx;
        break;
      }
      await sleep(retryBaseDelay + (attempt * retryStepDelay));
    }
    if (selection?.ok) break;
  }

  scope = selectionScope;

  if (!selection?.ok) {
    log('error', 'No certificate entries available for selection');
    return { ok: false, error: 'No certificate entries available' };
  }
  log('info', `Certificate row selected index=${selection.index}`);

  if (!pinValue) {
    log('error', 'Certificate PIN value is empty');
    return { ok: false, error: 'Certificate PIN not provided' };
  }

  let pinHandle = null;
  for (const sel of pinSelectors) {
    if (!sel) continue;
    try {
      pinHandle = await scope.$(sel);
      if (pinHandle) break;
    } catch {}
  }
  if (!pinHandle) {
    log('error', 'Failed to locate certificate PIN input');
    return { ok: false, error: 'Certificate PIN input not found' };
  }

  try { await pinHandle.fill(''); } catch {}
  await pinHandle.type(pinValue, { delay: 40 }).catch(async () => { try { await pinHandle.fill(pinValue); } catch {} });
  await scope.evaluate((el, val) => {
    if (el) {
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, pinHandle, pinValue).catch(() => {});

  let confirmHandle = null;
  for (const sel of confirmSelectors) {
    if (!sel) continue;
    try {
      confirmHandle = await scope.$(sel);
      if (confirmHandle) break;
    } catch {}
  }
  if (!confirmHandle) {
    log('error', 'Confirm button not found in certificate modal');
    return { ok: false, error: 'Certificate confirm button not found' };
  }

  const closePromise = certPage.waitForEvent('close', { timeout: Number(extra?.closeTimeoutMs) || 15000 }).catch(() => null);
  let confirmTriggered = false;

  if (pinHandle) {
    try {
      await pinHandle.focus();
      await pinHandle.press('Enter');
      confirmTriggered = true;
      log('info', 'Submitted PIN by pressing Enter');
    } catch {}
  }

  if (!confirmTriggered && certPage?.keyboard) {
    try {
      await certPage.keyboard.press('Enter');
      confirmTriggered = true;
      log('info', 'Submitted via page Enter key');
    } catch {}
  }

  if (!confirmTriggered) {
    try { await confirmHandle.focus(); } catch {}
    try {
      await confirmHandle.click({ delay: 40 });
      confirmTriggered = true;
      log('info', 'Confirm button clicked');
    } catch {}
  }

  if (!confirmTriggered) {
    const forced = await scope.evaluate(() => {
      const okSelector = '#nx-cert-select button.btn-ok, #browser-guide-added-wrapper button.btn-ok, .pki-bottom button.btn-ok';
      let okBtn = document.querySelector(okSelector);
      if (!okBtn) {
        okBtn = Array.from(document.querySelectorAll('#nx-cert-select button, .nx-cert-select button, button')).find((btn) => {
          const lbl = (btn.innerText || btn.textContent || '').trim();
          return lbl.includes('확인');
        });
      }
      if (okBtn) {
        okBtn.click();
        okBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        okBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        return true;
      }
      if (window.NX_Issue_pubUi?.selectCertConfirm) {
        try { window.NX_Issue_pubUi.selectCertConfirm(); return true; } catch (e) {}
      }
      return false;
    }).catch(() => false);
    if (forced) {
      confirmTriggered = true;
      log('info', 'Confirm triggered via DOM evaluation fallback');
    }
  }

  if (!confirmTriggered) {
    log('warn', 'Confirm trigger attempt failed; modal may remain open');
  }

  await sleep(confirmDelay);

  const identityValue = String(cert.identity || extra?.identity || extra?.company?.bizNo || '').replace(/[^0-9a-z]/gi, '');
  const identityHandled = await scope.evaluate((val) => {
    const panel = document.querySelector('#nx-cert-VerifyIdentify');
    if (!panel) return false;
    const style = window.getComputedStyle(panel);
    if (style.display === 'none' || panel.offsetWidth === 0 || panel.offsetHeight === 0) return false;
    const input = panel.querySelector('input');
    if (input && val) {
      input.value = val;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const btn = panel.querySelector('button.btn-ok') || panel.querySelector('button');
    if (btn) btn.click();
    return !!val;
  }, identityValue).catch(() => false);
  if (identityHandled) {
    log('info', 'Identity verification number submitted');
    await sleep(identityDelay);
  } else if (identityValue) {
    log('debug', 'Identity verification panel not detected');
  }

  const pwPanelHandled = await scope.evaluate(() => {
    const panel = document.querySelector('#nx-cert-checkPassword');
    if (!panel) return false;
    const style = window.getComputedStyle(panel);
    if (style.display === 'none' || panel.offsetWidth === 0 || panel.offsetHeight === 0) return false;
    const btn = panel.querySelector('button.btn-ok') || panel.querySelector('button');
    if (btn) btn.click();
    return true;
  }).catch(() => false);
  if (pwPanelHandled) {
    log('info', 'Certificate password confirmation acknowledged');
    await sleep(passwordDelay);
  }

  let closed = false;
  try {
    const evt = await closePromise;
    closed = !!evt;
  } catch {}

  if (!closed) {
    const hidden = await scope.evaluate(() => {
      const modal = document.querySelector('#nx-cert-select, .nx-cert-select');
      if (!modal) return true;
      const style = window.getComputedStyle(modal);
      if (style.display === 'none' || modal.offsetWidth === 0 || modal.offsetHeight === 0) return true;
      return false;
    }).catch(() => false);
    if (!hidden) {
      const errorText = await scope.evaluate(() => {
        const err = document.querySelector('#nx-issue-fail-alert, #nx-error-cert-update, .pki-wrap5, .error, .nx-error, .cert-error-msg');
        if (!err) return '';
        return (err.innerText || err.textContent || '').trim();
      }).catch(() => '');
      if (errorText) {
        log('error', `Certificate confirm failed: ${errorText}`);
        return { ok: false, error: `Certificate confirm failed: ${errorText}` };
      }
      return { ok: false, error: 'Certificate dialog did not close after confirmation' };
    }
  }

  await sleep(postCloseDelay);
  let nextPage = null;
  if (context) {
    const alive = context.pages().filter((p) => !p.isClosed());
    for (const candidate of alive) {
      if (candidate === certPage) continue;
      nextPage = candidate;
      break;
    }
    if (!nextPage) {
      for (const candidate of knownPages) {
        if (!candidate.isClosed()) {
          nextPage = candidate;
          break;
        }
      }
    }
    if (!nextPage && alive.length) {
      nextPage = alive[0];
    }
  }
  if (!nextPage) nextPage = page;
  try { await nextPage.waitForLoadState('domcontentloaded', { timeout: 10000 }); } catch {}
  log('info', 'Certificate dialog completed successfully');
  return { ok: true, page: nextPage, certPageClosed: closed };
}

module.exports = { handleNxCertificate };
