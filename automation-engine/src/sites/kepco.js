"use strict"

const fs = require('fs');
const path = require('path');
const { handleNxCertificate } = require('./nxCertificate');

const KEPCO_POPUP_URL_PATTERNS = [/\/popup\//i, /NoticeFishingPopup/i, /Kepco.*Popup/i];

async function dumpKepcoHtml(page, emit, tag){
  if (!page) return;
  try {
    const html = await page.content();
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    const dir = path.join(process.cwd(), 'engine_runs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${stamp}_${tag || 'kepco'}.html`);
    fs.writeFileSync(file, html, 'utf-8');
    emit && emit({ type:'log', level:'info', msg:`[KEPCO] HTML 덤프 저장: ${file}` });
  } catch (err) {
    emit && emit({ type:'log', level:'warn', msg:`[KEPCO] HTML 덤프 실패: ${(err && err.message) || err}` });
  }
}
async function loginKepco(page, emit, auth = {}) {
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
    for (const sel of candidates) {
      const el = await targetPage.$(sel).catch(() => null) || await $(sel);
      if (!el) continue;
      emit && emit({ type: 'log', level: 'info', msg: `[KEPCO] 클릭 시도: ${sel}` });
      const popupPromise = targetPage.waitForEvent('popup', { timeout: 1500 }).catch(() => null);
      await el.click().catch(() => {});
      const popup = await popupPromise;
      if (popup) {
        await popup.waitForLoadState('domcontentloaded').catch(() => {});
        const title = (await popup.title().catch(()=>'')) || '';
        const url = popup.url?.() || '';
        // Ignore notice popups (handled by auto-closer); stay on current page
        if (/\uACF5\uC9C0|\uC548\uB0B4|\uC774\uBCA4\uD2B8/i.test(title) || /popup/i.test(url) || popup.isClosed()) {
          emit && emit({ type:'log', level:'info', msg:`[KEPCO] 안내 팝업 닫힘 (title='${title}')` });
          try { if (!popup.isClosed()) await popup.close({ runBeforeUnload:true }); } catch {}
        } else {
          emit && emit({ type: 'log', level: 'info', msg: '[KEPCO] 새로운 팝업으로 전환' });
          return popup;
        }
      }
      // Give modal animations a brief moment
      await targetPage.waitForTimeout(80).catch(()=>{});
      continue;
    }
    try {
      const locator = targetPage.getByRole?.('link', { name: /\uB85C\uADF8\uC778/i });
      if (locator && await locator.count().catch(()=>0)) {
        emit && emit({ type:'log', level:'info', msg:'[KEPCO] 링크 역할 기반 로그인 클릭' });
        const popup = await targetPage.waitForEvent('popup', { timeout: 1500 }).catch(()=>null);
        await locator.first().click().catch(()=>{});
        return popup;
      }
    } catch {}
    return null;
  }

  // 1) Top navigation login link/button click
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
  const popup = await clickWithPopup(page, loginLinkCandidates);
  const loginPage = popup || page;
  // Ensure alert dialogs don't block automation
  try { loginPage.on('dialog', d => d.dismiss().catch(()=>{})); } catch {}
  await loginPage.waitForLoadState('domcontentloaded').catch(()=>{});

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
      const resolveModalScope = async (timeoutMs = 4500) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          for (const c of containerSel) {
            try {
              const found = await loginPage.$(c);
              if (found) return found;
            } catch {}
          }
          await loginPage.waitForTimeout(120).catch(()=>{});
        }
        return null;
      };
      const modalScope = await resolveModalScope();
      if (modalScope) scope = modalScope;

      const loginFieldConfig = {
        id: {
          labels: [/\uC544\uC774\uB514/i],
          selectors: [
            'input[placeholder*="\uC544\uC774\uB514" i]',
            'input[title*="\uC544\uC774\uB514" i]',
            'input[name*="id" i]', 'input[id*="id" i]', 'input[name*="userid" i]',
            'input[type="text"]'
          ]
        },
        pw: {
          labels: [/\uBE44\uBC00\uBC88\uD638|\uBE44\uBC88/i],
          selectors: [
            'input[placeholder*="\uBE44\uBC00\uBC88\uD638" i]',
            'input[title*="\uBE44\uBC00\uBC88\uD638" i]',
            'input[type="password"]', 'input[name*="pw" i]', 'input[id*="pw" i]'
          ]
        }
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

      async function locateFields(timeoutMs = 5000) {
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
                if (el) return el;
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
                  if (handle) return handle;
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
          await loginPage.waitForTimeout(80).catch(()=>{});
        }
        return located;
      }

      let { id: idField, pw: pwField } = await locateFields();
      if (!idField || !pwField) {
        emit && emit({ type:'log', level:'warn', msg:'[KEPCO] ID/PW 입력 필드 탐색 재시도 (팝업 정리 후)' });
        try { await closeKepcoPostLoginModals(loginPage, emit, { abortOnCertModal: true }); } catch {}
        await loginPage.waitForTimeout(300).catch(()=>{});
        const retry = await locateFields(4000);
        idField ||= retry.id;
        pwField ||= retry.pw;
      }

      const setInputValue = async (handle, value) => {
        if (!handle) return false;
        const text = String(value ?? '');
        try { await handle.focus(); } catch {}
        try { await handle.fill(''); } catch {}
        try { await handle.fill(text); return true; } catch {}
        try { await handle.type(text, { delay: 8 }); return true; } catch {}
        return false;
      };

      if (idField && pwField) {
        await setInputValue(idField, auth.id);
        await setInputValue(pwField, auth.pw);
        // Verify values set; if not, force via DOM
        const ok = await loginPage.evaluate((i, p) => {
          const get = (h) => h && (h.value ?? '');
          return { id: get(i), pw: get(p) };
        }, idField, pwField).catch(()=>({id:'',pw:''}));
        if (!ok.id || !ok.pw) {
          await loginPage.evaluate((i, p, vid, vpw) => {
            if (i) { i.value = vid; i.dispatchEvent(new Event('input', { bubbles:true })); }
            if (p) { p.value = vpw; p.dispatchEvent(new Event('input', { bubbles:true })); }
          }, idField, pwField, String(auth.id), String(auth.pw)).catch(()=>{});
        }
        // Try click submit, avoid cert/phone buttons
        const submitSel = [
          'button[type="submit"]',
          'input[type="submit"]',
          'button:has-text("\uB85C\uADF8\uC778")',
          // avoid header/footer generic links
        ];
        let submit = null;
        for (const s of submitSel) {
          const cand = await scope.$(s);
          if (!cand) continue;
          const txt = (await cand.textContent().catch(()=>'')) || '';
          if (/\uACF5\uB3D9|\uD734\uB300/.test(txt)) continue; // exclude cert/phone login
          submit = cand; break;
        }
        if (submit) {
          const nav = loginPage.waitForNavigation({ waitUntil: 'load', timeout: 8000 }).catch(() => null);
          await submit.click().catch(()=>{});
          await nav;
        } else {
          try { await pwField.focus(); await pwField.press('Enter'); } catch {}
          await loginPage.waitForNavigation({ waitUntil:'load', timeout: 10000 }).catch(()=>{});
        }
        emit && emit({ type:'log', level:'info', msg:'[KEPCO] ID/PW \uB85C\uADF8\uC778 \uC2DC\uB3C4 \uC644\uB8CC' });
        return popup || null;
      }
      emit && emit({ type:'log', level:'warn', msg:'[KEPCO] ID/PW \uC785\uB825 \uD544\uB4DC \uD0D0\uC0C9 \uC2E4\uD328' });
      throw new Error('[KEPCO] \uB85C\uADF8\uC778 \uC785\uB825 \uD544\uB4DC \uD0D0\uC0C9 \uC2E4\uD328');
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
    'button:has-text("닫기")',
    'a:has-text("닫기")',
    'input[type="button"][value*="닫기" i]',
    'button:has-text("확인")',
    'a:has-text("확인")',
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
      emit && emit({ type:'log', level:'info', msg:`[KEPCO] 팝업 페이지 강제 종료: ${url}` });
      return true;
    } catch {}
    return false;
  }

  const abortOnCertModal = options.abortOnCertModal === true;
  const certSelectors = ['#nx-cert-select', '.nx-cert-select', '#browser-guide-added-wrapper', '#nx-cert-select-wrap'];

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
    'label:has-text("오늘 하루 이 창 열지 않기")',
    'label:has-text("하루 동안 보지 않기")',
    '.auclose input[type="checkbox"]',
    'input[type="checkbox"][name*="today" i]',
    'input[type="checkbox"][id*="today" i]',
    '#todayCheck',
    '#reopenCheck'
  ];
  for (let attempt = 0; attempt < 5; attempt++) {
    let closed = false;
    if (await hasCertificateModal()) {
      emit && emit({ type:'log', level:'debug', msg:'[KEPCO] 인증서 모달 감지로 공지 닫기 루틴을 중단합니다.' });
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
              emit && emit({ type:'log', level:'info', msg:`[KEPCO] 팝업 '오늘 하루 보지 않기' 체크: ${chkSel}` });
            }
          }
        } catch {}
      }
      for (const sel of selectors) {
        try {
          const btns = await ctx.$$(sel);
          if (btns && btns.length) {
            for (const btn of btns) {
              if (handledElements.has(btn)) continue;
              await btn.click({ force: true }).catch(()=>{});
              handledElements.add(btn);
              closed = true;
              emit && emit({ type:'log', level:'info', msg:`[KEPCO] 공지/모달 닫기: ${sel}` });
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
      emit && emit({ type: 'log', level: 'info', msg: `[KEPCO] 별도 창 강제 종료: ${url}` });
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
    const tryLabels = async (ctx) => {
      if (!ctx.getByLabel) return null;
      for (const label of BID_LABELS){
        try {
          const loc = ctx.getByLabel(label);
          if (loc && await loc.count().catch(()=>0)) {
            const handle = await loc.first().elementHandle();
            if (handle && await isUsableInput(handle)) return handle;
          }
        } catch {}
      }
      return null;
    };
    const trySelectors = async (ctx) => {
      for (const sel of BID_INPUT_SELECTORS){
        try {
          const el = await ctx.$(sel);
          if (el && await isUsableInput(el)) return el;
        } catch {}
      }
      return null;
    };
    for (const ctx of contexts()){
      const byLabel = await tryLabels(ctx);
      if (byLabel) return byLabel;
      const bySelector = await trySelectors(ctx);
      if (bySelector) return bySelector;
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
      const comp = Ext.ComponentQuery.query('textfield[title*=\uACF5\uACE0][isVisible()]')[0]
        || Ext.ComponentQuery.query('textfield[name*=bid], textfield[id*=bid]')[0];
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
    log('warn', `[KEPCO] 공고번호 입력 검증 실패 (현재='${finalValue}')`);
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

async function applyAfterSearch(page, emit){
  const APPLY_BUTTON_TEXT = '\uC785\uCC30\uCC38\uAC00\uC2E0\uCCAD';
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  async function inFrames(run){
    const ctxs = [page, ...page.frames?.() || []];
    for (const ctx of ctxs){
      try { const res = await run(ctx); if (res) return res; } catch {}
    }
    return null;
  }
  async function waitInFrames(predicate, timeoutMs=8000){
    const start = Date.now();
    while(Date.now() - start < timeoutMs){
      const hit = await inFrames(predicate);
      if (hit) return hit;
      await sleep(200);
    }
    return null;
  }
  async function waitForNoMask(timeoutMs=6000){
    const start = Date.now();
    while(Date.now() - start < timeoutMs){
      const masked = await inFrames(async (ctx)=>{
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
      } catch (err) {
        return false;
      }
    });
  }

  const findApplyButton = async (ctx) => {
    try {
      const handle = await ctx.evaluateHandle((text) => {
        const isValidBtn = (node) => {
          if (!node) return null;
          const btn = node.closest('a.x-btn, button, .x-btn') || node;
          if (!btn) return null;
          const label = (btn.textContent || '').replace(/\s+/g,'');
          if (label.indexOf('취소') !== -1) return null;
          if (label.indexOf(text) !== -1) return btn;
          if (btn.querySelector && btn.querySelector('.btn-request')) return btn;
          return null;
        };
        const icons = Array.from(document.querySelectorAll('.x-toolbar-docked-bottom .btn-request'));
        for (const icon of icons){
          const btn = isValidBtn(icon);
          if (btn) return btn;
        }
        const toolbarButtons = Array.from(document.querySelectorAll('.x-toolbar-docked-bottom .x-btn, .x-toolbar-docked-bottom button'));
        for (const btn of toolbarButtons) {
          const hit = isValidBtn(btn) || isValidBtn(btn.querySelector('.x-btn-inner, span'));
          if (hit) return hit;
        }
        return null;
      }, APPLY_BUTTON_TEXT);
      return handle.asElement?.() || null;
    } catch {
      return null;
    }
  };

  // 1) Grid checkbox + "입찰참가신청" 버튼 빠른 경로
  // Fast path heuristic: checkbox + "입찰참가신청" button inside same panel
  async function fastPath() {
    const ctx = await inFrames(async (f)=>{
      try {
        const hasChk = await f.$('.x-grid-row-checker');
        const hasBtn = await findApplyButton(f);
        return (hasChk && hasBtn) ? f : null;
      } catch { return null; }
    });
    if (!ctx) return false;
    try {
      // 1) Ensure checkbox is checked and row selected
      const chk = await ctx.$('.x-grid-row-checker');
      await chk.scrollIntoViewIfNeeded?.().catch(()=>{});
      await chk.click({ force:true }).catch(()=>{});
      await sleep(120);
      // Fallback: force select first grid row if selection missing
      let selected = await ctx.$('.x-grid-row-selected, tr.x-grid-row-selected').catch(()=>null);
      if (!selected) {
        const first = await ctx.$('.x-grid-row, tr.x-grid-row').catch(()=>null);
        if (first) { try { await first.click({ force:true }).catch(()=>{}); } catch {} }
        await sleep(80);
        selected = await ctx.$('.x-grid-row-selected, tr.x-grid-row-selected').catch(()=>null);
      }
      // 2) Find clickable button (resolve wrapper element)
      let target = await findApplyButton(ctx);
      if (target) {
        try {
          const clickableHandle = await target.evaluateHandle((node)=> (node.closest('a.x-btn, button, .x-btn') || node));
          const clickableEl = clickableHandle.asElement?.();
          if (clickableEl) target = clickableEl;
        } catch {}
        await target.scrollIntoViewIfNeeded?.().catch(()=>{});
        await target.click({ force:true }).catch(()=>{});
        emit && emit({ type:'log', level:'info', msg:'[KEPCO] fastPath: "\uC785\uCC30\uCC38\uAC00\uC2E0\uCCAD" \uBC84\uD2BC \uD074\uB9AD' });
        return true;
      }
    } catch {}
    return false;
  }

  const fast = await fastPath();
  if (fast) {
    // If fast path offers modal context use it, otherwise fall back below
    const modalCtx = await waitInFrames(async (ctx)=>{
      try {
        return await ctx.$('.x-window') || await ctx.$('label:has-text("\uB3D9\uC758 \uC0AC\uD56D")');
      } catch { return null; }
    }, 1500);
    if (modalCtx) {
      // Modal handling routine below remains active as fallback
    } else {
      emit && emit({ type:'log', level:'warn', msg:'[KEPCO] fastPath modal not detected, running fallback' });
    }
  }

  // Alternate flow (legacy logic)
  const extSelected = await ensureGridSelectionViaExt();
  if (extSelected) {
    emit && emit({ type:'log', level:'info', msg:'[KEPCO] Grid selection ensured via Ext.ComponentQuery' });
  }
  const checker = await waitInFrames(async (ctx)=>{
    const el = await ctx.$('.x-grid-row-checker').catch(()=>null)
           || await ctx.$('div.x-grid-row-checker[role="presentation"]').catch(()=>null);
    if (el) return { ctx, el };
    return null;
  }, 6000);
  if (checker){
    if (!extSelected) {
      try { await checker.el.click({ force:true }).catch(()=>{}); } catch {}
      try { await checker.ctx.evaluate((e)=>{ e.click(); }, checker.el).catch(()=>{}); } catch {}
      emit && emit({ type:'log', level:'info', msg:'[KEPCO] Grid checkbox click' });
      await sleep(200);
    }
    // Ensure row is selected: click first grid row if no selection class
    await inFrames(async (ctx)=>{
      const selectors = ['.x-grid-row.x-grid-row-selected', 'tr.x-grid-row-selected', '.x-grid-item-selected'];
      for (const sel of selectors){
        const selected = await ctx.$(sel).catch(()=>null);
        if (selected) return false;
      }
      const first = await ctx.$('.x-grid-row, tr.x-grid-row, .x-grid-item').catch(()=>null);
      if (first) { try { await first.click({ force:true }).catch(()=>{}); } catch {} }
      return false;
    });
    // Try to scroll the grid bottom toolbar into view
    await inFrames(async (ctx)=>{
      try { const grid = await ctx.$('.x-grid'); if (grid){ await grid.scrollIntoViewIfNeeded?.().catch(()=>{}); } } catch {}
      return false;
    });
  } else if (!extSelected) {
    emit && emit({ type:'log', level:'warn', msg:'[KEPCO] Failed to locate grid checkbox' });
  }

  // 2) Click "입찰참가신청" button
  const btn = await waitInFrames(async (ctx)=>{
    try {
      const handle = await ctx.evaluateHandle((text) => {
        const matches = (node) => {
          if (!node) return null;
          const content = (node.textContent || '').replace(/\s+/g,'').trim();
          if (content.indexOf(text) === -1) return null;
          const btn = node.closest('a.x-btn, button, .x-btn');
          if (btn && btn.textContent && btn.textContent.indexOf('\uCDE8\uC18C') !== -1) return null;
          return btn || node;
        };
        const findIn = (root) => {
          if (!root) return null;
          const toolbar = root.querySelector('.x-toolbar-docked-bottom');
          const scopes = toolbar ? [toolbar] : [root];
          for (const scope of scopes) {
            const nodes = scope.querySelectorAll('.x-btn-inner, .x-btn, button, a, span');
            for (const node of nodes) {
              const hit = matches(node);
              if (hit) return hit;
            }
          }
          const requestBtn = root.querySelector('.x-toolbar-docked-bottom .btn-request');
          return matches(requestBtn);
        };
        const direct = document.querySelector('.x-toolbar-docked-bottom .btn-request')
          || document.querySelector('.x-toolbar-docked-bottom a.x-btn');
        if (matches(direct)) return direct.closest('a.x-btn, button, .x-btn') || direct;
        const selected = document.querySelector('.x-grid-row-selected, tr.x-grid-row-selected');
        const base = selected ? selected.closest('.x-panel') : document.querySelector('.x-panel');
        let cand = findIn(base);
        if (!cand) cand = findIn(document.body);
        if (!cand) {
          const extras = Array.from(document.querySelectorAll('[id^="button-"][id$="-btnInnerEl"], [id^="button-"][id$="-btnEl"], .x-toolbar-docked-bottom .x-btn-inner'));
          for (const node of extras) {
            const hit = matches(node);
            if (hit) { cand = hit; break; }
          }
        }
        return cand || null;
      }, APPLY_BUTTON_TEXT);

      if (handle) return { ctx, el: handle.asElement?.() || handle };
    } catch {}
    return null;
  }, 8000);
  if (btn){
    // Prefer Ext handler call first to avoid focus/selection toggling
    await inFrames(async (ctx)=>{
      try {
        await ctx.evaluate((text) => {
          try {
            if (window.Ext){
              const tryClick = (cmp) => {
                if (!cmp) return;
                try { cmp.setDisabled && cmp.setDisabled(false); } catch(e){}
                try { cmp.focus && cmp.focus(); } catch(e){}
                try { cmp.fireEvent && cmp.fireEvent('click'); } catch(e){}
                try { cmp.handler && cmp.handler.call(cmp); } catch(e){}
              };
              let targetCmp = null;
              if (Ext.ComponentQuery){
                let arr = Ext.ComponentQuery.query('toolbar[dock="bottom"] button');
                if (arr && arr.length){
                  for (let i=0;i<arr.length;i++){
                    const candidate = arr[i];
                    const label = (candidate && (candidate.text || candidate.ariaLabel || (candidate.el && candidate.el.dom && candidate.el.dom.textContent))) || '';
                    if (label && label.indexOf(text) > -1) { targetCmp = candidate; break; }
                  }
                }
                if (!targetCmp){
                  arr = Ext.ComponentQuery.query('button');
                  if (arr && arr.length){
                    for (let j=0;j<arr.length;j++){
                      const candidate = arr[j];
                      const label = (candidate && (candidate.text || candidate.ariaLabel || (candidate.el && candidate.el.dom && candidate.el.dom.textContent))) || '';
                      if (label && label.indexOf(text) > -1) { targetCmp = candidate; break; }
                    }
                  }
                }
              }
              if (!targetCmp && Ext.ComponentManager && Ext.ComponentManager.each){
                Ext.ComponentManager.each(function(item){
                  if (targetCmp) return;
                  try {
                    const label = (item && (item.text || item.ariaLabel || (item.el && item.el.dom && item.el.dom.textContent))) || '';
                    if (label && label.indexOf(text) > -1) { targetCmp = item; }
                  } catch(e){}
                });
              }
              tryClick(targetCmp);
            }
          } catch(e){}
        }, APPLY_BUTTON_TEXT);
      } catch {}
      return false;
    });

    await waitForNoMask(8000);
    // Scroll into view and try multiple event paths (ExtJS-friendly)
    try { await btn.el.scrollIntoViewIfNeeded?.().catch(()=>{}); } catch {}
    try { await btn.el.click({ force:true }).catch(()=>{}); } catch {}
    try { await btn.el.dblclick?.({ force:true }).catch(()=>{}); } catch {}
    // If still no modal, click by absolute coordinates as last resort
    try {
      const box = await btn.el.boundingBox?.();
      if (box) {
        await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
        await page.mouse.down(); await page.mouse.up();
        await sleep(120);
      }
    } catch {}
    // click wrapper and specific inner ids if exist
    try { await btn.ctx.evaluate((e, text)=>{
      const fire = (node)=>{
        if(!node) return;
        ['mouseover','mousedown','mouseup','click'].forEach(t=>node.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true}))); };
      const matchText = (node)=>!!(node && (node.textContent || '').indexOf(text) > -1);
      const root = e.closest ? e.closest('a.x-btn, button, .x-btn') || e : e;
      let inner = null;
      const direct = document.querySelector('.x-toolbar-docked-bottom .btn-request');
      if (!inner && matchText(direct)) inner = direct;
      if (root && root.querySelector){
        const found = Array.from(root.querySelectorAll('.x-btn-inner, span')).find(matchText);
        if (found) inner = found;
      }
      if (!inner){
        inner = Array.from(document.querySelectorAll('.x-btn-inner, .x-btn, button, a')).find(matchText) || null;
      }
      fire(root); fire(inner);
      if (window.Ext){
        const tryClick = (cmp)=>{
          if (!cmp) return;
          try { cmp.setDisabled && cmp.setDisabled(false); } catch(e){}
          try { cmp.focus && cmp.focus(); } catch(e){}
          try { cmp.fireEvent && cmp.fireEvent('click'); } catch(e){}
          try { cmp.handler && cmp.handler.call(cmp); } catch(e){}
        };
        let targetCmp = null;
        if (Ext.ComponentQuery){
          let arr = Ext.ComponentQuery.query('toolbar[dock="bottom"] button');
          if (arr && arr.length){
            for (let i=0;i<arr.length;i++){
              const candidate = arr[i];
              const label = (candidate && (candidate.text || candidate.ariaLabel || (candidate.el && candidate.el.dom && candidate.el.dom.textContent))) || '';
              if (label && label.indexOf(text) > -1){ targetCmp = candidate; break; }
            }
          }
          if (!targetCmp){
            arr = Ext.ComponentQuery.query('button');
            if (arr && arr.length){
              for (let j=0;j<arr.length;j++){
                const candidate = arr[j];
                const label = (candidate && (candidate.text || candidate.ariaLabel || (candidate.el && candidate.el.dom && candidate.el.dom.textContent))) || '';
                if (label && label.indexOf(text) > -1){ targetCmp = candidate; break; }
              }
            }
          }
        }
        if (!targetCmp && Ext.ComponentManager && Ext.ComponentManager.each){
          Ext.ComponentManager.each(function(item){
            if (targetCmp) return;
            try {
              const label = (item && (item.text || item.ariaLabel || (item.el && item.el.dom && item.el.dom.textContent))) || '';
              if (label && label.indexOf(text) > -1){ targetCmp = item; }
            } catch(err){}
          });
        }
        tryClick(targetCmp);
      }
    }, btn.el, APPLY_BUTTON_TEXT).catch(()=>{}); } catch {}
    // Keyboard fallback (focus toolbar then press Enter/Space)
    try { await btn.el.focus?.().catch(()=>{}); await btn.el.press?.('Enter').catch(()=>{}); await btn.el.press?.(' ').catch(()=>{}); } catch {}
    emit && emit({ type:'log', level:'info', msg:'[KEPCO] "\uC785\uCC30\uCC38\uAC00\uC2E0\uCCAD" \uBC84\uD2BC \uD074\uB9AD \uC644\uB8CC' });
    // Wait briefly for modal to appear
    const modal = await waitInFrames(async (ctx)=>{ try { return await ctx.$('.x-window'); } catch { return null; } }, 1500);
    if (!modal) {
      emit && emit({ type:'log', level:'warn', msg:'[KEPCO] apply button clicked but follow-up modal was not detected' });
      await dumpKepcoHtml(page, emit, 'apply_modal_missing');
    }
    await sleep(300);
  } else {
    emit && emit({ type:'log', level:'warn', msg:'[KEPCO] "\uC785\uCC30\uCC38\uAC00\uC2E0\uCCAD" \uBC84\uD2BC\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.' });
  }

  await handleFinalAgreementAndSubmit(page, emit);
}

async function handleFinalAgreementAndSubmit(page, emit){
  const log = (level,msg)=>emit && emit({ type:'log', level, msg });
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  const AGREEMENT_PATTERNS = [
    /\uACF5\uAE09\uC790.*\uD589\uB3D9\uAC15\uB839.*\uB3D9\uC758/i,
    /\uCCAD\uB7C9\uACC4\uC57D.*\uC774\uD589\uAC01\uC11C.*\uB3D9\uC758/i,
    /\uC870\uC138\uD3EC\uD0AC.*\uC11C\uC57D\uC11C.*\uB3D9\uC758/i,
    /\uC704\uC758\uC0AC\uD56D.*\uD655\uC778\uD588\uC2B5\uB2C8\uB2E4/i
  ];
  const SUBMIT_SELECTOR = '#button-1693-btnInnerEl, span.x-btn-inner:has-text("\uC81C\uCD9C"), button:has-text("\uC81C\uCD9C"), a:has-text("\uC81C\uCD9C")';
  const contexts = () => [page, ...(page.frames?.() || [])];
  let dumpedAgreementState = false;
  const ensureAgreementDump = async (tag = 'agreement_missing') => {
    if (dumpedAgreementState) return;
    dumpedAgreementState = true;
    await dumpKepcoHtml(page, emit, tag);
  };

  // Close newly opened popup windows (공정위 안내 등)
  try {
    const ctx = page.context?.();
    for (const extra of ctx?.pages?.() || []) {
      if (!extra || extra === page || extra.isClosed?.()) continue;
      const url = extra.url?.() || '';
      if (/bidAttendPopup|noticeCollusive|Popup/i.test(url)) {
        try { await extra.close({ runBeforeUnload:true }); log('info', `[KEPCO] 팝업 창 닫기: ${url}`); } catch {}
      }
    }
  } catch {}

  const dismissInlineAlerts = async () => {
    for (const ctx of contexts()) {
      try {
        const buttons = await ctx.$$(`button:has-text("확인"), a:has-text("확인"), span.x-btn-inner:has-text("확인")`);
        for (const btn of buttons || []) await btn.click({ force:true }).catch(()=>{});
      } catch {}
    }
  };

  const checkAgreement = async (pattern) => {
    const normalized = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
    for (const ctx of contexts()) {
      try {
        const matched = await ctx.evaluate((regexStr) => {
          const regex = new RegExp(regexStr, 'i');
          const nodes = Array.from(document.querySelectorAll('label, span, div'));
          for (const node of nodes) {
            const text = (node.textContent || '').replace(/\s+/g,'');
            if (!text || !regex.test(text)) continue;
            const checkbox = node.querySelector('input[type="checkbox"]')
              || node.closest('tr, div, label')?.querySelector('input[type="checkbox"]')
              || document.querySelector('input[type="checkbox"]');
            if (checkbox) {
              checkbox.click();
              checkbox.checked = true;
              checkbox.dispatchEvent(new Event('change', { bubbles:true }));
              return true;
            }
          }
          return false;
        }, normalized.source);
        if (matched) {
          log('info', `[KEPCO] 동의 체크 완료: ${pattern}`);
          return true;
        }
      } catch {}
    }
    log('warn', `[KEPCO] 동의 체크박스를 찾지 못했습니다: ${pattern}`);
    return false;
  };

  await dismissInlineAlerts();
  let checked = 0;
  for (const label of AGREEMENT_PATTERNS) {
    if (await checkAgreement(label)) checked++;
  }
  let fallbackTouchedTotal = 0;
  if (!checked) {
    for (const ctx of contexts()) {
      try {
        const touched = await ctx.evaluate(() => {
          const boxes = Array.from(document.querySelectorAll('.x-window input[type="checkbox"], .x-panel input[type="checkbox"], input[type="checkbox"]'));
          let count = 0;
          for (const cb of boxes) {
            if (cb.disabled) continue;
            if (!cb.checked) {
              cb.click();
              cb.checked = true;
              cb.dispatchEvent(new Event('change', { bubbles:true }));
              count++;
            }
          }
          return count;
        });
        if (touched > 0) {
          log('info', `[KEPCO] 텍스트 매칭 실패로 ${touched}개의 체크박스를 일괄 선택했습니다.`);
          fallbackTouchedTotal += touched;
          break;
        }
        fallbackTouchedTotal += touched;
      } catch {}
    }
  }
  if (!checked && fallbackTouchedTotal === 0) {
    await ensureAgreementDump('agreement_missing');
  }

  let submitted = false;
  for (const ctx of contexts()) {
    try {
      const btn = await ctx.$(SUBMIT_SELECTOR);
      if (btn) {
        await btn.scrollIntoViewIfNeeded?.().catch(()=>{});
        await btn.click({ force:true }).catch(()=>{});
        log('info', '[KEPCO] 최종 "제출" 버튼 클릭');
        submitted = true;
        break;
      }
    } catch {}
  }
  if (!submitted) {
    log('warn', '[KEPCO] 최종 제출 버튼을 찾지 못했습니다. 수동 확인 필요');
    await ensureAgreementDump('submit_button_missing');
  }
  await sleep(200);
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
