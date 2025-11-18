"use strict"

const { handleNxCertificate } = require('./nxCertificate');
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
      await targetPage.waitForTimeout(200).catch(()=>{});
      return null;
    }
    return null;
  }

  // 1) Top navigation login link/button click
  const loginLinkCandidates = [
    'header a:has-text("\uB85C\uADF8\uC778")',
    'a[href*="login" i]',
    'text=/\uB85C\uADF8\uC778/i'
  ];
  const popup = await clickWithPopup(page, loginLinkCandidates);
  const loginPage = popup || page;
  // Ensure alert dialogs don't block automation
  try { loginPage.on('dialog', d => d.dismiss().catch(()=>{})); } catch {}
  await loginPage.waitForLoadState('domcontentloaded').catch(()=>{});

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
      for (const c of containerSel) { const found = await loginPage.$(c); if (found) { scope = found; break; } }

      // Prefer label-based resolution across frames
      async function findByLabel(labelRegex){
        // try in current page and all frames
        const frames = [loginPage, ...loginPage.frames?.() || []];
        for (const ctx of frames){
          try {
            const loc = ctx.getByLabel(labelRegex);
            if (await loc.count()) return loc.first();
          } catch {}
        }
        return null;
      }

      let idLoc = await findByLabel(/\uC544\uC774\uB514/i);
      let pwLoc = await findByLabel(/\uBE44\uBC00\uBC88\uD638|\uBE44\uBC88/i);

      // Candidate selectors including placeholder/title
      const idCandidates = [
        'input[placeholder*="\uC544\uC774\uB514" i]',
        'input[title*="\uC544\uC774\uB514" i]',
        'input[name*="id" i]', 'input[id*="id" i]', 'input[name*="userid" i]', 'input[type="text"]'
      ];
      const pwCandidates = [
        'input[placeholder*="\uBE44\uBC00\uBC88\uD638" i]',
        'input[title*="\uBE44\uBC00\uBC88\uD638" i]',
        'input[type="password"]', 'input[name*="pw" i]', 'input[id*="pw" i]'
      ];

      async function findInFrames(cands){
        const frames = [loginPage, ...loginPage.frames?.() || []];
        for (const sel of cands){
          for (const f of frames){
            try { const e = await f.$(sel); if (e) return e; } catch {}
          }
        }
        return null;
      }

      // Wait briefly for modal inputs to mount
      let idField = (idLoc ? await idLoc.elementHandle().catch(()=>null) : null) || await findInFrames(idCandidates);
      if (!idField) { try { await loginPage.waitForSelector(idCandidates.join(', '), { timeout: 1500 }); idField = await findInFrames(idCandidates); } catch {} }
      let pwField = (pwLoc ? await pwLoc.elementHandle().catch(()=>null) : null) || await findInFrames(pwCandidates);
      if (!pwField) { try { await loginPage.waitForSelector(pwCandidates.join(', '), { timeout: 1500 }); pwField = await findInFrames(pwCandidates); } catch {} }

      if (idField && pwField) {
        try { await idField.focus(); } catch {}
        await idField.fill('');
        await idField.type(String(auth.id), { delay: 50 }).catch(()=>idField.fill(String(auth.id)));
        try { await pwField.focus(); } catch {}
        await pwField.fill('');
        await pwField.type(String(auth.pw), { delay: 50 }).catch(()=>pwField.fill(String(auth.pw)));
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
  return handleNxCertificate('KEPCO', page, emit, cert, extra);
}
async function closeKepcoPostLoginModals(page, emit){
  const selectors = [
    '.x-tool-close',
    '.x-window .x-tool-close',
    'button:has-text("닫기")',
    'a:has-text("닫기")',
    'button:has-text("확인")',
    'a:has-text("확인")',
    '.popup-close',
    '.btn-close',
    'span[onclick*="close"]',
    'button.btn-popup-close'
  ];
  const contexts = () => [page, ...(page.frames?.() || [])];
  const checkSelectors = [
    'label:has-text("오늘 하루 이 창 열지 않기")',
    'input[type="checkbox"][name*="today" i]',
    'input[type="checkbox"][id*="today" i]'
  ];
  for (let attempt = 0; attempt < 3; attempt++) {
    let closed = false;
    for (const ctx of contexts()) {
      for (const chkSel of checkSelectors) {
        try {
          const chk = await ctx.$(chkSel);
          if (chk) {
            await chk.click({ force:true }).catch(()=>{});
            emit && emit({ type:'log', level:'info', msg:`[KEPCO] 팝업 '오늘 하루 보지 않기' 체크: ${chkSel}` });
          }
        } catch {}
      }
      for (const sel of selectors) {
        try {
          const btn = await ctx.$(sel);
          if (btn) {
            await btn.click({ force: true }).catch(()=>{});
            closed = true;
            emit && emit({ type:'log', level:'info', msg:`[KEPCO] 공지/모달 닫기: ${sel}` });
          }
        } catch {}
      }
    }
    if (!closed) break;
    await page.waitForTimeout(200).catch(()=>{});
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
    'input[name*="bid" i]',
    'input[id*="bid" i]',
    'input[name*="gonggo" i]',
    'input[id*="gonggo" i]',
    'input[id*="textfield" i]'
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

  async function findInputHandle(){
    const tryLabels = async (ctx) => {
      if (!ctx.getByLabel) return null;
      for (const label of BID_LABELS){
        try {
          const loc = ctx.getByLabel(label);
          if (loc && await loc.count().catch(()=>0)) {
            const handle = await loc.first().elementHandle();
            if (handle) return handle;
          }
        } catch {}
      }
      return null;
    };
    const trySelectors = async (ctx) => {
      for (const sel of BID_INPUT_SELECTORS){
        try {
          const el = await ctx.$(sel);
          if (el) return el;
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
    return;
  }
  try {
    await input.scrollIntoViewIfNeeded?.().catch(()=>{});
    await input.fill('');
    await input.type(String(bidId), { delay: 40 }).catch(()=>input.fill(String(bidId)));
  } catch {
    log('warn', '[KEPCO] \uC785\uCC30\uACF5\uACE0\uBC88\uD638 \uC785\uB825\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.');
  }
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

  // 1) Grid checkbox + "입찰참가신청" 버튼 빠른 경로
  // Fast path heuristic: checkbox + "입찰참가신청" button inside same panel
  async function fastPath() {
    const ctx = await inFrames(async (f)=>{
      try {
        const hasChk = await f.$('.x-grid-row-checker');
        const hasBtn = await f.$(`button:has-text("${APPLY_BUTTON_TEXT}")`).catch(()=>null)
                    || await f.$(`a:has-text("${APPLY_BUTTON_TEXT}")`).catch(()=>null)
                    || await f.$(`span.x-btn-inner:has-text("${APPLY_BUTTON_TEXT}")`).catch(()=>null);
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
      let target = await ctx.$(`button:has-text("${APPLY_BUTTON_TEXT}")`).catch(()=>null)
                 || await ctx.$(`a:has-text("${APPLY_BUTTON_TEXT}")`).catch(()=>null)
                 || await ctx.$(`span.x-btn-inner:has-text("${APPLY_BUTTON_TEXT}")`).catch(()=>null);
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
  const checker = await waitInFrames(async (ctx)=>{
    const el = await ctx.$('.x-grid-row-checker').catch(()=>null)
           || await ctx.$('div.x-grid-row-checker[role="presentation"]').catch(()=>null);
    if (el) return { ctx, el };
    return null;
  }, 6000);
  if (checker){
    try { await checker.el.click({ force:true }).catch(()=>{}); } catch {}
    try { await checker.ctx.evaluate((e)=>{ e.click(); }, checker.el).catch(()=>{}); } catch {}
    emit && emit({ type:'log', level:'info', msg:'[KEPCO] Grid checkbox click' });
    await sleep(200);
    // Ensure row is selected: click first grid row if no selection class
    const sel = await inFrames(async (ctx)=>{
      const selected = await ctx.$('.x-grid-row.x-grid-row-selected, tr.x-grid-row-selected').catch(()=>null);
      if (selected) return true;
      const first = await ctx.$('.x-grid-row, tr.x-grid-row').catch(()=>null);
      if (first) { try { await first.click({ force:true }).catch(()=>{}); } catch {} return true; }
      return false;
    });
    // Try to scroll the grid bottom toolbar into view
    await inFrames(async (ctx)=>{
      try { const grid = await ctx.$('.x-grid'); if (grid){ await grid.scrollIntoViewIfNeeded?.().catch(()=>{}); } } catch {}
      return false;
    });
  } else {
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
          return node.closest('a.x-btn, button, .x-btn') || node;
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
    }
    await sleep(300);
  } else {
    emit && emit({ type:'log', level:'warn', msg:'[KEPCO] "\uC785\uCC30\uCC38\uAC00\uC2E0\uCCAD" \uBC84\uD2BC\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.' });
  }

  // 3) Handle 안내/동의 모달 및 팝업
  // 3-1) Capture popup if spawned
  let modalPage = null;
  try {
    modalPage = await page.waitForEvent('popup', { timeout: 1500 }).catch(()=>null);
    if (modalPage) { await modalPage.waitForLoadState('domcontentloaded').catch(()=>{}); }
  } catch {}

  const ctxCandidates = [modalPage, page, ...page.frames?.()||[]].filter(Boolean);
  let checked = false;
  for (const ctx of ctxCandidates){
    try {
      // find window container first to scope search
      const win = await ctx.$('.x-window').catch(()=>null);
      const scope = win || ctx;
      const lab = await scope.$('label:has-text("\uB3D9\uC758 \uC0AC\uD56D")').catch(()=>null)
               || await scope.$('label[for*="checkbox-"]').catch(()=>null)
               || await scope.$('xpath=//label[span[contains(normalize-space(.),"\uB3D9\uC758 \uC0AC\uD56D")]]').catch(()=>null);
      const cb = await scope.$('input[type="checkbox"][id^="checkbox-"][id$="inputEl"]').catch(()=>null)
              || await scope.$('input[type="checkbox"]').catch(()=>null);
      const el = lab || cb;
      if (el){
        try { await el.click({ force:true }).catch(()=>{}); } catch {}
        try { await (scope.evaluate ? scope.evaluate(e=>{ e.click(); e.dispatchEvent(new MouseEvent('click', { bubbles:true })); }, el) : Promise.resolve()).catch(()=>{}) } catch {}
        emit && emit({ type:'log', level:'info', msg:'[KEPCO] \uC548\uB0B4 \uBAA8\uB2EC \uD655\uC778 \uCCB4\uD06C' });
        // try to click OK/\uD655\uC778 if present
        const ok = await (win||scope).$('button:has-text("\uD655\uC778")').catch(()=>null)
                 || await (win||scope).$('a:has-text("\uD655\uC778")').catch(()=>null)
                 || await (win||scope).$('span.x-btn-inner:has-text("\uD655\uC778")').catch(()=>null);
        if (ok) { try { await ok.click({ force:true }).catch(()=>{}); } catch {} }
        checked = true; break;
      }
    } catch {}
  }
  if (!checked) emit && emit({ type:'log', level:'warn', msg:'[KEPCO] 안내 모달 확인 체크박스를 찾지 못했습니다' });
}

async function navigateToApplication(page, emit) {
  const TEXT_BID_CONTRACT = "\uC785\uCC30/\uACC4\uC57D";
  const TEXT_BID_APPLY = "\uC785\uCC30\uCC38\uAC00\uC2E0\uCCAD";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const log = (level, msg) => emit && emit({ type: 'log', level, msg });
  const contexts = () => [page, ...(page.frames?.() || [])];

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

  log('info', '[KEPCO] Navigating menu to reach "' + TEXT_BID_APPLY + '".');
  const topSelectors = [
    'span.x-btn-inner:has-text("' + TEXT_BID_CONTRACT + '")',
    'button:has-text("' + TEXT_BID_CONTRACT + '")',
    'a:has-text("' + TEXT_BID_CONTRACT + '")',
    'text=' + TEXT_BID_CONTRACT,
    'xpath=//span[contains(normalize-space(.),"' + TEXT_BID_CONTRACT + '")]',
  ];

  const topButton = await waitForLocator(topSelectors, 8000);
  if (!topButton) {
    log('error', '[KEPCO] Unable to locate top menu "' + TEXT_BID_CONTRACT + '".');
    throw new Error('Failed to locate the bid/contract top menu button.');
  }

  if (!await tryClick(topButton)) {
    log('error', '[KEPCO] Click on "' + TEXT_BID_CONTRACT + '" did not succeed.');
    throw new Error('Failed to click the bid/contract top menu button.');
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
    ];
    const treeNode = await waitForLocator(treeSelectors, 8000);
    if (treeNode) {
      const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
      clickedTree = await tryClick(treeNode);
      await navPromise;
    }
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
  goToBidApplyAndSearch,
  applyAfterSearch,
  navigateToApplication,
};
