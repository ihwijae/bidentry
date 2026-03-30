"use strict"

const fs = require('fs');
const path = require('path');
const { handleNxCertificate } = require('./nxCertificate');
const { debugDumpsEnabled } = require('../util/debug');

const KEPCO_POPUP_URL_PATTERNS = [/\/popup\//i, /NoticeFishingPopup/i, /Kepco.*Popup/i];

async function dumpKepcoHtml(page, emit, tag){
  if (!debugDumpsEnabled()) return;
  if (!page) return;
  try {
    const html = await page.content();
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    const dir = path.join(process.cwd(), 'engine_runs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${stamp}_${tag || 'kepco'}.html`);
    fs.writeFileSync(file, html, 'utf-8');
    emit && emit({ type:'log', level:'info', msg:`[KEPCO] HTML dump saved: ${file}` });
  } catch (err) {
    emit && emit({ type:'log', level:'warn', msg:`[KEPCO] HTML dump failed: ${(err && err.message) || err}` });
  }
}
async function loginKepco(page, emit, auth = {}, options = {}) {
  const asMs = (val, fallback) => {
    const n = Number(val);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const timing = {
    popupWaitMs: asMs(options?.kepcoPopupWaitMs, 220),
    resolveLoginTargetMs: asMs(options?.kepcoResolveLoginTargetMs, 1800),
    loginLinkTimeoutMs: asMs(options?.kepcoLoginLinkTimeoutMs, 2200),
    loginLinkRetryTimeoutMs: asMs(options?.kepcoLoginLinkRetryTimeoutMs, 1600),
    loginLinkPollMs: asMs(options?.kepcoLoginLinkPollMs, 80),
    postReloadDelayMs: asMs(options?.kepcoPostReloadDelayMs, 120),
    modalScopeTimeoutMs: asMs(options?.kepcoModalScopeTimeoutMs, 1200),
    modalScopePollMs: asMs(options?.kepcoModalScopePollMs, 60),
    directFieldTimeoutMs: asMs(options?.kepcoDirectFieldTimeoutMs, 220),
    locateFieldsTimeoutMs: asMs(options?.kepcoLocateFieldsTimeoutMs, 900),
    locateFieldsRetryTimeoutMs: asMs(options?.kepcoLocateFieldsRetryTimeoutMs, 650),
    locateFieldsPollMs: asMs(options?.kepcoLocateFieldsPollMs, 40),
    locateRetryDelayMs: asMs(options?.kepcoLocateRetryDelayMs, 70),
    loginNavTimeoutMs: asMs(options?.kepcoLoginNavTimeoutMs, 4500),
    postSubmitMaxWaitMs: asMs(options?.kepcoPostSubmitMaxWaitMs, 1200)
  };
  const timingLogEnabled = options?.kepcoTimingLog !== false;
  const tsStart = Date.now();
  const mark = (label, extra = '') => {
    if (!timingLogEnabled) return;
    const now = Date.now();
    const suffix = extra ? ` | ${extra}` : '';
    emit && emit({
      type: 'log',
      level: 'info',
      msg: `[KEPCO][TS] ${new Date(now).toISOString()} +${now - tsStart}ms ${label}${suffix}`
    });
  };
  mark('loginKepco:start');
  // Query across all frames (main first)
  async function $(selector) {
    const inMain = await page.$(selector);
    if (inMain) return inMain;
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      try {
        const el = await f.$(selector);
        if (el) return el;
      } catch {}
    }
    return null;
  }

  async function clickWithPopup(targetPage, candidates) {
    let trigger = null;
    for (const sel of candidates) {
      try {
        const el = await targetPage.$(sel).catch(() => null);
        if (el) { trigger = { el, sel }; break; }
      } catch {}
    }
    if (!trigger) {
      try {
        const locator = targetPage.getByRole?.('link', { name: /\uB85C\uADF8\uC778/i });
        if (locator && await locator.count().catch(()=>0)) {
          const el = await locator.first().elementHandle().catch(()=>null);
          if (el) trigger = { el, sel: 'role=link[name=????????' };
        }
      } catch {}
    }
    if (!trigger) return null;

    emit && emit({ type: 'log', level: 'info', msg: `[KEPCO] ????????????? ${trigger.sel}` });
    const popupPromise = targetPage.waitForEvent('popup', { timeout: timing.popupWaitMs }).catch(() => null);
    try { await trigger.el.click(); }
    catch { try { await trigger.el.click({ force: true }); } catch {} }

    const popup = await popupPromise;
    if (!popup) return null;
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    const title = (await popup.title().catch(()=>'')) || '';
    const url = popup.url?.() || '';
    if (/\uACF5\uC9C0|\uC548\uB0B4|\uC774\uBCA4\uD2B8/i.test(title) || /popup/i.test(url) || popup.isClosed()) {
      try { if (!popup.isClosed()) await popup.close({ runBeforeUnload:true }); } catch {}
      return null;
    }
    return popup;
  }

  const visibleLoginFieldPairs = [
    ['#username', '#password'],
    ['form#loginFrm #username', 'form#loginFrm #password'],
    ['div.formBox #username', 'div.formBox #password'],
    ['input[name="username" i]', 'input[name="password" i]']
  ];

  const isVisibleHandle = async (handle) => {
    if (!handle) return false;
    try {
      return await handle.evaluate((el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        if (el.disabled) return false;
        return true;
      });
    } catch {}
    return false;
  };

  const hasVisibleLoginFields = async (ctx) => {
    if (!ctx || typeof ctx.$ !== 'function') return false;
    for (const [idSel, pwSel] of visibleLoginFieldPairs) {
      try {
        const idEl = await ctx.$(idSel);
        if (!idEl) continue;
        const pwEl = await ctx.$(pwSel);
        if (!pwEl) continue;
        if (await isVisibleHandle(idEl) && await isVisibleHandle(pwEl)) return true;
      } catch {}
    }
    return false;
  };

  const collectCandidatePages = (primaryPage, popupPage) => {
    const out = [];
    const seen = new Set();
    const push = (pg) => {
      if (!pg || seen.has(pg) || pg.isClosed?.()) return;
      seen.add(pg);
      out.push(pg);
    };
    push(popupPage);
    push(primaryPage);
    try {
      const ctxObj = typeof primaryPage?.context === 'function' ? primaryPage.context() : null;
      for (const pg of ctxObj?.pages?.() || []) push(pg);
    } catch {}
    return out;
  };

  const resolveLoginPage = async (primaryPage, popupPage, timeoutMs = timing.resolveLoginTargetMs) => {
    const deadline = Date.now() + timeoutMs;
    const fallback = popupPage && !popupPage.isClosed?.() ? popupPage : primaryPage;
    while (Date.now() < deadline) {
      const pages = collectCandidatePages(primaryPage, popupPage);
      for (const pg of pages) {
        try { await pg.waitForLoadState('domcontentloaded', { timeout: 300 }).catch(()=>{}); } catch {}
      }
      for (const pg of pages) {
        if (await hasVisibleLoginFields(pg)) return pg;
        try {
          for (const fr of pg.frames?.() || []) {
            if (await hasVisibleLoginFields(fr)) return pg;
          }
        } catch {}
      }
      await primaryPage.waitForTimeout(80).catch(()=>{});
    }
    return fallback;
  };
  try {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await dumpKepcoHtml(page, emit, 'kepco_home_initial');
    mark('home:domcontentloaded');
  } catch {}

  const loginLinkCandidates = [
    '#button-1022-btnInnerEl',
    'span.x-btn-inner:has-text("\uB85C\uADF8\uC778")',
    'header a:has-text("\uB85C\uADF8\uC778")',
    'nav a:has-text("\uB85C\uADF8\uC778")',
    '.util a:has-text("\uB85C\uADF8\uC778")',
    'a:has-text("\uB85C\uADF8\uC778")',
    'a[href*="login" i]',
    'xpath=//a[contains(normalize-space(.),"\uB85C\uADF8\uC778")]'
  ];

  const waitForLoginLink = async (timeoutMs = timing.loginLinkTimeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const sel of loginLinkCandidates) {
        try {
          const el = await page.$(sel);
          if (el) return true;
        } catch {}
      }
      await page.waitForTimeout(timing.loginLinkPollMs).catch(() => {});
    }
    return false;
  };

  mark('loginLink:wait:start', `timeout=${timing.loginLinkTimeoutMs}`);
  let loginLinkReady = await waitForLoginLink();
  mark('loginLink:wait:end', `found=${loginLinkReady}`);
  if (!loginLinkReady) {
    await dumpKepcoHtml(page, emit, 'kepco_login_link_missing_initial');
    emit && emit({ type: 'log', level: 'warn', msg: '[KEPCO] login link not found initially; reloading page and retrying' });
    try { await page.reload({ waitUntil: 'domcontentloaded' }); } catch {}
    await page.waitForTimeout(timing.postReloadDelayMs).catch(() => {});
    mark('loginLink:retry:start', `timeout=${timing.loginLinkRetryTimeoutMs}`);
    loginLinkReady = await waitForLoginLink(timing.loginLinkRetryTimeoutMs);
    mark('loginLink:retry:end', `found=${loginLinkReady}`);
  }
  if (!loginLinkReady) {
    await dumpKepcoHtml(page, emit, 'kepco_login_link_missing_retry');
    throw new Error('[KEPCO] Failed to locate login link');
  }

  // 1) Top navigation login link/button click
  mark('loginLink:click:start');
  const popup = await clickWithPopup(page, loginLinkCandidates);
  mark('loginLink:click:end', `popup=${!!popup}`);
  mark('loginPage:resolve:start', `timeout=${timing.resolveLoginTargetMs}`);
  let loginPage = await resolveLoginPage(page, popup, timing.resolveLoginTargetMs);
  const resolvedBy = loginPage === popup ? 'popup'
    : loginPage === page ? 'page'
    : 'context-page';
  mark('loginPage:resolve:end', `resolvedBy=${resolvedBy}`);
  // Ensure alert dialogs don't block automation
  try { loginPage.on('dialog', d => d.dismiss().catch(()=>{})); } catch {}
  await loginPage.waitForLoadState('domcontentloaded').catch(()=>{});
  mark('loginPage:domcontentloaded');

  const gatherContexts = () => {
    const ctxs = [];
    const seen = new Set();
    const basePages = [];
    if (loginPage) basePages.push(loginPage);
    try {
      const ctxObj = typeof loginPage?.context === 'function' ? loginPage.context() : null;
      const extraPages = ctxObj?.pages?.() || [];
      for (const pg of extraPages) basePages.push(pg);
    } catch {}
    for (const pg of basePages) {
      if (!pg || seen.has(pg) || pg.isClosed?.()) continue;
      seen.add(pg);
      ctxs.push(pg);
      try {
        for (const fr of pg.frames?.() || []) {
          if (!fr || seen.has(fr)) continue;
          seen.add(fr);
          ctxs.push(fr);
        }
      } catch {}
    }
    return ctxs;
  };

  // 2) Login modal option selection
  if (auth.id && auth.pw) {
    try {
      // Modal container candidates (login modal variants)
      const containerSel = [
        'div:has(button:has-text("\uACF5\uB3D9\uC778\uC99D\uC11C \uB85C\uADF8\uC778"))',
        'div[role="dialog"]:has-text("\uB85C\uADF8\uC778")',
        'div.layer:has-text("\uB85C\uADF8\uC778")'
      ];
      let scope = loginPage;
      const resolveModalScope = async (timeoutMs = timing.modalScopeTimeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          for (const c of containerSel) {
            try {
              const found = await loginPage.$(c);
              if (found) return found;
            } catch {}
          }
          await loginPage.waitForTimeout(timing.modalScopePollMs).catch(()=>{});
        }
        return null;
      };
      mark('modalScope:resolve:start', `timeout=${timing.modalScopeTimeoutMs}`);
      const modalScope = await resolveModalScope();
      if (modalScope) scope = modalScope;
      mark('modalScope:resolve:end', `found=${!!modalScope}`);

      const loginFieldConfig = {
        id: {
          labels: [/\uC544\uC774\uB514/i],
          selectors: [
            'div.formBox #username',
            'div.formBox input#username',
            '#username',
            'form#loginFrm #username',
            'input[name="username" i]',
            'input[placeholder*="\uC544\uC774\uB514" i]',
            'input[title*="\uC544\uC774\uB514" i]',
            'input[name*="id" i]', 'input[id*="id" i]', 'input[name*="userid" i]',
            'input[type="text"]'
          ]
        },
        pw: {
          labels: [/\uBE44\uBC00\uBC88\uD638|\uBE44\uBC88/i],
          selectors: [
            'div.formBox #password',
            'div.formBox input#password',
            '#password',
            'form#loginFrm #password',
            'input[name="password" i]',
            'input[placeholder*="\uBE44\uBC00\uBC88\uD638" i]',
            'input[title*="\uBE44\uBC00\uBC88\uD638" i]',
            'input[type="password"]', 'input[name*="pw" i]', 'input[id*="pw" i]'
          ]
        }
      };

      const modalFastSelectors = {
        id: ['div.formBox #username', '#username'],
        pw: ['div.formBox #password', '#password']
      };
      const fastFieldPairs = [
        ['#username', '#password'],
        ['div.formBox #username', 'div.formBox #password'],
        ['form#loginFrm #username', 'form#loginFrm #password'],
        ['input[name="username" i]', 'input[name="password" i]']
      ];

      const tryDirectHandle = async (selectors = [], timeoutMs = timing.directFieldTimeoutMs) => {
        const targets = [];
        if (scope && typeof scope.$ === 'function') targets.push(scope);
        if (loginPage && typeof loginPage.$ === 'function' && loginPage !== scope) targets.push(loginPage);
        for (const sel of selectors) {
          for (const target of targets) {
            try {
              const handle = await target.waitForSelector(sel, { timeout: timeoutMs }).catch(() => null);
              if (handle && await isVisibleHandle(handle)) return handle;
            } catch {}
          }
        }
        return null;
      };

      const tryFastVisiblePair = async () => {
        const targetContexts = [];
        const seen = new Set();
        const push = (ctx) => {
          if (!ctx || seen.has(ctx) || typeof ctx.$ !== 'function') return;
          seen.add(ctx);
          targetContexts.push(ctx);
        };
        push(scope);
        push(loginPage);
        try {
          for (const fr of loginPage.frames?.() || []) push(fr);
        } catch {}

        for (const ctx of targetContexts) {
          for (const [idSel, pwSel] of fastFieldPairs) {
            let idEl = null;
            let pwEl = null;
            try { idEl = await ctx.$(idSel); } catch {}
            if (!idEl) continue;
            try { pwEl = await ctx.$(pwSel); } catch {}
            if (!pwEl) continue;
            if (await isVisibleHandle(idEl) && await isVisibleHandle(pwEl)) {
              return { id: idEl, pw: pwEl };
            }
          }
        }
        return null;
      };

      const queryInTargets = async (targets, selectors) => {
        for (const target of targets) {
          if (!target) continue;
          for (const sel of selectors) {
            try {
              const el = await target.$(sel);
              if (el) return el;
            } catch {}
          }
        }
        return null;
      };

      async function locateFields(timeoutMs = timing.locateFieldsTimeoutMs) {
        const deadline = Date.now() + timeoutMs;
        const located = { id: null, pw: null };
        const preferScopes = scope ? [scope] : [];

        const buildContexts = () => {
          const list = [];
          const seen = new Set();
          const push = (ctx) => { if (ctx && !seen.has(ctx)) { seen.add(ctx); list.push(ctx); } };
          preferScopes.forEach(push);
          gatherContexts().forEach(push);
          return list;
        };

        const searchSelectors = async (ctxs, selectors) => {
          for (const sel of selectors) {
            for (const ctx of ctxs) {
              try {
                const el = await ctx.$(sel);
                if (el && await isVisibleHandle(el)) return el;
              } catch {}
            }
          }
          return null;
        };

        const searchLabels = async (ctxs, labels) => {
          for (const ctx of ctxs) {
            if (!ctx?.getByLabel) continue;
            for (const lbl of labels) {
              try {
                const locator = ctx.getByLabel(lbl);
                if (locator && await locator.count().catch(()=>0)) {
                  const handle = await locator.first().elementHandle().catch(()=>null);
                  if (handle && await isVisibleHandle(handle)) return handle;
                }
              } catch {}
            }
          }
          return null;
        };

        while (Date.now() < deadline && (!located.id || !located.pw)) {
          const ctxs = buildContexts();
          for (const key of ['id','pw']) {
            if (located[key]) continue;
            const cfg = loginFieldConfig[key];
            located[key] = await searchSelectors(ctxs, cfg.selectors);
            if (!located[key]) {
              located[key] = await searchLabels(ctxs, cfg.labels);
            }
          }
          if (located.id && located.pw) break;
          await loginPage.waitForTimeout(timing.locateFieldsPollMs).catch(()=>{});
        }
        return located;
      }

      const acquireFields = async () => {
        const fastPair = await tryFastVisiblePair();
        if (fastPair?.id && fastPair?.pw) return { ...fastPair, source: 'fast-pair' };

        let idHandle = await tryDirectHandle(modalFastSelectors.id);
        let pwHandle = await tryDirectHandle(modalFastSelectors.pw);
        if (idHandle && pwHandle) return { id: idHandle, pw: pwHandle, source: 'direct-handle' };

        const located = await locateFields();
        idHandle ||= located.id;
        pwHandle ||= located.pw;
        if (idHandle && pwHandle) return { id: idHandle, pw: pwHandle, source: 'locate-fields' };

        emit && emit({ type:'log', level:'warn', msg:'[KEPCO] ID/PW ?????????????嶺????????????諛몃마嶺뚮?????????????硫λ젒?????????????(????????熬곣뫖利당춯??쎾퐲????????????????????????嫄??????????????' });
        try { await closeKepcoPostLoginModals(loginPage, emit, { abortOnCertModal: true }); } catch {}
        await loginPage.waitForTimeout(timing.locateRetryDelayMs).catch(()=>{});
        const retry = await locateFields(timing.locateFieldsRetryTimeoutMs);
        idHandle ||= retry.id;
        pwHandle ||= retry.pw;
        return { id: idHandle, pw: pwHandle, source: 'retry-locate' };
      };

      mark('fields:acquire:start');
      const { id: idField, pw: pwField, source: fieldSource } = await acquireFields();
      mark('fields:acquire:end', `source=${fieldSource || 'unknown'} found=${!!idField && !!pwField}`);

      const setInputValue = async (handle, value) => {
        if (!handle) return false;
        const text = String(value ?? '');
        try { await handle.click({ force: true }); } catch {}
        try { await handle.focus(); } catch {}
        const direct = await handle.evaluate((el, val) => {
          if (!el) return false;
          try { el.focus && el.focus(); } catch {}
          if (typeof el.value === 'string') {
            el.value = val;
          } else {
            el.setAttribute('value', val);
          }
          el.dispatchEvent?.(new Event('input', { bubbles: true }));
          el.dispatchEvent?.(new Event('change', { bubbles: true }));
          return String(el.value ?? '').trim() === String(val).trim();
        }, text).catch(() => false);
        if (direct) return true;
        try { await handle.fill(text); return true; } catch {}
        try { await handle.type(text, { delay: 2 }); return true; } catch {}
        return false;
      };

      if (!idField || !pwField) {
        emit && emit({ type:'log', level:'warn', msg:'[KEPCO] ID/PW input fields not found' });
        throw new Error('[KEPCO] \uB85C\uADF8\uC778 \uC785\uB825 \uD544\uB4DC \uD0D0\uC0C9 \uC2E4\uD328');
      }

      mark('fields:input:start');
      const idSet = await setInputValue(idField, auth.id);
      const pwSet = await setInputValue(pwField, auth.pw);
      mark('fields:input:end', `id=${idSet} pw=${pwSet}`);
      emit && emit({ type:'log', level:'info', msg:`[KEPCO] ID/PW input set (id=${idSet}, pw=${pwSet})` });
      const ensureHandlesFilled = async () => {
        const read = async (handle) => {
          if (!handle) return '';
          return (await handle.evaluate(el => (el && typeof el.value === 'string') ? el.value.trim() : '').catch(()=>'')).trim();
        };
        return { id: await read(idField), pw: await read(pwField) };
      };
      mark('fields:verify:start');
      let verified = await ensureHandlesFilled();
      if (!verified.id || !verified.pw) {
        emit && emit({ type:'log', level:'warn', msg:'[KEPCO] ID/PW values were not applied correctly' });
        await loginPage.evaluate((selectors, creds) => {
          const pick = (sels) => {
            for (const sel of sels || []) {
              const el = document.querySelector(sel);
              if (el) return el;
            }
            return null;
          };
          const idEl = pick(selectors.id);
          const pwEl = pick(selectors.pw);
          if (idEl) {
            idEl.value = creds.id;
            idEl.dispatchEvent(new Event('input', { bubbles:true }));
            idEl.dispatchEvent(new Event('change', { bubbles:true }));
          }
          if (pwEl) {
            pwEl.value = creds.pw;
            pwEl.dispatchEvent(new Event('input', { bubbles:true }));
            pwEl.dispatchEvent(new Event('change', { bubbles:true }));
          }
        }, loginFieldConfig, { id: String(auth.id), pw: String(auth.pw) }).catch(()=>{});
        verified = await ensureHandlesFilled();
        mark('fields:verify:fallback:end', `id=${!!verified.id} pw=${!!verified.pw}`);
      }
      if (!verified.id || !verified.pw) {
        emit && emit({ type:'log', level:'warn', msg:'[KEPCO] ID/PW values were not applied correctly' });
        throw new Error('[KEPCO] \uB85C\uADF8\uC778 \uC815\uBCF4\uB97C \uC785\uB825\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.');
      }

      mark('fields:verify:end', `id=${!!verified.id} pw=${!!verified.pw}`);
      const submitSel = [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("\uB85C\uADF8\uC778")'
      ];
      const waitAfterSubmit = async () => {
        const sleep = loginPage.waitForTimeout(timing.postSubmitMaxWaitMs).then(() => 'timeout').catch(() => 'timeout');
        const nav = loginPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: timing.loginNavTimeoutMs }).then(() => 'nav').catch(() => null);
        const popup = loginPage.waitForEvent('popup', { timeout: timing.postSubmitMaxWaitMs }).then(() => 'popup').catch(() => null);
        await Promise.race([sleep, nav, popup]).catch(() => {});
      };
      let submit = null;
      for (const s of submitSel) {
        const cand = await scope.$(s).catch(() => null);
        if (!cand) continue;
        const txt = (await cand.textContent().catch(()=>'')) || '';
        if (/\uACF5\uB3D9|\uD734\uB300/.test(txt)) continue;
        submit = cand; break;
      }
      if (submit) {
        mark('submit:click:start');
        await submit.click().catch(()=>{});
        await waitAfterSubmit();
        mark('submit:click:end');
      } else {
        mark('submit:enter:start');
        try { await pwField.focus(); await pwField.press('Enter'); } catch {}
        await waitAfterSubmit();
        mark('submit:enter:end');
      }
      emit && emit({ type:'log', level:'info', msg:'[KEPCO] ID/PW \uB85C\uADF8\uC778 \uC2DC\uB3C4 \uC644\uB8CC' });
      mark('loginKepco:done');
      return popup || null;
    } catch {}
  }
  // If we reach here without handling ID/PW, do not block on cert; continue to cert trigger
  
  // \uACF5\uB3D9\uC778\uC99D\uC11C \uB85C\uADF8\uC778 \uD2B8\uB9AC\uAC70
  const certCandidates = [
    'text=/\uACF5\uB3D9.?\uC778\uC99D(\uC11C)?\s*\uB85C\uADF8\uC778/i',
    'text=/\uC778\uC99D\uC11C\s*\uB85C\uADF8\uC778/i',
    'button:has-text("\uACF5\uB3D9\uC778\uC99D")',
    'button:has-text("\uC778\uC99D\uC11C")',
    'a:has-text("\uC778\uC99D\uC11C \uB85C\uADF8\uC778")'
  ];
  const certPopup = await clickWithPopup(loginPage, certCandidates);
  return certPopup || popup || null;
}


async function handleKepcoCertificate(page, emit, cert = {}, extra = {}) {
  const result = await handleNxCertificate('KEPCO', page, emit, cert, extra);
  if (result?.ok) {
    const targetPage = result.page || page;
    try { await closeExtraKepcoWindows(targetPage, emit); } catch {}
  }
  return result;
}
async function closeKepcoPostLoginModals(page, emit, options = {}){
  const selectors = [
    '.x-tool-close',
    '.x-window .x-tool-close',
    'button:has-text("\uB2EB\uAE30")',
    'a:has-text("\uB2EB\uAE30")',
    'input[type="button"][value*="\uB2EB\uAE30" i]',
    'button:has-text("\uD655\uC778")',
    'a:has-text("\uD655\uC778")',
    '.popup-close',
    '.btn-close',
    'span[onclick*="close"]',
    'a[onclick*="close" i]',
    'img[onclick*="close" i]',
    'button.btn-popup-close',
    '#btnClose',
    '.btn-popup-close',
    '#reopenCheck ~ button',
    'div.auclose ~ div button',
    'div.auclose ~ div a[onclick*="close" i]',
    'button:has([onclick*="popupClose"])'
  ];
  const conservativeSelectors = [
    '.popup-close',
    '.btn-close',
    'span[onclick*="close"]',
    'a[onclick*="close" i]',
    'img[onclick*="close" i]',
    'button.btn-popup-close',
    '#btnClose',
    '.btn-popup-close',
    '#reopenCheck ~ button',
    'div.auclose ~ div button',
    'div.auclose ~ div a[onclick*="close" i]',
    'button:has([onclick*="popupClose"])'
  ];

  const popupPagePatterns = KEPCO_POPUP_URL_PATTERNS;
  const handledElements = new WeakSet();
  async function forceClosePopupPage(ctx){
    if (!ctx || typeof ctx.close !== 'function') return false;
    const url = (typeof ctx.url === 'function' ? ctx.url() : '') || '';
    let hit = popupPagePatterns.some(rx => rx.test(url));
    if (!hit && typeof ctx.title === 'function') {
      try {
        const title = await ctx.title();
        hit = popupPagePatterns.some(rx => rx.test(title));
      } catch {}
    }
    if (!hit) return false;
    try {
      await ctx.close({ runBeforeUnload: true });
      emit && emit({ type:'log', level:'info', msg:`[KEPCO] popup window force-closed: ${url}` });
      return true;
    } catch {}
    return false;
  }

  const abortOnCertModal = options.abortOnCertModal === true;
  const protectWorkflowModal = options.protectWorkflowModal === true;
  const activeSelectors = protectWorkflowModal ? conservativeSelectors : selectors;
  const certSelectors = ['#nx-cert-select', '.nx-cert-select', '#browser-guide-added-wrapper', '#nx-cert-select-wrap'];
  const shouldPreserveWorkflowModal = async (elHandle) => {
    if (!protectWorkflowModal || !elHandle) return false;
    try {
      return await elHandle.evaluate((node) => {
        const root = node?.closest?.('.x-window, .x-panel, .x-message-box') || node?.parentElement;
        if (!root) return false;
        const text = String(root.textContent || '').replace(/\s+/g, '');
        const hasFlowCheckbox = !!root.querySelector('input[type="checkbox"], input[role="checkbox"], input.x-form-checkbox, .x-form-cb-wrap input');
        if (/\uC785\uCC30\uCC38\uAC00\uC2E0\uCCAD|\uC704\uC758\uC0AC\uD56D|\uD655\uC778\uD558\uC600\uC2B5\uB2C8\uB2E4|\uB3D9\uC758\uC0AC\uD56D|\uC785\uCC30\uB2F4\uD569\uC720\uC758\uC0AC\uD56D/.test(text) && hasFlowCheckbox) return true;
        if (/\uC81C\uCD9C/.test(text)) return true;
        return false;
      });
    } catch {}
    return false;
  };

  const contexts = () => {
    const ctxs = [];
    const seenPages = new Set();
    const basePages = [];
    if (page) basePages.push(page);
    try {
      const ctxObj = typeof page?.context === 'function' ? page.context() : null;
      const extraPages = ctxObj?.pages?.() || [];
      for (const pg of extraPages) basePages.push(pg);
    } catch {}
    for (const pg of basePages) {
      if (!pg || seenPages.has(pg) || pg.isClosed?.()) continue;
      seenPages.add(pg);
      ctxs.push(pg);
      try {
        for (const fr of pg.frames?.() || []) ctxs.push(fr);
      } catch {}
    }
    return ctxs;
  };

  const hasCertificateModal = async () => {
    if (!abortOnCertModal) return false;
    for (const ctx of contexts()) {
      for (const sel of certSelectors) {
        try {
          const modal = await ctx.$(sel);
          if (modal) return true;
        } catch {}
      }
    }
    return false;
  };

  const checkSelectors = [
    'label:has-text("\uC624\uB298 \uD558\uB8E8 \uC774 \uCC3D \uC5F4\uC9C0 \uC54A\uAE30")',
    'label:has-text("\uD558\uB8E8 \uB3D9\uC548 \uBCF4\uC9C0 \uC54A\uAE30")',
    '.auclose input[type="checkbox"]',
    'input[type="checkbox"][name*="today" i]',
    'input[type="checkbox"][id*="today" i]',
    '#todayCheck',
    '#reopenCheck'
  ];

  const maxAttempts = protectWorkflowModal ? 2 : 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let closed = false;
    if (await hasCertificateModal()) {
      emit && emit({ type:'log', level:'debug', msg:'[KEPCO] certificate modal detected, stop notice-popup closer loop' });
      break;
    }
    for (const ctx of contexts()) {
      const forced = await forceClosePopupPage(ctx);
      if (forced) { closed = true; continue; }

      for (const chkSel of checkSelectors) {
        try {
          const chks = await ctx.$$(chkSel);
          if (chks && chks.length) {
            for (const chk of chks) {
              if (handledElements.has(chk)) continue;
              await chk.click({ force:true }).catch(()=>{});
              handledElements.add(chk);
              closed = true;
              emit && emit({ type:'log', level:'info', msg:`[KEPCO] popup checkbox toggled: ${chkSel}` });
            }
          }
        } catch {}
      }

      for (const sel of activeSelectors) {
        try {
          const btns = await ctx.$$(sel);
          if (btns && btns.length) {
            for (const btn of btns) {
              if (handledElements.has(btn)) continue;
              const alreadyTouched = await btn.evaluate((el) => {
                if (!el || !el.dataset) return false;
                if (el.dataset.codexClosed === '1') return true;
                el.dataset.codexClosed = '1';
                return false;
              }).catch(() => false);
              if (alreadyTouched) continue;
              if (await shouldPreserveWorkflowModal(btn)) continue;
              await btn.click({ force: true }).catch(()=>{});
              handledElements.add(btn);
              closed = true;
              emit && emit({ type:'log', level:'info', msg:`[KEPCO] popup close candidate clicked: ${sel}` });
            }
          }
        } catch {}
      }
    }
    if (!closed) break;
    await page.waitForTimeout(150).catch(()=>{});
  }
}

async function closeExtraKepcoWindows(page, emit, options = {}) {
  if (!page) return;
  const context = typeof page.context === 'function' ? page.context() : null;
  if (!context || typeof context.pages !== 'function') return;
  const keepRegex = Object.prototype.hasOwnProperty.call(options, 'keepRegex') ? options.keepRegex : null;
  const popupPatterns = Array.isArray(options.popupPatterns) && options.popupPatterns.length
    ? options.popupPatterns
    : KEPCO_POPUP_URL_PATTERNS;
  const allowNonPopupClose = options.forceAll === true;
  const pages = context.pages();
  for (const current of pages) {
    if (!current || current.isClosed?.()) continue;
    if (current === page) continue;
    const url = (typeof current.url === 'function' ? current.url() : '') || '';
    if (!url) continue;
    if (keepRegex && keepRegex.test(url)) continue;
    if (!allowNonPopupClose && !popupPatterns.some((rx) => rx.test(url))) continue;
    try {
      await current.close({ runBeforeUnload: true });
      emit && emit({ type: 'log', level: 'info', msg: `[KEPCO] ??????????⑤벡???????????????????????????????關?쒎첎?嫄???? ${url}` });
    } catch {}
  }
}

async function goToBidApplyAndSearch(page, emit, bidId){
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  const log = (level, msg) => emit && emit({ type:'log', level, msg });
  const contexts = () => [page, ...(page.frames?.() || [])];
  const BID_LABELS = [/\uC785\uCC30\uACF5\uACE0\uBC88\uD638/i, /\uACF5\uACE0\uBC88\uD638/i, /\uC785\uCC30\uBC88\uD638/i];
  const BID_INPUT_SELECTORS = [
    'input[placeholder*="\uC785\uCC30" i]',
    'input[title*="\uACF5\uACE0" i]',
    'input[title*="\uACF5\uACE0\uBC88\uD638" i]',
    'input[title*="\uC785\uCC30\uACF5\uACE0" i]',
    'input[name*="bid" i]',
    'input[id*="bid" i]',
    'input[name*="gonggo" i]',
    'input[id*="gonggo" i]',
    'input[id*="textfield" i]',
    'input[componentid*="textfield" i]'
  ];
  const SEARCH_BUTTON_TEXT = '\uC870\uD68C';

  async function inFrames(run){
    for (const ctx of contexts()){
      try {
        const res = await run(ctx);
        if (res) return res;
      } catch {}
    }
    return null;
  }

  async function waitForCondition(predicate, timeoutMs = 6000){
    const start = Date.now();
    while (Date.now() - start < timeoutMs){
      const hit = await predicate();
      if (hit) return hit;
      await sleep(200);
    }
    return null;
  }

  async function waitForNoMask(timeoutMs = 8000){
    return await waitForCondition(async () => {
      const masked = await inFrames(async (ctx)=>{
        try { return await ctx.$('.x-mask, .ext-el-mask, .x-loading-mask'); } catch { return null; }
      });
      return masked ? null : true;
    }, timeoutMs);
  }

  async function waitForGrid(timeoutMs = 8000){
    return await waitForCondition(async () => inFrames(async (ctx)=>{
      try { return await ctx.$('.x-grid-row, tr.x-grid-row'); } catch { return null; }
    }), timeoutMs);
  }

  async function isUsableInput(handle){
    if (!handle) return false;
    try {
      const usable = await handle.evaluate((el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const hidden = style.visibility === 'hidden' || style.display === 'none';
        const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
        return rect.width > 3 && rect.height > 3 && !hidden && !disabled;
      });
      return !!usable;
    } catch {
      return false;
    }
  }

  async function findInputHandle(){
    const scoreCandidate = async (el) => {
      if (!el || !(await isUsableInput(el))) return -1;
      return await el.evaluate((node) => {
        const attr = (k) => String(node.getAttribute(k) || '');
        const lower = (v) => String(v || '').toLowerCase();
        const title = lower(attr('title'));
        const name = lower(attr('name'));
        const id = lower(attr('id'));
        const ph = lower(attr('placeholder'));
        const aria = lower(attr('aria-label'));
        const readOnly = node.hasAttribute('readonly') || node.getAttribute('aria-readonly') === 'true';
        const labelText = lower(node.closest('tr, td, div, form')?.textContent || '');
        const bag = `${title} ${name} ${id} ${ph} ${aria} ${labelText}`;
        if (!bag) return -1;
        if (/\uACF5\uACE0\uC77C\uC790|\uC2E0\uCCAD\uB9C8\uAC10|\uB9C8\uAC10\uC77C\uC790|from|to|date/.test(bag)) return -1;
        let score = 0;
        if (/\uACF5\uACE0\uBC88\uD638|\uC785\uCC30\uACF5\uACE0\uBC88\uD638|\uC785\uCC30\uBC88\uD638/.test(bag)) score += 10;
        if (/gonggo|bid/.test(bag)) score += 6;
        if (/\uC870\uD68C\uC870\uAC74|\uAC80\uC0C9\uC870\uAC74/.test(bag)) score += 2;
        if (/yyyy|mm|dd|\/\d{2}/.test(bag)) score -= 6;
        if (readOnly) score -= 4;
        return score;
      }).catch(() => -1);
    };
    for (const ctx of contexts()){
      const candidates = [];
      for (const sel of BID_INPUT_SELECTORS){
        try {
          const list = await ctx.$$(sel);
          for (const el of list || []) {
            const score = await scoreCandidate(el);
            if (score >= 0) candidates.push({ el, score });
          }
        } catch {}
      }
      if (candidates.length) {
        candidates.sort((a, b) => b.score - a.score);
        return candidates[0].el;
      }
    }
    return null;
  }

  async function findSearchButton(){
    const selectors = [
      `button:has-text("${SEARCH_BUTTON_TEXT}")`,
      `a:has-text("${SEARCH_BUTTON_TEXT}")`,
      `span.x-btn-inner:has-text("${SEARCH_BUTTON_TEXT}")`,
      'input[type="button"][value*="\uC870\uD68C"]'
    ];
    for (const ctx of contexts()){
      for (const sel of selectors){
        try {
          const el = await ctx.$(sel);
          if (el) return el;
        } catch {}
      }
    }
    return null;
  }

  await closeKepcoPostLoginModals(page, emit);
  await navigateToApplication(page, emit);

  if (!bidId){
    log('warn', '[KEPCO] \uC785\uCC30\uACF5\uACE0\uBC88\uD638(bidId)\uAC00 \uBE44\uC5B4 \uC788\uC5B4 \uAC80\uC0C9 \uB2E8\uACC4\uB97C \uAC74\uB108\uB731\uB2C8\uB2E4.');
    return;
  }

  const input = await waitForCondition(findInputHandle, 8000);
  if (!input){
    log('warn', '[KEPCO] \uC785\uCC30\uACF5\uACE0\uBC88\uD638 \uC785\uB825\uCC3D\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.');
    await dumpKepcoHtml(page, emit, 'bid_input_missing');
    return;
  }
  const desiredDigits = String(bidId).replace(/\D/g,'');
  const ensureValue = async () => {
    await input.scrollIntoViewIfNeeded?.().catch(()=>{});
    await input.click({ force:true }).catch(()=>{});
    await input.evaluate(el => { if (el && typeof el.value === 'string') el.value = ''; });
    await input.type(String(bidId), { delay: 20 }).catch(()=>input.fill(String(bidId)));
    await input.dispatchEvent('input').catch(()=>{});
    await input.dispatchEvent('change').catch(()=>{});
    const matches = await input.evaluate((el, digits) => {
      if (!el || typeof el.value !== 'string') return '';
      return el.value.replace(/\D/g,'');
    }, desiredDigits).catch(()=> '');
    if (matches !== desiredDigits) return false;
    const extState = await page.evaluate((digits) => {
      if (!(window.Ext && Ext.ComponentQuery)) return false;
      const list = Ext.ComponentQuery.query('textfield[isVisible()]') || [];
      const comp = list.find((it) => {
        const text = String(it?.fieldLabel || it?.title || it?.name || it?.id || '');
        if (!text) return false;
        if (!/\uACF5\uACE0\uBC88\uD638|\uC785\uCC30\uACF5\uACE0\uBC88\uD638|\uC785\uCC30\uBC88\uD638|gonggo|bid/i.test(text)) return false;
        if (/\uACF5\uACE0\uC77C\uC790|\uC2E0\uCCAD\uB9C8\uAC10|date|from|to/i.test(text)) return false;
        return true;
      }) || null;
      if (!comp) return true;
      const val = (comp.getValue && comp.getValue()) || comp.value || '';
      return String(val).replace(/\D/g,'') === digits;
    }, desiredDigits).catch(()=> true);
    return extState === true;
  };

  let appliedOk = false;
  for (let attempt = 0; attempt < 3 && !appliedOk; attempt++) {
    appliedOk = await ensureValue();
    if (!appliedOk) {
      await page.waitForTimeout(120).catch(()=>{});
    }
  }
  if (!appliedOk) {
    const finalValue = await input.evaluate(el => (el && typeof el.value === 'string') ? el.value : '').catch(()=> '');
    log('warn', `[KEPCO] bid number field input verification failed (value='${finalValue}')`);
    await dumpKepcoHtml(page, emit, 'bid_input_failed');
    return;
  }
  await page.waitForTimeout(120).catch(()=>{});
  log('info', `[KEPCO] \uC785\uCC30\uACF5\uACE0\uBC88\uD638 \uC785\uB825 \uC644\uB8CC: ${bidId}`);

  const searchBtn = await waitForCondition(findSearchButton, 5000);
  if (searchBtn){
    try {
      await searchBtn.scrollIntoViewIfNeeded?.().catch(()=>{});
      await searchBtn.click({ force:true }).catch(()=>searchBtn.click());
    } catch {}
  } else {
      log('warn', '[KEPCO] "\uC870\uD68C" \uBC84\uD2BC\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. Enter \uD0A4\uB85C \uB300\uCCB4 \uC2DC\uB3C4.');
    try { await input.press('Enter'); } catch {}
  }

  await waitForNoMask(8000);
  await waitForGrid(8000);
}

async function applyAfterSearch(page, emit, cert = {}, options = {}){
  const APPLY_BUTTON_TEXT = '\uC785\uCC30\uCC38\uAC00\uC2E0\uCCAD';
  const SUBMIT_SELECTOR = 'span.x-btn-inner:has-text("\uC81C\uCD9C"), button:has-text("\uC81C\uCD9C"), a:has-text("\uC81C\uCD9C"), [id$="-btnInnerEl"]';
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  const log = (level, msg)=>emit && emit({ type:'log', level, msg });

  const getAllPages = () => {
    const pages = [];
    const seen = new Set();
    const push = (pg) => {
      if (!pg || seen.has(pg) || pg.isClosed?.()) return;
      seen.add(pg);
      pages.push(pg);
    };
    push(page);
    try {
      for (const pg of page.context?.().pages?.() || []) push(pg);
    } catch {}
    return pages;
  };

  const getAllContexts = () => {
    const all = [];
    for (const pg of getAllPages()) {
      all.push({ ctx: pg, ownerPage: pg });
      try {
        for (const fr of pg.frames?.() || []) all.push({ ctx: fr, ownerPage: pg });
      } catch {}
    }
    return all;
  };

  async function inContexts(run){
    for (const { ctx, ownerPage } of getAllContexts()){
      try {
        const res = await run(ctx, ownerPage);
        if (res) return res;
      } catch {}
    }
    return null;
  }

  async function waitInContexts(predicate, timeoutMs=8000){
    const start = Date.now();
    while(Date.now() - start < timeoutMs){
      const hit = await inContexts(predicate);
      if (hit) return hit;
      await sleep(180);
    }
    return null;
  }

  async function waitForNoMask(timeoutMs=6000){
    const start = Date.now();
    while(Date.now() - start < timeoutMs){
      const masked = await inContexts(async (ctx)=>{
        try { return await ctx.$('.x-mask, .ext-el-mask, .x-loading-mask'); } catch { return null; }
      });
      if (!masked) return true;
      await sleep(120);
    }
    return false;
  }

  async function ensureGridSelectionViaExt(){
    return await page.evaluate(() => {
      try {
        if (!(window.Ext && Ext.ComponentQuery)) return false;
        const grids = Ext.ComponentQuery.query('gridpanel');
        if (!grids || !grids.length) return false;
        const target = grids.find(g => /\uC785\uCC30|\uAC00\uC2E0\uCCAD|\uACF5\uACE0/.test(String(g?.title || ''))) || grids[0];
        if (!target) return false;
        const selModel = target.getSelectionModel?.();
        const store = target.getStore?.();
        if (!selModel || !store) return false;
        if (selModel.hasSelection && selModel.hasSelection()) return true;
        const record = store.getAt?.(0);
        if (!record) return false;
        selModel.select(record);
        target.getView?.().focusRow?.(record);
        return selModel.hasSelection ? selModel.hasSelection() : true;
      } catch {
        return false;
      }
    });
  }

  const findApplyButton = async (ctx) => {
    try {
      const handle = await ctx.evaluateHandle((text) => {
        const normalize = (v) => String(v || '').replace(/\s+/g, '').trim();
        const targetText = normalize(text);
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          const rect = el.getBoundingClientRect();
          return !!rect && rect.width > 0 && rect.height > 0;
        };

        // 1) High-confidence path: grid toolbar request icon button.
        const requestIcons = Array.from(
          document.querySelectorAll('.grid-toolbar .btn-request, .x-toolbar-docked-top .btn-request')
        );
        for (const icon of requestIcons) {
          const button = icon.closest('a.x-btn, button, .x-btn');
          if (!button || !isVisible(button)) continue;
          const labelNode = button.querySelector('.x-btn-inner, span') || button;
          const label = normalize(labelNode.textContent || button.textContent || '');
          if (!label || label.indexOf('\uCDE8\uC18C') !== -1) continue;
          if (label === targetText || label.indexOf(targetText) !== -1) return button;
        }

        // 2) Fallback: selected-grid panel's top toolbar text match.
        const selectedRow = document.querySelector('.x-grid-row-selected, tr.x-grid-row-selected, .x-grid-item-selected');
        const checker = document.querySelector('.x-grid-row-checker');
        const anchor = selectedRow || checker;
        const panel = anchor ? anchor.closest('.x-grid, .x-gridpanel, .x-panel') : null;
        const toolbar = panel ? panel.querySelector('.grid-toolbar.x-docked-top, .x-toolbar-docked-top.grid-toolbar, .x-toolbar-docked-top') : null;
        if (!toolbar) return null;
        const buttons = Array.from(toolbar.querySelectorAll('a.x-btn, button, .x-btn'));
        for (const button of buttons) {
          if (!isVisible(button)) continue;
          const labelNode = button.querySelector('.x-btn-inner, span') || button;
          const label = normalize(labelNode.textContent || button.textContent || '');
          if (!label || label.indexOf('\uCDE8\uC18C') !== -1) continue;
          if (label === targetText) return button;
          if (button.querySelector('.btn-request') && label.indexOf(targetText) !== -1) return button;
        }
        return null;
      }, APPLY_BUTTON_TEXT);

      const el = handle?.asElement?.() || null;
      if (!el) return null;
      const buttonId = await el.evaluate((node) => {
        const root = node?.closest?.('a.x-btn, button, .x-btn') || node;
        return root?.id || '';
      }).catch(() => '');
      return { el, buttonId };
    } catch {
      return null;
    }
  };

  async function clickExactApplyButton(button, ctx){
    if (!button?.el) return false;
    await waitForNoMask(5000);
    try { await button.el.scrollIntoViewIfNeeded?.().catch(()=>{}); } catch {}
    try { await button.el.click({ force:true }); } catch {}
    try {
      await ctx.evaluate((buttonId) => {
        if (!buttonId) return;
        const root = document.getElementById(buttonId);
        if (!root) return;
        const inner = root.querySelector('.x-btn-inner, span');
        const fire = (el) => {
          if (!el) return;
          ['mouseover','mousedown','mouseup','click'].forEach((t) => {
            el.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true }));
          });
        };
        fire(root);
        fire(inner);
        if (window.Ext && typeof Ext.getCmp === 'function') {
          const cmp = Ext.getCmp(buttonId);
          if (cmp) {
            try { cmp.setDisabled && cmp.setDisabled(false); } catch {}
            try { cmp.focus && cmp.focus(); } catch {}
            try { cmp.fireEvent && cmp.fireEvent('click', cmp); } catch {}
            try { cmp.handler && cmp.handler.call(cmp); } catch {}
          }
        }
      }, button.buttonId || '');
    } catch {}
    return true;
  }

  let applyClicked = false;
  const pagesBeforeClick = new Set(getAllPages());

  const extSelected = await ensureGridSelectionViaExt();
  if (extSelected) log('info', '[KEPCO] Grid selection ensured via Ext.ComponentQuery');

  const checker = await waitInContexts(async (ctx)=>{
    const el = await ctx.$('.x-grid-row-checker').catch(()=>null)
           || await ctx.$('div.x-grid-row-checker[role="presentation"]').catch(()=>null);
    if (el) return { ctx, el };
    return null;
  }, 6000);

  if (checker && !extSelected) {
    try { await checker.el.click({ force:true }).catch(()=>{}); } catch {}
    log('info', '[KEPCO] Grid checkbox click');
    await sleep(200);
  }

  await inContexts(async (ctx)=>{
    const hasSelected = await ctx.$('.x-grid-row.x-grid-row-selected, tr.x-grid-row-selected, .x-grid-item-selected').catch(()=>null);
    if (hasSelected) return true;
    const first = await ctx.$('.x-grid-row, tr.x-grid-row, .x-grid-item').catch(()=>null);
    if (first) { try { await first.click({ force:true }).catch(()=>{}); } catch {} }
    return true;
  });

  const buttonHit = await waitInContexts(async (ctx) => {
    const found = await findApplyButton(ctx);
    return found ? { ctx, found } : null;
  }, 6000);

  if (!buttonHit) {
    log('warn', '[KEPCO] apply button not found');
    await dumpKepcoHtml(page, emit, 'apply_button_missing');
    throw new Error('[KEPCO] Failed to find apply button');
  }

  if (buttonHit.found?.buttonId) {
    log('info', '[KEPCO] apply target id=' + buttonHit.found.buttonId);
  }
  await clickExactApplyButton(buttonHit.found, buttonHit.ctx);
  applyClicked = true;
  log('info', '[KEPCO] apply button click completed');

  const followUp = await waitInContexts(async (ctx, ownerPage) => {
    const modal = await ctx.$('.x-window, .x-message-box').catch(()=>null);
    if (modal) return { page: ownerPage, reason: 'modal' };
    const submit = await ctx.$(SUBMIT_SELECTOR).catch(()=>null);
    if (submit) return { page: ownerPage, reason: 'submit-visible' };
    return null;
  }, 3000);

  let workPage = page;
  if (followUp?.page) {
    workPage = followUp.page;
    log('info', '[KEPCO] follow-up detected (' + followUp.reason + ')');
  } else {
    const opened = getAllPages().find((pg) => !pagesBeforeClick.has(pg));
    if (opened) {
      workPage = opened;
      await opened.waitForLoadState('domcontentloaded').catch(()=>{});
      log('info', '[KEPCO] follow-up detected (new popup page)');
    } else {
      log('warn', '[KEPCO] apply button clicked but follow-up modal/page was not detected');
      await dumpKepcoHtml(page, emit, 'apply_modal_missing');
    }
  }

  if (!applyClicked) {
    throw new Error('[KEPCO] Apply button click was not confirmed');
  }

  const finalRes = await handleFinalAgreementAndSubmit(workPage, emit, cert, options);
  if (finalRes?.alreadyApplied) {
    log('warn', '[KEPCO] already applied state detected; duplicate submission is not allowed');
    throw new Error('[KEPCO] Bid is already applied and cannot be submitted again');
  }
  if (!finalRes?.submitted) {
    throw new Error('[KEPCO] Final submit button click was not confirmed');
  }
  if (!finalRes?.completed) {
    throw new Error('[KEPCO] Final completion was not confirmed (' + (finalRes?.completionReason || 'unknown') + ')');
  }
}

async function handleFinalAgreementAndSubmit(page, emit, cert = {}, options = {}){
  const log = (level,msg)=>emit && emit({ type:'log', level, msg });
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  const SUBMIT_SELECTOR = 'span.x-btn-inner:has-text("\uC81C\uCD9C"), button:has-text("\uC81C\uCD9C"), a:has-text("\uC81C\uCD9C"), [id$="-btnInnerEl"]';
  const AGREEMENT_PATTERNS = [
    /\uACF5\uAE09\uC790.*\uD589\uB3D9\uAC15\uB839.*\uB3D9\uC758/i,
    /\uCCAD\uB7C9\uACC4\uC57D.*\uC774\uD589\uAC01\uC11C.*\uB3D9\uC758/i,
    /\uC870\uC138\uD3EC\uD0AC.*\uC11C\uC57D\uC11C.*\uB3D9\uC758/i,
    /\uC704\uC758\uC0AC\uD56D.*\uD655\uC778\uD588\uC2B5\uB2C8\uB2E4/i
  ];

  const contexts = () => {
    const list = [];
    const seen = new Set();
    const push = (ctx) => {
      if (!ctx || seen.has(ctx)) return;
      seen.add(ctx);
      list.push(ctx);
    };
    push(page);
    try {
      for (const pg of page.context?.().pages?.() || []) {
        if (!pg || pg.isClosed?.()) continue;
        push(pg);
      }
    } catch {}
    const pages = list.filter((ctx) => typeof ctx.frames === 'function');
    for (const pg of pages) {
      try {
        for (const fr of pg.frames?.() || []) push(fr);
      } catch {}
    }
    return list;
  };

  let dumpedAgreementState = false;
  const ensureAgreementDump = async (tag = 'agreement_missing') => {
    if (dumpedAgreementState) return;
    dumpedAgreementState = true;
    await dumpKepcoHtml(page, emit, tag);
  };

  const dismissInlineAlerts = async (aggressive = false) => {
    const conservative = [
      '.popup-close',
      '.btn-close',
      'span[onclick*="close"]',
      'a[onclick*="close" i]',
      'img[onclick*="close" i]',
      'button.btn-popup-close',
      '#btnClose',
      '.btn-popup-close'
    ];
    const aggressiveExtra = [
      'button:has-text("\uD655\uC778")',
      'a:has-text("\uD655\uC778")',
      'span.x-btn-inner:has-text("\uD655\uC778")',
      'button:has-text("\uB2EB\uAE30")',
      'a:has-text("\uB2EB\uAE30")'
    ];
    const selectors = aggressive ? conservative.concat(aggressiveExtra) : conservative;
    for (const ctx of contexts()) {
      for (const sel of selectors) {
        try {
          const buttons = await ctx.$$(sel);
          for (const btn of buttons || []) {
            const shouldSkip = await btn.evaluate((node) => {
              try {
                const root = node?.closest?.('.x-message-box, .x-window, .x-panel-popup, .x-layer, [role="dialog"]') || null;
                if (!root) return true;
                const text = String(root.textContent || '').replace(/\s+/g, '');
                const hasUncheckedWorkflowBox = Array.from(
                  root.querySelectorAll('input[role="checkbox"], input.x-form-checkbox, input[type="checkbox"], input[type="button"][role="checkbox"]')
                ).some((cb) => {
                  if (!cb) return false;
                  const aria = cb.getAttribute?.('aria-checked');
                  if (aria === 'true') return false;
                  if (typeof cb.checked === 'boolean' && cb.checked) return false;
                  return true;
                });
                if (/\uC785\uCC30\uB2F4\uD569\uC720\uC758\uC0AC\uD56D|\uC704\uC758\uC0AC\uD56D|\uD655\uC778\uD558\uC600\uC2B5\uB2C8\uB2E4/.test(text) && hasUncheckedWorkflowBox) {
                  return true;
                }
              } catch {}
              return false;
            }).catch(() => false);
            if (shouldSkip) continue;
            const root = await btn.evaluateHandle((node) => node?.closest?.('a.x-btn, button, .x-btn, [role="button"]') || node).catch(()=>null);
            const target = root?.asElement?.() || btn;
            await target.click({ force:true }).catch(()=>{});
          }
        } catch {}
      }
    }
  };

  // Reset per-bid checkbox touch cache so previous bid state does not leak.
  for (const ctx of contexts()) {
    try { await ctx.evaluate(() => { delete window.__codexAgreementTouchedMap; }); } catch {}
  }

  const confirmYesDialog = async () => {
    for (const ctx of contexts()) {
      try {
        const yesCandidates = await ctx.$$('span.x-btn-inner:has-text("\uC608"), button:has-text("\uC608"), a:has-text("\uC608"), [id$="-btnInnerEl"]');
        for (const cand of yesCandidates || []) {
          const text = ((await cand.textContent().catch(()=>'')) || '').replace(/\s+/g, '');
          if (text !== '\uC608') continue;
          const root = await cand.evaluateHandle((node) => node?.closest?.('a.x-btn, button, .x-btn') || node).catch(()=>null);
          const rootEl = root?.asElement?.() || null;
          if (rootEl) {
            await rootEl.scrollIntoViewIfNeeded?.().catch(()=>{});
            await rootEl.click({ force:true }).catch(()=>{});
          } else {
            await cand.click({ force:true }).catch(()=>{});
          }
          log('info', '[KEPCO] confirmation dialog "?? clicked');
          return true;
        }
      } catch {}
    }

    for (const ctx of contexts()) {
      try {
        const extClicked = await ctx.evaluate(() => {
          try {
            if (!window.Ext || !Ext.ComponentQuery) return false;
            const btns = Ext.ComponentQuery.query('button');
            for (const btn of btns || []) {
              const label = String(btn?.text || btn?.ariaLabel || btn?.el?.dom?.textContent || '').replace(/\s+/g, '');
              if (label !== '\uC608') continue;
              try { btn.setDisabled && btn.setDisabled(false); } catch {}
              try { btn.focus && btn.focus(); } catch {}
              try { btn.fireEvent && btn.fireEvent('click', btn); } catch {}
              try { btn.handler && btn.handler.call(btn); } catch {}
              return true;
            }
          } catch {}
          return false;
        });
        if (extClicked) {
          log('info', '[KEPCO] confirmation dialog "?? clicked via Ext fallback');
          return true;
        }
      } catch {}
    }
    return false;
  };

  const checkConfirmedStatementBox = async () => {
    for (const ctx of contexts()) {
      try {
        const hit = await ctx.evaluate(() => {
          const isChecked = (cb) => {
            if (!cb) return false;
            if (typeof cb.checked === 'boolean' && cb.checked) return true;
            const aria = String(cb.getAttribute?.('aria-checked') || '').toLowerCase();
            if (aria === 'true') return true;
            const cls = String(cb.className || '');
            if (/\bx-form-cb-checked\b/.test(cls)) return true;
            const wrapCls = String(cb.closest?.('.x-form-cb-wrap, .x-form-checkbox, label, td, tr, div')?.className || '');
            return /\bx-form-cb-checked\b/.test(wrapCls);
          };
          const candidates = Array.from(document.querySelectorAll(
            'input[type="checkbox"][title*="\uC704\uC758 \uC0AC\uD56D" i], input[type="checkbox"][title*="\uD655\uC778" i], input[role="checkbox"][title*="\uC704\uC758 \uC0AC\uD56D" i], input[role="checkbox"][title*="\uD655\uC778" i], input.x-form-checkbox, .x-form-cb-wrap input, input[type="checkbox"]'
          ));
          for (const cb of candidates) {
            const nearbyText = String(cb?.closest?.('label, td, tr, div')?.textContent || '').replace(/\s+/g, '');
            const title = String(cb?.getAttribute?.('title') || '').replace(/\s+/g, '');
            const isTarget = /\uC704\uC758\uC0AC\uD56D|\uD655\uC778\uD558\uC600\uC2B5\uB2C8\uB2E4|\uC785\uCC30\uB2F4\uD569\uC720\uC758\uC0AC\uD56D/.test(nearbyText + title);
            if (!isTarget) continue;
            if (!cb) continue;
            const style = window.getComputedStyle(cb);
            const rect = cb.getBoundingClientRect();
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            if (!rect || rect.width <= 0 || rect.height <= 0) continue;
            if (isChecked(cb)) return true;
            try { cb.focus?.(); } catch {}
            try { cb.click(); } catch {}
            if (!isChecked(cb)) {
              const wrap = cb.closest('.x-form-cb-wrap, label, .x-form-checkbox, .x-field, td, tr, div');
              try { wrap?.click?.(); } catch {}
            }
            cb.dispatchEvent?.(new Event('input', { bubbles:true }));
            cb.dispatchEvent?.(new Event('change', { bubbles:true }));
            if (isChecked(cb)) return true;
          }
          return false;
        });
        if (hit) {
          log('info', '[KEPCO] confirmation statement checkbox clicked');
          return true;
        }
      } catch {}
    }
    return false;
  };

  const waitForFinalStage = async (timeoutMs = 5000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      for (const ctx of contexts()) {
        try {
          const ready = await ctx.evaluate(() => {
            const norm = (s) => String(s || '').replace(/\s+/g, '');
            const isVisible = (el) => {
              if (!el) return false;
              const style = window.getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              if (style.display === 'none' || style.visibility === 'hidden') return false;
              return !!rect && rect.width > 0 && rect.height > 0;
            };
            const nodes = Array.from(document.querySelectorAll('span.x-btn-inner, button, a, [id$="-btnInnerEl"]'));
            for (const node of nodes) {
              if (norm(node.textContent) !== '제출') continue;
              const target = node.closest?.('a.x-btn, button, .x-btn, [role="button"]') || node;
              if (isVisible(target)) return true;
            }
            return false;
          });
          if (ready) return true;
        } catch {}
      }
      await sleep(120);
    }
    return false;
  };

  const checkAgreementByPattern = async (pattern) => {
    const normalized = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
    for (const ctx of contexts()) {
      try {
        const matched = await ctx.evaluate((regexStr) => {
          const regex = new RegExp(regexStr, 'i');
          const nodes = Array.from(document.querySelectorAll('label, span, div'));
          for (const node of nodes) {
            const text = (node.textContent || '').replace(/\s+/g,'');
            if (!text || !regex.test(text)) continue;
            const checkbox = node.querySelector('input[type="checkbox"], input[role="checkbox"], input.x-form-checkbox')
              || node.closest('tr, div, label')?.querySelector('input[type="checkbox"], input[role="checkbox"], input.x-form-checkbox')
              || document.querySelector('input[type="checkbox"], input[role="checkbox"], input.x-form-checkbox');
            if (checkbox) {
              checkbox.click();
              checkbox.checked = true;
              checkbox.dispatchEvent(new Event('change', { bubbles:true }));
              return true;
            }
          }
          return false;
        }, normalized.source);
        if (matched) return true;
      } catch {}
    }
    return false;
  };

  const checkAllVisibleAgreementBoxes = async () => {
    let total = 0;
    for (const ctx of contexts()) {
      try {
        const touched = await ctx.evaluate(async () => {
          const cbSelector = 'input[type="checkbox"], input[role="checkbox"], input.x-form-checkbox';
          const rootScroller = document.scrollingElement || document.documentElement || document.body;
          const wait = (ms = 90) => new Promise((resolve) => setTimeout(resolve, ms));

          const norm = (s) => String(s || '').replace(/\s+/g, '');
          const isVisible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            return !!rect && rect.width > 0 && rect.height > 0;
          };
          const isChecked = (cb) => {
            if (!cb) return false;
            try {
              const cmpId = cb.getAttribute?.('componentid') || String(cb.id || '').replace(/-inputEl$/, '');
              if (cmpId && window.Ext && typeof Ext.getCmp === 'function') {
                const cmp = Ext.getCmp(cmpId);
                const v = cmp?.getValue?.();
                if (typeof v === 'boolean') return v;
              }
            } catch {}
            if (typeof cb.checked === 'boolean' && cb.checked) return true;
            const aria = String(cb.getAttribute?.('aria-checked') || '').toLowerCase();
            if (aria === 'true') return true;
            const cls = String(cb.className || '');
            if (/\bx-form-cb-checked\b/.test(cls)) return true;
            const wrapCls = String(cb.closest?.('.x-form-cb-wrap, .x-form-checkbox, label, td, tr, div')?.className || '');
            return /\bx-form-cb-checked\b/.test(wrapCls);
          };
          const setCheckedByExt = (cb) => {
            try {
              const cmpId = cb?.getAttribute?.('componentid') || String(cb?.id || '').replace(/-inputEl$/, '');
              if (!cmpId || !(window.Ext && typeof Ext.getCmp === 'function')) return false;
              const cmp = Ext.getCmp(cmpId);
              if (!cmp) return false;
              if (cmp.setValue) cmp.setValue(true);
              try { cmp.fireEvent && cmp.fireEvent('change', cmp, true); } catch {}
              return true;
            } catch {}
            return false;
          };
          const touchedMap = window.__codexAgreementTouchedMap || (window.__codexAgreementTouchedMap = {});

          const agreementLike = (cb) => {
            const title = String(cb.getAttribute('title') || '').toLowerCase();
            if (title.includes('today') || title.includes('?ㅻ뒛') || title.includes('?ㅼ떆')) return false;
            const inDialog = cb.closest('.x-message-box, .x-window, .x-panel-popup, [role="dialog"]');
            if (inDialog) return false;
            const byAria = norm(cb.getAttribute('aria-label') || cb.getAttribute('name') || cb.id || '');
            const parent = cb.closest('label, td, tr, li, div, .x-form-cb-wrap, .x-panel, .x-container');
            const parentText = norm(parent?.textContent || '');
            const combined = byAria + parentText;
            if (!combined) return true;
            if (/\uC624\uB298|\uB2E4\uC2DC\uBCF4\uAE30|\uD558\uB8E8\uB3D9\uC548|\uD31D\uC5C5/.test(combined)) return false;
            return true;
          };

          const clickAgreementBoxes = () => {
            let count = 0;
            const boxes = Array.from(document.querySelectorAll(cbSelector));
            for (const cb of boxes) {
              if (!cb || cb.disabled) continue;
              if (!agreementLike(cb)) continue;
              if (isChecked(cb)) continue;
              const touchKey = String(cb.id || cb.getAttribute?.('componentid') || '');
              if (touchKey && touchedMap[touchKey]) continue;

              const id = cb.id || '';
              let label = null;
              if (id) {
                try {
                  const safeId = (window.CSS && CSS.escape) ? CSS.escape(id) : id.replace(/([#.;?+*~\":!^$\[\]()=>|\/@])/g, '\\$1');
                  label = document.querySelector(`label[for="${safeId}"]`);
                } catch {}
              }

              try { cb.scrollIntoView?.({ block: 'center' }); } catch {}
              try { cb.focus?.(); } catch {}
              try { cb.click(); } catch {}
              if (!isChecked(cb) && label && isVisible(label)) {
                try { label.click(); } catch {}
              }
              if (!isChecked(cb)) {
                const wrap = cb.closest('.x-form-cb-wrap, label, .x-form-checkbox, .x-field, td, tr, div');
                try { wrap?.click?.(); } catch {}
              }
              if (!isChecked(cb)) {
                setCheckedByExt(cb);
              }

              if (isChecked(cb)) {
                if (touchKey) touchedMap[touchKey] = true;
                cb.dispatchEvent?.(new Event('input', { bubbles: true }));
                cb.dispatchEvent?.(new Event('change', { bubbles: true }));
                count++;
              }
            }
            return count;
          };

          let count = 0;
          try {
            if (window.Ext && Ext.ComponentQuery) {
              const comps = [
                ...(Ext.ComponentQuery.query('checkboxfield') || []),
                ...(Ext.ComponentQuery.query('checkbox') || [])
              ];
              for (const cmp of comps) {
                try {
                  if (!cmp || (cmp.isVisible && !cmp.isVisible()) || cmp.hidden) continue;
                  const owner = cmp.up?.('window, messagebox, panel[cls*=popup], panel[floating=true]');
                  if (owner) continue;
                  const inputEl = cmp.inputEl?.dom || cmp.el?.down?.('input')?.dom || null;
                  if (!inputEl || inputEl.disabled) continue;
                  const title = norm(inputEl.getAttribute?.('title') || '');
                  if (/오늘|다시보기|하루동안|팝업/.test(title)) continue;
                  const text = norm(
                    (cmp.boxLabel || '') + ' ' +
                    (cmp.fieldLabel || '') + ' ' +
                    (inputEl.getAttribute?.('aria-label') || '') + ' ' +
                    (inputEl.closest?.('label, td, tr, div, .x-form-cb-wrap, .x-panel')?.textContent || '')
                  );
                  if (/오늘|다시보기|하루동안|팝업/.test(text)) continue;
                  const before = !!(cmp.getValue?.() || isChecked(inputEl));
                  if (!before) {
                    try { cmp.setValue?.(true); } catch {}
                    try { cmp.fireEvent?.('change', cmp, true); } catch {}
                    const after = !!(cmp.getValue?.() || isChecked(inputEl));
                    if (after) count++;
                  }
                } catch {}
              }
            }
          } catch {}
          count += clickAgreementBoxes();

          const max = Math.max(0, (rootScroller.scrollHeight || 0) - (rootScroller.clientHeight || 0));
          const step = Math.max(220, Math.floor((rootScroller.clientHeight || 700) * 0.8));
          for (let pos = 0; pos <= max; pos += step) {
            try {
              rootScroller.scrollTop = pos;
              rootScroller.dispatchEvent?.(new Event('scroll', { bubbles: true }));
            } catch {}
            await wait(110);
            count += clickAgreementBoxes();
          }

          try {
            rootScroller.scrollTop = max;
            rootScroller.dispatchEvent?.(new Event('scroll', { bubbles: true }));
          } catch {}
          await wait(140);
          count += clickAgreementBoxes();
          return count;
        });
        total += Number(touched || 0);
      } catch {}
    }
    if (total > 0) {
      log('info', '[KEPCO] checked visible agreement checkboxes count=' + total);
    }
    return total;
  };

  
  const clickSubmitButton = async () => {
    for (const ctx of contexts()) {
      try {
        const clicked = await ctx.evaluate(() => {
          const pickClickable = (node) => {
            if (!node) return null;
            return node.closest?.('a.x-btn, button, .x-btn, [role="button"]') || node;
          };
          const isVisible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            return !!rect && rect.width > 0 && rect.height > 0;
          };
          const textOf = (el) => String(el?.textContent || '').replace(/\s+/g, '');

          const nodeCandidates = Array.from(document.querySelectorAll('span.x-btn-inner, button, a, [id$="-btnInnerEl"]'));
          for (const node of nodeCandidates) {
            if (textOf(node) !== '\uC81C\uCD9C') continue;
            const target = pickClickable(node);
            if (!isVisible(target)) continue;
            try { target.scrollIntoView?.({ block: 'center' }); } catch {}
            try { target.click?.(); } catch {}
            try { target.dispatchEvent?.(new MouseEvent('click', { bubbles: true, cancelable: true })); } catch {}
            return true;
          }
          return false;
        });
        if (clicked) return true;
      } catch {}

      try {
        const candidates = await ctx.$$(SUBMIT_SELECTOR);
        for (const node of candidates || []) {
          const text = ((await node.textContent().catch(() => '')) || '').replace(/\s+/g, '');
          if (text !== '\uC81C\uCD9C') continue;
          const root = await node.evaluateHandle((el) => el?.closest?.('a.x-btn, button, .x-btn, [role="button"]') || el).catch(() => null);
          const target = root?.asElement?.() || node;
          await target.scrollIntoViewIfNeeded?.().catch(()=>{});
          await target.click({ force:true }).catch(()=>{});
          return true;
        }
      } catch {}
    }
    return false;
  };
  const detectUncheckedAgreementCount = async () => {
    for (const ctx of contexts()) {
      try {
        const left = await ctx.evaluate(() => {
          const norm = (s) => String(s || '').replace(/\s+/g, '');
          const isVisible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            return !!rect && rect.width > 0 && rect.height > 0;
          };
          const isChecked = (cb) => {
            if (!cb) return false;
            try {
              const cmpId = cb.getAttribute?.('componentid') || String(cb.id || '').replace(/-inputEl$/, '');
              if (cmpId && window.Ext && typeof Ext.getCmp === 'function') {
                const cmp = Ext.getCmp(cmpId);
                const v = cmp?.getValue?.();
                if (typeof v === 'boolean') return v;
              }
            } catch {}
            if (typeof cb.checked === 'boolean' && cb.checked) return true;
            const aria = String(cb.getAttribute?.('aria-checked') || '').toLowerCase();
            if (aria === 'true') return true;
            const cls = String(cb.className || '');
            if (/\bx-form-cb-checked\b/.test(cls)) return true;
            const wrapCls = String(cb.closest?.('.x-form-cb-wrap, .x-form-checkbox, label, td, tr, div')?.className || '');
            return /\bx-form-cb-checked\b/.test(wrapCls);
          };
          try {
            if (window.Ext && Ext.ComponentQuery) {
              const comps = [
                ...(Ext.ComponentQuery.query('checkboxfield') || []),
                ...(Ext.ComponentQuery.query('checkbox') || [])
              ];
              let extRemaining = 0;
              for (const cmp of comps) {
                try {
                  if (!cmp || (cmp.isVisible && !cmp.isVisible()) || cmp.hidden) continue;
                  const owner = cmp.up?.('window, messagebox, panel[cls*=popup], panel[floating=true]');
                  if (owner) continue;
                  const inputEl = cmp.inputEl?.dom || cmp.el?.down?.('input')?.dom || null;
                  if (!inputEl || inputEl.disabled || !isVisible(inputEl)) continue;
                  const txt = norm(
                    (cmp.boxLabel || '') + ' ' +
                    (cmp.fieldLabel || '') + ' ' +
                    (inputEl.getAttribute?.('aria-label') || '') + ' ' +
                    (inputEl.closest?.('label, td, tr, div, .x-form-cb-wrap, .x-panel')?.textContent || '')
                  );
                  if (/오늘|다시보기|하루동안|팝업/.test(txt)) continue;
                  const checked = !!(cmp.getValue?.() || isChecked(inputEl));
                  if (!checked) extRemaining++;
                } catch {}
              }
              if (extRemaining > 0) return extRemaining;
            }
          } catch {}
          const boxes = Array.from(document.querySelectorAll('input[type="checkbox"], input[role="checkbox"], input.x-form-checkbox'));
          let remaining = 0;
          for (const cb of boxes) {
            if (!isVisible(cb) || cb.disabled) continue;
            const inDialog = cb.closest('.x-message-box, .x-window, .x-panel-popup, [role="dialog"]');
            if (inDialog) continue;
            const txt = norm((cb.closest('label, td, tr, div, .x-form-cb-wrap, .x-panel')?.textContent || '') + ' ' + (cb.getAttribute('aria-label') || '') + ' ' + (cb.getAttribute('name') || ''));
            if (/\uC624\uB298|\uB2E4\uC2DC\uBCF4\uAE30|\uD558\uB8E8\uB3D9\uC548|\uD31D\uC5C5/.test(txt)) continue;
            if (!isChecked(cb)) remaining++;
          }
          return remaining;
        });
        if (Number(left || 0) > 0) return Number(left || 0);
      } catch {}
    }
    return 0;
  };

  const hasSubmitValidationAlert = async () => {
    for (const ctx of contexts()) {
      try {
        const hit = await ctx.evaluate(() => {
          const nodes = Array.from(document.querySelectorAll('.x-message-box, .x-window, [role="dialog"], .x-window-body, .x-panel-body'));
          for (const node of nodes) {
            const text = String(node.textContent || '').replace(/\s+/g, '');
            if (!text) continue;
            if (/\uD544\uC218|\uCCB4\uD06C|\uB3D9\uC758|\uC120\uD0DD|\uD655\uC778\uD558\uC138\uC694/.test(text)) return true;
          }
          return false;
        });
        if (hit) return true;
      } catch {}
    }
    return false;
  };

  const hasCertificateModalAfterSubmit = async () => {
    const certSelectors = [
      '#nx-cert-select',
      '.nx-cert-select',
      '#nx-cert-select-wrap',
      '#browser-guide-added-wrapper',
      'input[name="cert-password" i]',
      'input[type="password"][id*="cert" i]',
      'input[type="password"][name*="cert" i]'
    ];
    for (const ctx of contexts()) {
      for (const sel of certSelectors) {
        try {
          const el = await ctx.$(sel);
          if (el) return true;
        } catch {}
      }
    }
    return false;
  };

  const closeCompletionDialogIfPresent = async () => {
    for (const ctx of contexts()) {
      try {
        const hit = await ctx.evaluate(() => {
          const norm = (s) => String(s || '').replace(/\s+/g, '');
          const dialogs = Array.from(document.querySelectorAll('.x-message-box, .x-window, [role="dialog"], .x-window-body'));
          const isCompletionText = (text) =>
            /\uCC38\uAC00\uC2E0\uCCAD.*\uC644\uB8CC|\uC785\uCC30\uCC38\uAC00\uC2E0\uCCAD.*\uC644\uB8CC|\uC2E0\uCCAD.*\uC644\uB8CC|\uC81C\uCD9C.*\uC644\uB8CC|\uC81C\uCD9C\uD558\uC600\uC2B5\uB2C8\uB2E4|\uC811\uC218\uC644\uB8CC|\uCC98\uB9AC\uC644\uB8CC|\uC644\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4/.test(text);
          const isConfirmLike = (text) => /^(\uD655\uC778|\uC608|\uB2EB\uAE30)/.test(text);
          for (const dlg of dialogs) {
            const text = norm(dlg.textContent || '');
            if (!text || !isCompletionText(text)) continue;
            const btns = Array.from(dlg.querySelectorAll(
              'span.x-btn-inner, button, a, [id$="-btnInnerEl"], input[type="button"], input[type="submit"]'
            ));
            for (const b of btns) {
              const bt = norm(b.textContent || b.getAttribute?.('value') || b.getAttribute?.('title') || '');
              if (!isConfirmLike(bt)) continue;
              const target = b.closest?.('a.x-btn, button, .x-btn, [role="button"]') || b;
              try { target.click?.(); } catch {}
              try { target.dispatchEvent?.(new MouseEvent('click', { bubbles:true, cancelable:true })); } catch {}
              return true;
            }
          }
          return false;
        });
        if (hit) return true;
      } catch {}
    }
    return false;
  };


  const detectCompletionSignal = async () => {
    for (const ctx of contexts()) {
      try {
        const sig = await ctx.evaluate(() => {
          const norm = (s) => String(s || '').replace(/\s+/g, '');
          const isVisible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            return !!rect && rect.width > 0 && rect.height > 0;
          };

          const fullText = norm(document.body?.innerText || document.body?.textContent || '');
          const successText = /\uCC38\uAC00\uC2E0\uCCAD\uC774\uC644\uB8CC|\uCC38\uAC00\uC2E0\uCCAD\uC644\uB8CC|\uC2E0\uCCAD\uC774\uC644\uB8CC|\uC2E0\uCCAD\uC644\uB8CC|\uC81C\uCD9C\uC774\uC644\uB8CC|\uC81C\uCD9C\uC644\uB8CC|\uC815\uC0C1\uCC98\uB9AC|\uC811\uC218\uC644\uB8CC|\uCC98\uB9AC\uC644\uB8CC|\uC644\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4/.test(fullText);

          const submitNodes = Array.from(document.querySelectorAll('span.x-btn-inner, button, a, [id$="-btnInnerEl"]'));
          const hasSubmitBtn = submitNodes.some((el) => isVisible(el) && norm(el.textContent) === '\uC81C\uCD9C');

          const dialogNodes = Array.from(document.querySelectorAll('.x-message-box, .x-window, [role="dialog"]'));
          const hasYesNoDialog = dialogNodes.some((el) => {
            const txt = norm(el.textContent || '');
            return /\uC608/.test(txt) && /\uC544\uB2C8\uC624/.test(txt);
          });

          return {
            successText,
            hasSubmitBtn,
            hasYesNoDialog,
            url: String(location.href || '')
          };
        });
        if (sig?.successText) return { completed: true, reason: 'success_text', url: sig?.url || '' };
        if (!sig?.hasSubmitBtn && !sig?.hasYesNoDialog) {
          return { completed: true, reason: 'submit_disappeared', url: sig?.url || '' };
        }
      } catch {}
    }
    return { completed: false, reason: 'no_signal' };
  };

  const waitForFinalCompletion = async (timeoutMs = 12000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await hasCertificateModalAfterSubmit()) {
        await sleep(180);
        continue;
      }
      const closedInfoAlerts = await closeBlockingInfoAlerts();
      if (closedInfoAlerts > 0) {
        await sleep(180);
      }
      if (await closeCompletionDialogIfPresent()) {
        return { completed: true, reason: 'completion_dialog_closed' };
      }
      if (await hasSubmitValidationAlert()) {
        return { completed: false, reason: 'validation_alert' };
      }
      const unchecked = await detectUncheckedAgreementCount();
      if (unchecked > 0) {
        return { completed: false, reason: `unchecked_${unchecked}` };
      }
      const signal = await detectCompletionSignal();
      if (signal?.completed) return signal;
      await sleep(220);
    }
    return { completed: false, reason: 'completion_timeout' };
  };

  const probeLateCompletion = async (timeoutMs = 5000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      await closeBlockingInfoAlerts();
      if (await closeCompletionDialogIfPresent()) {
        return { completed: true, reason: 'late_completion_dialog_closed' };
      }
      const signal = await detectCompletionSignal();
      if (signal?.completed) return signal;
      if (await hasCertificateModalAfterSubmit()) {
        return { completed: true, reason: 'late_certificate_modal_detected' };
      }
      await sleep(220);
    }
    return { completed: false, reason: 'late_no_signal' };
  };
  const confirmYesDialogsAfterSubmit = async (maxRounds = 5) => {
    let clicked = 0;
    for (let i = 0; i < maxRounds; i++) {
      if (await hasCertificateModalAfterSubmit()) {
        log('info', '[KEPCO] certificate modal detected during yes-loop; stop yes loop');
        break;
      }

      const ok = await confirmYesDialog();
      if (!ok) {
        await sleep(180);
        if (await hasCertificateModalAfterSubmit()) {
          log('info', '[KEPCO] certificate modal detected during yes-loop retry; stop yes loop');
          break;
        }
        const retry = await confirmYesDialog();
        if (!retry) break;
        clicked += 1;
      } else {
        clicked += 1;
      }

      await sleep(240);
      if (await hasCertificateModalAfterSubmit()) {
        log('info', '[KEPCO] certificate modal detected after yes click; stop yes loop');
        break;
      }
      await dismissInlineAlerts();
      await closeBlockingInfoAlerts();
    }
    if (clicked > 0) {
      log('info', `[KEPCO] submit follow-up "yes" clicks=${clicked}`);
    }
    return clicked;
  };

  const detectAlreadyAppliedDialog = async () => {
    for (const ctx of contexts()) {
      try {
        const hit = await ctx.evaluate(() => {
          const norm = (s) => String(s || '').replace(/\s+/g, '');
          const dialogs = Array.from(document.querySelectorAll('.x-message-box, .x-window, [role="dialog"], .x-window-body, .x-panel-body'));
          const hasAlreadyAppliedText = (text) =>
            /\uC785\uCC30\uCC38\uAC00\uC2E0\uCCAD\uC744\uD558\uC2E4\uC218\uC788\uB294\uC0C1\uD0DC\uAC00\uC544\uB2D9\uB2C8\uB2E4/.test(text)
            || /\uC774\uBBF8.*\uCC38\uAC00\uC2E0\uCCAD/.test(text);
          for (const dlg of dialogs) {
            const text = norm(dlg.textContent || '');
            if (!text || !hasAlreadyAppliedText(text)) continue;
            const buttons = Array.from(dlg.querySelectorAll('span.x-btn-inner, button, a, [id$="-btnInnerEl"], input[type="button"], input[type="submit"]'));
            for (const b of buttons) {
              const label = norm(b.textContent || b.getAttribute?.('value') || b.getAttribute?.('title') || '');
              if (!/^(\uD655\uC778|\uC608|\uB2EB\uAE30)/.test(label)) continue;
              const target = b.closest?.('a.x-btn, button, .x-btn, [role="button"]') || b;
              try { target.click?.(); } catch {}
              try { target.dispatchEvent?.(new MouseEvent('click', { bubbles: true, cancelable: true })); } catch {}
              return true;
            }
            return true;
          }
          return false;
        });
        if (hit) return true;
      } catch {}
    }
    return false;
  };

  const closeBlockingInfoAlerts = async () => {
    let closed = 0;
    for (const ctx of contexts()) {
      try {
        const hit = await ctx.evaluate(() => {
          const norm = (s) => String(s || '').replace(/\s+/g, '');
          const dialogs = Array.from(document.querySelectorAll('.x-message-box, .x-window, [role="dialog"], .x-window-body, .x-panel-body'));
          let count = 0;
          for (const dlg of dialogs) {
            const text = norm(dlg.textContent || '');
            if (!text) continue;
            if (!/\uC54C\uB9BC|alert/i.test(text)) continue;
            if (/\uC785\uCC30\uB2F4\uD569\uC720\uC758\uC0AC\uD56D|\uC704\uC758\uC0AC\uD56D|\uD655\uC778\uD558\uC600\uC2B5\uB2C8\uB2E4/.test(text)) continue;
            const buttons = Array.from(dlg.querySelectorAll('span.x-btn-inner, button, a, [id$="-btnInnerEl"], input[type="button"], input[type="submit"]'));
            for (const b of buttons) {
              const label = norm(b.textContent || b.getAttribute?.('value') || b.getAttribute?.('title') || '');
              if (!/^(\uD655\uC778|\uC608|\uB2EB\uAE30)/.test(label)) continue;
              const target = b.closest?.('a.x-btn, button, .x-btn, [role="button"]') || b;
              try { target.click?.(); } catch {}
              try { target.dispatchEvent?.(new MouseEvent('click', { bubbles: true, cancelable: true })); } catch {}
              count++;
              break;
            }
          }
          return count;
        });
        closed += Number(hit || 0);
      } catch {}
    }
    if (closed > 0) log('info', `[KEPCO] closed blocking info alerts count=${closed}`);
    return closed;
  };

  try {
    const ctx = page.context?.();
    for (const extra of ctx?.pages?.() || []) {
      if (!extra || extra === page || extra.isClosed?.()) continue;
      const url = extra.url?.() || '';
      if (/noticeCollusive|fishing|guidePopup/i.test(url)) {
        try { await extra.close({ runBeforeUnload:true }); log('info', '[KEPCO] Closed unrelated popup: ' + url); } catch {}
      }
    }
  } catch {}

  await confirmYesDialog();
  const checkedStatement = await checkConfirmedStatementBox();
  if (!checkedStatement) {
    await sleep(120);
    await checkConfirmedStatementBox();
  }
  await closeKepcoPostLoginModals(page, emit, { protectWorkflowModal: true });
  await dismissInlineAlerts(true);
  await closeBlockingInfoAlerts();

  if (await detectAlreadyAppliedDialog()) {
    log('info', '[KEPCO] already applied dialog detected');
    return { submitted: false, completed: true, completionReason: 'already_applied', alreadyApplied: true };
  }

  const reachedFinalStage = await waitForFinalStage(6000);
  log('info', '[KEPCO] final stage detected=' + reachedFinalStage);
  if (!reachedFinalStage) {
    await ensureAgreementDump('final_stage_not_ready');
    return { submitted: false, completed: false, completionReason: 'final_stage_not_ready' };
  }

  await closeKepcoPostLoginModals(page, emit, { protectWorkflowModal: true });
  await dismissInlineAlerts();
  await closeBlockingInfoAlerts();
  const checkedByPattern = 0;
  const checkedByFallback = await checkAllVisibleAgreementBoxes();
  if (!checkedByPattern && !checkedByFallback) {
    await ensureAgreementDump('agreement_missing');
  }

  await closeKepcoPostLoginModals(page, emit, { protectWorkflowModal: true });
  await closeBlockingInfoAlerts();

  const uncheckedBeforeSubmit = await detectUncheckedAgreementCount();
  if (uncheckedBeforeSubmit > 0) {
    log('warn', `[KEPCO] unchecked agreements before submit=${uncheckedBeforeSubmit}`);
    await ensureAgreementDump('agreement_unchecked_before_submit');
    return { submitted: false, completed: false, completionReason: `unchecked_before_submit_${uncheckedBeforeSubmit}` };
  }

  let submitted = false;
  for (let submitTry = 0; submitTry < 3 && !submitted; submitTry++) {
    await closeBlockingInfoAlerts();
    submitted = await clickSubmitButton();
    if (!submitted) {
      await sleep(180);
    }
  }
  if (submitted) {
    log('info', '[KEPCO] final submit button clicked');
    await confirmYesDialogsAfterSubmit(12);
    await closeBlockingInfoAlerts();
    await sleep(260);

    const certModalOpen = await hasCertificateModalAfterSubmit();
    if (certModalOpen) {
      log('info', '[KEPCO] post-submit certificate modal detected');
      const certRes = await handleKepcoCertificate(page, emit, cert || {}, {
        site: 'kepco',
        fastMode: options?.kepcoFastMode !== false,
        postSubmit: true
      }).catch((err) => ({ ok: false, error: (err && err.message) || err }));
      if (!certRes?.ok) {
        submitted = false;
        log('warn', `[KEPCO] post-submit certificate failed: ${certRes?.error || 'unknown'}`);
        await ensureAgreementDump('post_submit_certificate_failed');
      } else {
        log('info', '[KEPCO] post-submit certificate completed');
        await closeBlockingInfoAlerts();
        if (await closeCompletionDialogIfPresent()) {
          log('info', '[KEPCO] completion dialog closed right after certificate');
        }
      }
    }

    await sleep(350);
    const uncheckedLeft = await detectUncheckedAgreementCount();
    const hasValidation = await hasSubmitValidationAlert();
    if (uncheckedLeft > 0 || hasValidation) {
      submitted = false;
      log('warn', `[KEPCO] submit validation failed (unchecked=${uncheckedLeft}, validationDialog=${hasValidation})`);
      await ensureAgreementDump('submit_validation_failed');
    }
  }

  let completed = false;
  let completionReason = 'not_submitted';
  if (submitted) {
    const completion = await waitForFinalCompletion(options?.kepcoSubmitCompleteWaitMs || 12000);
    completed = completion?.completed === true;
    completionReason = completion?.reason || 'unknown';
    log(completed ? 'info' : 'warn', `[KEPCO] final completion detected=${completed} reason=${completionReason}`);
    if (!completed) {
      await ensureAgreementDump('final_completion_not_confirmed');
    }
  }

  if (!submitted) {
    const late = await probeLateCompletion(options?.kepcoLateCompletionProbeMs || 5000);
    if (late?.completed) {
      submitted = true;
      completed = true;
      completionReason = late?.reason || 'late_success';
      log('warn', `[KEPCO] submit click not captured but completion detected (${completionReason})`);
    } else {
      log('warn', '[KEPCO] final submit button not found or submit validation failed; manual check required');
      await ensureAgreementDump('submit_button_missing');
    }
  }

  await sleep(200);
  return { submitted, completed, completionReason };
}
async function navigateToApplication(page, emit) {
  const TEXT_BID_CONTRACT = "\uC785\uCC30/\uACC4\uC57D";
  const TEXT_BID_APPLY = "\uC785\uCC30\uCC38\uAC00\uC2E0\uCCAD";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const log = (level, msg) => emit && emit({ type: 'log', level, msg });
  const contexts = () => [page, ...(page.frames?.() || [])];

  async function dumpContextInfo(reason) {
    try {
      const infos = [];
      const push = (label, ctx) => {
        if (!ctx) return;
        try {
          const url = ctx.url?.() || '';
          infos.push(`${label}:${url}`);
        } catch {}
      };
      push('main', page);
      for (const [idx, fr] of (page.frames?.() || []).entries()) {
        push(`frame${idx}`, fr);
      }
      log('debug', `[KEPCO] Context snapshot (${reason}): ${infos.join(' | ')}`);
    } catch {}
  }

  async function findLocator(selectors) {
    for (const ctx of contexts()) {
      for (const sel of selectors) {
        try {
          const locator = ctx.locator(sel);
          if (await locator.count().catch(() => 0)) {
            return locator.first();
          }
        } catch {}
      }
    }
    return null;
  }

  async function waitForLocator(selectors, timeoutMs = 6000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const locator = await findLocator(selectors);
      if (locator) return locator;
      await sleep(200);
    }
    return null;
  }

  async function tryClick(locator) {
    if (!locator) return false;
    try {
      await locator.click({ timeout: 1200 });
      return true;
    } catch {}
    try {
      await locator.click({ force: true, timeout: 1200 });
      return true;
    } catch {}
    try {
      const handle = await locator.elementHandle();
      if (handle) {
        try {
          await handle.click();
        } catch {}
        try {
          await handle.evaluate((el) => {
            el.click();
            el.dispatchEvent?.(new MouseEvent('click', { bubbles: true }));
          });
        } catch {}
        return true;
      }
    } catch {}
    return false;
  }

  async function tryExtTreeClick(targetText) {
    for (const ctx of contexts()) {
      let clicked = false;
      try {
        clicked = await ctx.evaluate((needle) => {
          try {
            if (!window.Ext || !Ext.ComponentQuery) return false;
            const panels = Ext.ComponentQuery.query('treepanel');
            if (!panels || !panels.length) return false;
            const normalized = (needle || '').replace(/\s+/g, '');
            for (const panel of panels) {
              const root = panel.getRootNode?.();
              if (!root) continue;
              let match = null;
              root.cascadeBy?.((node) => {
                if (match) return;
                const text = String(node.get?.('text') ?? node.data?.text ?? '').replace(/\s+/g, '');
                if (text && text.includes(normalized)) {
                  match = node;
                }
              });
              if (!match) continue;
              let current = match;
              while (current) {
                try { current.expand?.(); } catch {}
                current = current.parentNode;
              }
              try { panel.getSelectionModel?.().select(match); } catch {}
              try {
                const view = panel.getView?.();
                panel.fireEvent?.('itemclick', view, match);
                const domNode = view?.getNode(match);
                if (domNode) {
                  const clickable = domNode.querySelector('a, span.x-tree-node-text, span, div');
                  if (clickable) {
                    clickable.click();
                    clickable.dispatchEvent?.(new MouseEvent('click', { bubbles: true }));
                  } else {
                    domNode.click();
                    domNode.dispatchEvent?.(new MouseEvent('click', { bubbles: true }));
                  }
                }
              } catch {}
              return true;
            }
          } catch {}
          return false;
        }, targetText);
      } catch {
        clicked = false;
      }
      if (clicked) return true;
    }
    return false;
  }

  async function tryDomTreeClick(targetText) {
    const selectors = [
      'div.x-tree-node-text',
      'span.x-tree-node-text',
      'div.x-tree-node-text h4',
      'span.x-tree-node-text h4'
    ];
    for (const ctx of contexts()) {
      let clicked = false;
      try {
        clicked = await ctx.evaluate((needle, sels) => {
          const normalized = (needle || '').replace(/\s+/g, '');
          for (const sel of sels) {
            const nodes = Array.from(document.querySelectorAll(sel));
            for (const node of nodes) {
              const text = (node.textContent || '').replace(/\s+/g, '');
              if (!text || !text.includes(normalized)) continue;
              const target = node.closest('.x-tree-node-text') || node;
              target.scrollIntoView?.({ block:'center' });
              target.click();
              target.dispatchEvent?.(new MouseEvent('click', { bubbles:true }));
              const clickable = target.querySelector('a, span, h4');
              if (clickable) {
                clickable.click?.();
                clickable.dispatchEvent?.(new MouseEvent('click', { bubbles:true }));
              }
              return true;
            }
          }
          return false;
        }, targetText, selectors);
      } catch {
        clicked = false;
      }
      if (clicked) return true;
    }
    return false;
  }

  log('info', '[KEPCO] Navigating menu to reach "' + TEXT_BID_APPLY + '".');
  const topSelectors = [
    'span.x-btn-inner:has-text("' + TEXT_BID_CONTRACT + '")',
    'button:has-text("' + TEXT_BID_CONTRACT + '")',
    'a:has-text("' + TEXT_BID_CONTRACT + '")',
    'text=' + TEXT_BID_CONTRACT,
    'xpath=//span[contains(normalize-space(.),"' + TEXT_BID_CONTRACT + '")]',
  ];

  const topButton = await waitForLocator(topSelectors, 8000);
  let topClicked = false;
  if (topButton) {
    topClicked = await tryClick(topButton);
  }
  if (!topClicked) {
    const extClick = await page.evaluate((label) => {
      try {
        const normalized = (label || '').replace(/\s+/g, '');
        if (window.Ext && Ext.ComponentQuery) {
          const btns = Ext.ComponentQuery.query('button');
          for (const btn of btns || []) {
            const text = String(btn.getText?.() || btn.text || '').replace(/\s+/g, '');
            if (text.includes(normalized)) {
              btn.fireEvent?.('click', btn);
              btn.el?.dom?.click?.();
              return true;
            }
          }
        }
        const nodes = Array.from(document.querySelectorAll('a, button, span, div'));
        for (const node of nodes) {
          const text = (node.textContent || '').replace(/\s+/g, '');
          if (text.includes(normalized)) {
            node.click();
            node.dispatchEvent?.(new MouseEvent('click', { bubbles: true }));
            return true;
          }
        }
      } catch {}
      return false;
    }, TEXT_BID_CONTRACT).catch(() => false);
    topClicked = extClick;
  }
  if (!topClicked) {
    await dumpContextInfo('top-menu-miss');
    log('error', '[KEPCO] Unable to locate top menu "' + TEXT_BID_CONTRACT + '".');
    throw new Error('Failed to locate the bid/contract top menu button.');
  }
  await sleep(1200);

  await waitForLocator(
    ['.x-tree-panel', '.x-panel:has(.x-tree-panel)', 'text=' + TEXT_BID_APPLY],
    6000
  );

  log('info', '[KEPCO] Searching left tree for "' + TEXT_BID_APPLY + '".');
  let clickedTree = await tryExtTreeClick(TEXT_BID_APPLY);

  if (!clickedTree) {
    const treeSelectors = [
      'a:has-text("' + TEXT_BID_APPLY + '")',
      'span:has-text("' + TEXT_BID_APPLY + '")',
      'text=' + TEXT_BID_APPLY,
      'xpath=//h4[contains(normalize-space(.),"' + TEXT_BID_APPLY + '")]',
      'xpath=//span[contains(@class,"x-tree-node-text") and contains(normalize-space(.),"' + TEXT_BID_APPLY + '")]',
      'xpath=//div[contains(@class,"x-tree-node-text")]//h4[contains(normalize-space(.),"' + TEXT_BID_APPLY + '")]',
    ];
    const treeNode = await waitForLocator(treeSelectors, 8000);
    if (treeNode) {
      const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
      clickedTree = await tryClick(treeNode);
      await navPromise;
    }
  }

  if (!clickedTree) {
    clickedTree = await tryDomTreeClick(TEXT_BID_APPLY);
    if (clickedTree) log('info', '[KEPCO] DOM fallback tree click succeeded');
  }

  if (!clickedTree) {
    log('error', '[KEPCO] Unable to click "' + TEXT_BID_APPLY + '" in the navigation tree.');
    throw new Error('Failed to navigate to the bid application menu.');
  }

  try {
    await page.waitForLoadState('domcontentloaded');
  } catch {}
  await sleep(300);
  log('info', '[KEPCO] Navigation to bid application menu completed.');
  return true;
}


module.exports = {
  loginKepco,
  handleKepcoCertificate,
  closeKepcoPostLoginModals,
  goToBidApplyAndSearch,
  applyAfterSearch,
  navigateToApplication,
};


