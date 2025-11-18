?"use strict";

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
      emit && emit({ type: 'log', level: 'info', msg: `[KEPCO] ?�릭 ?�도: ${sel}` });
      const popupPromise = targetPage.waitForEvent('popup', { timeout: 1500 }).catch(() => null);
      await el.click().catch(() => {});
      const popup = await popupPromise;
      if (popup) {
        await popup.waitForLoadState('domcontentloaded').catch(() => {});
        const title = (await popup.title().catch(()=>'')) || '';
        const url = popup.url?.() || '';
        // Ignore notice popups (handled by auto-closer); stay on current page
        if (/\uACF5\uC9C0|\uC548\uB0B4|\uC774\uBCA4\uD2B8/i.test(title) || /popup/i.test(url) || popup.isClosed()) {
          emit && emit({ type:'log', level:'info', msg:`[KEPCO] ?�림 ?�업 무시(title='${title}')` });
          try { if (!popup.isClosed()) await popup.close({ runBeforeUnload:true }); } catch {}
        } else {
          emit && emit({ type: 'log', level: 'info', msg: '[KEPCO] ??�?popup)?�로 ?�동' });
          return popup;
        }
      }
      // Give modal animations a brief moment
      await targetPage.waitForTimeout(200).catch(()=>{});
      return null;
    }
    return null;
  }

  // 1) ?�단 로그??링크/버튼 ?�릭
  const loginLinkCandidates = [
    'header a:has-text("로그??)',
    'a[href*="login" i]',
    'text=/로그??i'
  ];
  const popup = await clickWithPopup(page, loginLinkCandidates);
  const loginPage = popup || page;
  // Ensure alert dialogs don't block automation
  try { loginPage.on('dialog', d => d.dismiss().catch(()=>{})); } catch {}
  await loginPage.waitForLoadState('domcontentloaded').catch(()=>{});

  // 2) 로그???�단 ?�택
  if (auth.id && auth.pw) {
    try {
      // Modal container candidates (로그???�이?�로�?
      const containerSel = [
        'div:has(button:has-text("공동?�증??로그??))',
        'div[role="dialog"]:has-text("로그??)',
        'div.layer:has-text("로그??)'
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
      let pwLoc = await findByLabel(/비�?번호|비번/i);

      // Candidate selectors including placeholder/title
      const idCandidates = [
        'input[placeholder*="?�이?? i]',
        'input[title*="?�이?? i]',
        'input[name*="id" i]', 'input[id*="id" i]', 'input[name*="userid" i]', 'input[type="text"]'
      ];
      const pwCandidates = [
        'input[placeholder*="비�?번호" i]',
        'input[title*="비�?번호" i]',
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
          'button:has-text("로그??)',
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
        emit && emit({ type:'log', level:'info', msg:'[KEPCO] ID/PW 로그???�도 ?�료' });
        return popup || null;
      }
      emit && emit({ type:'log', level:'warn', msg:'[KEPCO] ID/PW ?�력 ?�드 ?�색 ?�패' });
      throw new Error('[KEPCO] 로그???�력 ?�드 ?�색 ?�패');
    } catch {}
  }
  // If we reach here without handling ID/PW, do not block on cert; continue to cert trigger
  
  // 공동?�증??로그???�리�?
  const certCandidates = [
    'text=/공동.??�증(???\s*로그??i',
    'text=/?�증??s*로그??i',
    'button:has-text("공동?�증")',
    'button:has-text("?�증??)',
    'a:has-text("?�증??로그??)'
  ];
  const certPopup = await clickWithPopup(loginPage, certCandidates);
  return certPopup || popup || null;
}

module.exports = { loginKepco };

async function goToBidApplyAndSearch(page, emit, bidId){
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  // Helper: search across frames
  async function inFrames(run){
    const ctxs = [page, ...page.frames?.() || []];
    for (const ctx of ctxs){
      try { const res = await run(ctx); if (res) return res; } catch {}
    }
    return null;
  }
  async function tryExtTreeClick(ctx, text){
    try {
      return await ctx.evaluate((t)=>{
        try {
          if (window.Ext && Ext.ComponentQuery){
            const trees = Ext.ComponentQuery.query('treepanel');
            for (let i=0;i<trees.length;i++){
              const tp = trees[i];
              const root = tp.getRootNode && tp.getRootNode();
              if (!root) continue;
              // Expand all nodes to ensure visibility
              root.cascadeBy && root.cascadeBy(function(n){ try { n.expand && n.expand(); } catch(e){} });
              let found = null;
              const rx = new RegExp(t);
              root.cascadeBy && root.cascadeBy(function(n){ if (!found && rx.test((n.get && n.get('text'))||'')) { found = n; } });
              if (found){
                try { tp.getSelectionModel && tp.getSelectionModel().select(found); } catch(e){}
                try { tp.fireEvent && tp.fireEvent('itemclick', tp.getView && tp.getView(), found); } catch(e){}
                try { const el = tp.getView && tp.getView().getNode(found); el && el.querySelector('a') && el.querySelector('a').click(); } catch(e){}
                return true;
              }
            }
          }
        } catch(e){}
        return false;
      }, text);
    } catch { return false; }
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
  function allFrames(){ return page.frames?.() || []; }
  async function frameHasText(re){
    return await inFrames(async (ctx)=>{
      try { const t = await ctx.content? await ctx.content(): null; } catch {}
      try { const ok = await ctx.evaluate(r=> new RegExp(r).test(document.body.innerText), re.source).catch(()=>false); if (ok) return ctx; } catch {}
      try {
        const any = await ctx.$(`text=${re.source}`);
        if (any) return ctx;
      } catch {}
      return null;
    });
  }
  // 1) ?�단 메뉴: ?�찰/계약
  await inFrames(async (ctx)=>{
    const loc = ctx.getByRole?.('link', { name: /\uC785\uCC30\/?\uACC4\uC57D/i }) || null;
    if (loc && await loc.count().catch(()=>0)) { await loc.first().click().catch(()=>{}); return true; }
    const alt = await ctx.$('a:has-text("?�찰/계약")').catch(()=>null) || await ctx.$('text=/?�찰\/?계약/i').catch(()=>null);
    if (alt) { await alt.click().catch(()=>{}); return true; }
    return false;
  });
  await sleep(400);

  // 2) 좌측 메뉴 ?�리?�서 ?�찰참�??�청
  let moved = false;
  // ?�러 방식?�로 반복 ?�도 (3??
  for (let i=0;i<3 && !moved;i++){
    await inFrames(async (ctx)=>{
      const a = await ctx.$('.x-panel a:has-text("?�찰참�??�청")').catch(()=>null) || await ctx.$('a:has-text("?�찰참�??�청")').catch(()=>null);
      if (a) {
        try { await a.click({ force:true }).catch(()=>{}); } catch {}
        try { await ctx.evaluate(el => { el.click(); el.dispatchEvent(new MouseEvent('click', { bubbles:true })); }, a).catch(()=>{}); } catch {}
        moved = true; return true;
      }
      // ExtJS ?�리?�서 직접 ?�릭 ?�도
      const ok = await tryExtTreeClick(ctx, '?�찰참�??�청');
      if (ok) { moved = true; return true; }
      return false;
    });
    await sleep(250);
  }
  // ?�제 컨텐�??�레?�에 공고번호 ?�력 UI�? ?��??�는�? ?�인
  const contentCtx = await waitInFrames(async (ctx)=>{
    try {
      const el = await ctx.$('xpath=(//label[contains(normalize-space(.),"공고번호")]/following::input)[1]')
                || await ctx.$('input[aria-label*="공고번호" i]')
                || await ctx.$('input[title*="공고번호" i]')
                || await ctx.$('input[placeholder*="공고번호" i]');
      return el ? { ctx, el } : null;
    } catch { return null; }
  }, 8000);
  emit && emit({ type:'log', level: (moved && contentCtx)?'info':'warn', msg:`[KEPCO] 좌측 '?�찰참�??�청' ?�동 ${(moved && contentCtx)?'ok':'pending'}` });

  // 3) 공고번호 ?�력 ??조회(?�는 Enter)
  if (bidId) {
    let filled = null;
    if (contentCtx?.el) {
      filled = contentCtx;
      try { await contentCtx.el.fill(String(bidId)); } catch {}
    } else {
      filled = await waitInFrames(async (ctx)=>{
        // label 기반
        try {
          const lab = ctx.getByLabel?.(/공고번호/i);
          if (lab && await lab.count().catch(()=>0)) { await lab.first().fill(String(bidId)); return { ctx, el: await lab.first().elementHandle() }; }
        } catch {}
        // xpath/selector 기반
        const xp = await ctx.$('xpath=(//label[contains(normalize-space(.),"공고번호")]/following::input)[1]').catch(()=>null)
                  || await ctx.$('input[name*="공고번호" i]').catch(()=>null)
                  || await ctx.$('input[title*="공고" i]').catch(()=>null)
                  || await ctx.$('input[placeholder*="공고" i]').catch(()=>null);
        if (xp) { await xp.fill(String(bidId)); return { ctx, el: xp }; }
        return null;
      }, 8000);
    }
    if (filled) {
      // 조회 버튼 ?�릭 ?�도, ?�으�?Enter
      const clicked = await waitInFrames(async (ctx)=>{
        const btn = await ctx.$('button:has-text("조회")').catch(()=>null)
                  || await ctx.$('input[type="button"][value*="조회"][value!="조회�?]').catch(()=>null)
                  || await ctx.$('a:has-text("조회")').catch(()=>null);
        if (btn) { await btn.click().catch(()=>{}); return true; }
        return false;
      }, 3000);
      if (!clicked) { try { await filled.el.press('Enter'); } catch {} }
      emit && emit({ type:'log', level:'info', msg:`[KEPCO] 공고번호 조회 ?�도: ${bidId}` });
      await sleep(400);
    } else {
      emit && emit({ type:'log', level:'warn', msg:'[KEPCO] 공고번호 ?�력 ?�드 찾기 ?�패' });
    }
  }
}

module.exports.goToBidApplyAndSearch = goToBidApplyAndSearch;

async function applyAfterSearch(page, emit){
  const APPLY_BUTTON_TEXT = '?�찰참�??�청';
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

  // 1) 그리??�???체크박스 ?�릭
  // 빠른 경로: ?�일 ?�레?�에??체크박스 + ?�확 버튼("?�찰참�??�청")�??�순 ?�릭
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
      // 1) 체크박스 ?�릭 ???�택 ?�태 �?�?
      const chk = await ctx.$('.x-grid-row-checker');
      await chk.scrollIntoViewIfNeeded?.().catch(()=>{});
      await chk.click({ force:true }).catch(()=>{});
      await sleep(120);
      // ?�택 DOM ?�인, ?�으�?�????�릭?�로 보강
      let selected = await ctx.$('.x-grid-row-selected, tr.x-grid-row-selected').catch(()=>null);
      if (!selected) {
        const first = await ctx.$('.x-grid-row, tr.x-grid-row').catch(()=>null);
        if (first) { try { await first.click({ force:true }).catch(()=>{}); } catch {} }
        await sleep(80);
        selected = await ctx.$('.x-grid-row-selected, tr.x-grid-row-selected').catch(()=>null);
      }
      // 2) 버튼 ?�릭(?�확 ID)
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
        emit && emit({ type:'log', level:'info', msg:'[KEPCO] fastPath: 체크박스 ???�찰참�??�청 ?�차 ?�릭' });
        return true;
      }
    } catch {}
    return false;
  }

  const fast = await fastPath();
  if (fast) {
    // fastPath ??모달 ?�장 ?��?�??�시 ?�링, ?�면 ?�기??바로 처리?�고 반환
    const modalCtx = await waitInFrames(async (ctx)=>{
      try {
        return await ctx.$('.x-window') || await ctx.$('label:has-text("?�의 ?�항")');
      } catch { return null; }
    }, 1500);
    if (modalCtx) {
      // 모달 처리 루틴?�로 ?�어�?(?�래 공통 처리)
    } else {
      emit && emit({ type:'log', level:'warn', msg:'[KEPCO] fastPath ??모달 미탐�? ??fallback 진행' });
    }
  }

  // ?�린 경로(기존 로직)
  const checker = await waitInFrames(async (ctx)=>{
    const el = await ctx.$('.x-grid-row-checker').catch(()=>null)
           || await ctx.$('div.x-grid-row-checker[role="presentation"]').catch(()=>null);
    if (el) return { ctx, el };
    return null;
  }, 6000);
  if (checker){
    try { await checker.el.click({ force:true }).catch(()=>{}); } catch {}
    try { await checker.ctx.evaluate((e)=>{ e.click(); }, checker.el).catch(()=>{}); } catch {}
    emit && emit({ type:'log', level:'info', msg:'[KEPCO] �???체크박스 ?�릭' });
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
    emit && emit({ type:'log', level:'warn', msg:'[KEPCO] 그리??체크박스�?찾�? 못했?�니??' });
  }

  // 2) "?�찰참�??�청" 버튼 ?�릭
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
    emit && emit({ type:'log', level:'info', msg:'[KEPCO] "?�찰참�??�청" ?�릭' });
    // Wait briefly for modal to appear
    const modal = await waitInFrames(async (ctx)=>{ try { return await ctx.$('.x-window'); } catch { return null; } }, 1500);
    if (!modal) {
      // Capture evidence for debugging
      try { await page.screenshot({ path: '03_after_apply_click.png', fullPage:true }).catch(()=>{}); } catch {}
      emit && emit({ type:'log', level:'warn', msg:'[KEPCO] ?�청 ?�릭 ??모달 미탐�?(진단 ?�크린샷 ?????�도)' });
    }
    await sleep(300);
  } else {
    emit && emit({ type:'log', level:'warn', msg:'[KEPCO] "?�찰참�??�청" 버튼??찾�? 못했?�니??' });
  }

  // 3) ?�내 모달(??�??�는 ?�페?��?) 처리
  // 3-1) popup ??�?감�?
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
      const lab = await scope.$('label:has-text("?�의 ?�항")').catch(()=>null)
               || await scope.$('label[for*="checkbox-"]').catch(()=>null)
               || await scope.$('xpath=//label[span[contains(normalize-space(.),"?�의 ?�항")]]').catch(()=>null);
      const cb = await scope.$('input[type="checkbox"][id^="checkbox-"][id$="inputEl"]').catch(()=>null)
              || await scope.$('input[type="checkbox"]').catch(()=>null);
      const el = lab || cb;
      if (el){
        try { await el.click({ force:true }).catch(()=>{}); } catch {}
        try { await (scope.evaluate ? scope.evaluate(e=>{ e.click(); e.dispatchEvent(new MouseEvent('click', { bubbles:true })); }, el) : Promise.resolve()).catch(()=>{}) } catch {}
        emit && emit({ type:'log', level:'info', msg:'[KEPCO] ?�내 모달 ?�인 체크' });
        // try to click OK/?�인 if present
        const ok = await (win||scope).$('button:has-text("?�인")').catch(()=>null)
                 || await (win||scope).$('a:has-text("?�인")').catch(()=>null)
                 || await (win||scope).$('span.x-btn-inner:has-text("?�인")').catch(()=>null);
        if (ok) { try { await ok.click({ force:true }).catch(()=>{}); } catch {} }
        checked = true; break;
      }
    } catch {}
  }
  if (!checked) emit && emit({ type:'log', level:'warn', msg:'[KEPCO] ?�내 모달 ?�인 체크박스�?찾�? 못했?�니??' });
}

module.exports.applyAfterSearch = applyAfterSearch;


