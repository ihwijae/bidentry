"use strict";

const { handleNxCertificate } = require('./nxCertificate');
const TEXT_LOGIN = '\uB85C\uADF8\uC778';
const TEXT_CERT_CORE = '\uACF5\uB3D9\uC778\uC99D';
const TEXT_CERT_LOGIN = TEXT_CERT_CORE + ' \uB85C\uADF8\uC778';
async function loginMnd(page, emit, auth = {}) {
  async function $(selector) {
    const inMain = await page.$(selector);
    if (inMain) return inMain;
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      try { const el = await f.$(selector); if (el) return el; } catch {}
    }
    return null;
  }

  async function clickWithPopup(targetPage, candidates) {
    for (const sel of candidates) {
      const el = await targetPage.$(sel).catch(() => null) || await $(sel);
      if (!el) continue;
      emit && emit({ type: 'log', level: 'info', msg: `[MND] 클릭 시도: ${sel}` });
      const popupPromise = targetPage.waitForEvent('popup', { timeout: 1500 }).catch(() => null);
      await el.click().catch(() => {});
      const popup = await popupPromise;
      if (popup) {
        await popup.waitForLoadState('load').catch(() => {});
        emit && emit({ type: 'log', level: 'info', msg: '[MND] 새 창(팝업)으로 전환' });
        return popup;
      }
      await targetPage.waitForTimeout(200).catch(()=>{});
      return null;
    }
    return null;
  }

  // 1) 메인 페이지에서 로그인 버튼 클릭
  const loginCandidates = [
    'button:has-text("\uB85C\uADF8\uC778")',
    'a:has-text("\uB85C\uADF8\uC778")',
    '[aria-label*="\uB85C\uADF8\uC778" i]',
    '[id*="login" i], [class*="login" i]',
    'text=/\uB85C\uADF8\uC778/i'
  ];
  const popup = await clickWithPopup(page, loginCandidates);
  const loginPage = popup || page;
  try { loginPage.on('dialog', d => d.dismiss().catch(()=>{})); } catch {}
  await loginPage.waitForLoadState('domcontentloaded').catch(()=>{});

  // 2) 로그인 방식 선택 또는 ID/PW 입력
  if (auth.id && auth.pw) {
    try {
      // 주황색 로그인 버튼 근처 컨테이너 기준으로 필드 탐색
      const container = await (
        loginPage.$('form:has(button:has-text("\uB85C\uADF8\uC778"))') ||
        loginPage.$('section:has(button:has-text("\uB85C\uADF8\uC778"))')
      );
      const scope = container || loginPage;

      async function findByLabel(labelRegex){
        const frames = [loginPage, ...loginPage.frames?.() || []];
        for (const ctx of frames){
          try { const loc = ctx.getByLabel(labelRegex); if (await loc.count()) return loc.first(); } catch {}
        }
        return null;
      }

      let idLoc = await findByLabel(/\uC544\uC774\uB514/i);
      let pwLoc = await findByLabel(/\uBE44\uBC00\uBC88\uD638|\uBE44\uBC88/i);

      const idCandidates = [
        'input[placeholder*="\uC544\uC774\uB514" i]', 'input[title*="\uC544\uC774\uB514" i]',
        'input[name*="id" i]', 'input[id*="id" i]', 'input[name*="userid" i]', 'input[type="text"]'
      ];
      const pwCandidates = [
        'input[placeholder*="\uBE44\uBC00\uBC88\uD638" i]:visible',
        'input[title*="\uBE44\uBC00\uBC88\uD638" i]:visible',
        'input[type="password"]:visible',
        'input[name*="password" i]:visible', 'input[id*="password" i]:visible',
        'input[name*="pass" i]:visible', 'input[id*="pass" i]:visible',
        'input[name*="pw" i]:visible', 'input[id*="pw" i]:visible',
        'input[autocomplete="current-password"]:visible'
      ];

      async function findInFrames(cands, rootPage = loginPage){
        const frames = [rootPage, ...rootPage.frames?.() || []];
        for (const sel of cands){
          for (const f of frames){
            try { const e = await f.$(sel); if (e) return e; } catch {}
          }
        }
        return null;
      }

      // Wait briefly for fields to appear as some pages render lazily
      let idField = (idLoc ? await idLoc.elementHandle().catch(()=>null) : null) || await findInFrames(idCandidates);
      if (!idField) { try { await loginPage.waitForSelector(idCandidates.join(', '), { timeout: 1500 }); idField = await findInFrames(idCandidates); } catch {} }
      let pwField = (pwLoc ? await pwLoc.elementHandle().catch(()=>null) : null) || await findInFrames(pwCandidates);
      if (!pwField) { try { await loginPage.waitForSelector(pwCandidates.join(', '), { timeout: 1500 }); pwField = await findInFrames(pwCandidates); } catch {} }
      if (!pwField) {
        emit && emit({ type:'log', level:'warn', msg:'[MND] PW 입력 필드를 찾지 못했습니다. DOM 정보를 수집합니다.' });
        try {
          const info = await loginPage.evaluate(() => Array.from(document.querySelectorAll('input')).map(e => ({
            type: e.type, name: e.name, id: e.id, ph: e.getAttribute('placeholder')||'', disabled: !!e.disabled, vis: !!(e.offsetParent)
          })));
          emit && emit({ type:'log', level:'info', msg:`[MND] input 목록: ${JSON.stringify(info)}` });
        } catch {}
      }
      // If still no PW, click area below ID to focus next input
      if (idField && !pwField) {
        try {
          const box = await idField.boundingBox();
          if (box) {
            await loginPage.mouse.click(Math.floor(box.x + box.width/2), Math.floor(box.y + box.height + 18));
            await loginPage.waitForTimeout(150);
            pwField = await findInFrames(pwCandidates) || pwField;
          }
        } catch {}
      }
      // Fallback: pick 2nd visible input within the login form panel
      if (!pwField) {
        try {
          const visInputs = [];
          const handles = await scope.$$('input:not([type="hidden"])');
          for (const h of handles) { try { if (await h.isVisible()) visInputs.push(h); } catch {} }
          if (visInputs.length >= 2) {
            // assume [0]=ID, [1]=PW
            if (!idField) idField = visInputs[0];
            pwField = visInputs[1];
            emit && emit({ type:'log', level:'info', msg:`[MND] 대안 적용: 두 번째 입력을 PW 필드로 사용 (count=${visInputs.length})` });
          }
        } catch {}
      }

      if (idField && pwField) {
        try { await idField.focus(); } catch {}
        await idField.fill('');
        await idField.type(String(auth.id), { delay: 30 }).catch(()=>idField.fill(String(auth.id)));
        // Prefer keyboard navigation: Tab to PW then type
        let usedKeyboard = false;
        try {
          await loginPage.keyboard.press('Tab');
          await loginPage.waitForTimeout(120);
          const isPwActive = await loginPage.evaluate(() => {
            const ae = document.activeElement;
            if (!ae) return false;
            if (ae.tagName !== 'INPUT') return false;
            const n = (ae.getAttribute('name')||'').toLowerCase();
            const i = (ae.id||'').toLowerCase();
            const t = (ae.getAttribute('type')||'').toLowerCase();
            const ph = (ae.getAttribute('placeholder')||'').toLowerCase();
            return t === 'password' || n.includes('pw') || n.includes('pass') || n.includes('password') ||
                   i.includes('pw') || i.includes('pass') || i.includes('password') || ph.includes('비밀번호');
          });
          if (isPwActive) {
            await loginPage.keyboard.type(String(auth.pw), { delay: 30 });
            usedKeyboard = true;
            emit && emit({ type:'log', level:'info', msg:'[MND] Tab 이동으로 PW 필드 활성화 후 입력 완료' });
          }
        } catch {}
        if (!usedKeyboard) {
          try { await pwField.focus(); } catch {}
          await pwField.fill('');
          await pwField.type(String(auth.pw), { delay: 40 }).catch(()=>pwField.fill(String(auth.pw)));
        }
        const ok = await loginPage.evaluate((i, p) => ({ id: i?.value||'', pw: p?.value||'' }), idField, pwField).catch(()=>({id:'',pw:''}));
        if (!ok.id || !ok.pw) {
          await loginPage.evaluate((i, p, vid, vpw) => {
            if (i) { i.value = vid; i.dispatchEvent(new Event('input', { bubbles:true })); }
            if (p) { p.value = vpw; p.dispatchEvent(new Event('input', { bubbles:true })); }
          }, idField, pwField, String(auth.id), String(auth.pw)).catch(()=>{});
        }
        const submitSelectors = [
          `button[type="submit"]`,
          `button:has-text("${TEXT_LOGIN}")`,
          `input[type="submit"]`,
          `a:has-text("${TEXT_LOGIN}")`,
          `a[href*="login" i]`,
          `span:has-text("${TEXT_LOGIN}")`,
          `[role="button"]:has-text("${TEXT_LOGIN}")`
        ];
        let submit = null;
        for (const sel of submitSelectors) {
          submit = await scope.$(sel).catch(() => null);
          if (submit) break;
        }
        if (submit) {
          const nav = loginPage.waitForNavigation({ waitUntil: 'load', timeout: 8000 }).catch(() => null);
          await submit.scrollIntoViewIfNeeded?.().catch(() => {});
          const clicked = await submit.click().then(() => true).catch(() => false);
          if (!clicked) {
            try {
              await loginPage.evaluate((el) => {
                if (!el) return;
                el.click();
                el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              }, submit);
            } catch {}
          }
          await nav;
        } else {
          try { await pwField.focus(); await pwField.press('Enter'); } catch {}
          await loginPage.waitForNavigation({ waitUntil:'load', timeout: 10000 }).catch(()=>{});
        }
        emit && emit({ type:'log', level:'info', msg:'[MND] ID/PW 로그인 시도 완료' });
        return popup || null;
      }
      // If only ID is found, try to focus and TAB into PW once, but do NOT click login yet
      if (idField && !pwField) {
        // Strictly follow: ID -> Tab -> PW -> Login
        try { await idField.focus(); await idField.type(String(auth.id), { delay: 20 }); await loginPage.keyboard.press('Tab'); await loginPage.waitForTimeout(120); } catch {}
        // Try detect activeElement as PW
        const focusedIsPw = await loginPage.evaluate(() => {
          const ae = document.activeElement;
          if (!ae) return false;
          if ((ae.tagName||'') !== 'INPUT') return false;
          const n = (ae.getAttribute('name')||'').toLowerCase();
          const i = (ae.id||'').toLowerCase();
          const t = (ae.getAttribute('type')||'').toLowerCase();
          const ph = (ae.getAttribute('placeholder')||'').toLowerCase();
          return t === 'password' || n.includes('pw') || n.includes('pass') || n.includes('password') || i.includes('pw') || i.includes('pass') || i.includes('password') || ph.includes('비밀번호');
        }).catch(()=>false);
        if (focusedIsPw) {
          try { await loginPage.keyboard.type(String(auth.pw), { delay: 30 }); emit && emit({ type:'log', level:'info', msg:'[MND] Tab 이동 PW 필드 입력 완료' }); } catch {}
        }
        pwField = await findInFrames(pwCandidates);
        if (!pwField) {
          // small scroll to ensure visibility
          try { await loginPage.evaluate(() => window.scrollBy(0, 200)); } catch {}
          pwField = await findInFrames(pwCandidates);
        }
        if (!pwField) {
          emit && emit({ type:'log', level:'warn', msg:'[MND] PW 입력 필드를 끝내 찾지 못했습니다.' });
          throw new Error('[MND] PW 입력 필드 탐색 실패');
        }
        try { await pwField.focus(); await pwField.fill(''); await pwField.type(String(auth.pw), { delay: 30 }); } catch {}
        const submit = await scope.$(`button[type="submit"], button:has-text("${TEXT_LOGIN}"), input[type="submit"]`);

        if (submit) { try { await submit.click(); } catch {} }
      }
      emit && emit({ type:'log', level:'warn', msg:'[MND] ID/PW 입력 필드를 확보하지 못했습니다.' });
      throw new Error('[MND] 로그인 입력 필드 탐색 실패');
    } catch {}
  }

  const certCandidates = [
    'text=/\uACF5\uB3D9.?\uC778\uC99D(\uC11C)?\s*\uB85C\uADF8\uC778/i',
    'text=/\uC778\uC99D\uC11C\s*\uB85C\uADF8\uC778/i',
    'button:has-text("\uACF5\uB3D9\uC778\uC99D")',
    'button:has-text("' + TEXT_CERT_LOGIN + '")',
    'a:has-text("' + TEXT_CERT_LOGIN + '")'
  ];
  const certPopup = await clickWithPopup(loginPage, certCandidates);
  return certPopup || popup || null;
}

async function handleMndCertificate(page, emit, cert = {}, extra = {}) {
  const selectors = [...(Array.isArray(extra?.selectors) ? extra.selectors : []), '#nx-cert-select', '.nx-cert-select', '#certSelect', '#cert-select-layer'];
  const rowSelectors = [...(Array.isArray(extra?.rowSelectors) ? extra.rowSelectors : []), '#NXcertList tr', '#certList tr', '.cert-list tbody tr', '.nx-cert-list tr'];
  const pinSelectors = [...(Array.isArray(extra?.pinSelectors) ? extra.pinSelectors : []), '#certPwd', '#nx_cert_pin', 'input[name="certPwd"]', 'input[name="pincode"]'];
  const okText = String.fromCharCode(0xD655, 0xC778);
  const confirmSelectors = [
    ...(Array.isArray(extra?.confirmSelectors) ? extra.confirmSelectors : []),
    'button:has-text("' + okText + '")',
    '#nx-cert-select button.btn-ok',
    '#browser-guide-added-wrapper button.btn-ok',
    '.pki-bottom button.btn-ok',
    '#confirm',
    'button.btn-ok'
  ];
  return handleNxCertificate('MND', page, emit, cert, {
    ...extra,
    selectors,
    rowSelectors,
    pinSelectors,
    confirmSelectors
  });
}

function buildMndContexts(page) {
  const seen = new Set();
  const stack = [];
  if (page && typeof page === 'object') stack.push(page);
  const out = [];
  while (stack.length) {
    const ctx = stack.shift();
    if (!ctx || seen.has(ctx)) continue;
    seen.add(ctx);
    out.push(ctx);
    try {
      const childFrames = typeof ctx.frames === 'function'
        ? ctx.frames()
        : (typeof ctx.childFrames === 'function' ? ctx.childFrames() : []);
      for (const child of childFrames) {
        if (child && !seen.has(child)) stack.push(child);
      }
    } catch {}
  }
  return out;
}

async function findInMndContexts(page, selectors, { visibleOnly = true } = {}) {
  if (!selectors || selectors.length === 0) return null;
  const ctxs = buildMndContexts(page);
  for (const ctx of ctxs) {
    for (const sel of selectors) {
      if (!sel) continue;
      try {
        const handle = await ctx.$(sel);
        if (!handle) continue;
        if (!visibleOnly) return handle;
        const vis = typeof handle.isVisible === 'function'
          ? await handle.isVisible().catch(() => true)
          : true;
        if (vis) return handle;
      } catch {}
    }
  }
  return null;
}

async function waitForMndElement(page, selectors, { timeoutMs = 6000, visibleOnly = true } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const handle = await findInMndContexts(page, selectors, { visibleOnly });
    if (handle) return handle;
    try { await page?.waitForTimeout?.(180); } catch {}
  }
  return null;
}

async function clickMndMenuCandidate(page, emit, selectors) {
  const target = await findInMndContexts(page, selectors);
  if (!target) return { ok: false };
  emit && emit({ type:'log', level:'info', msg:'[MND] 협정자동신청 관련 메뉴를 클릭합니다.' });
  const popupPromise = typeof page?.waitForEvent === 'function'
    ? page.waitForEvent('popup', { timeout: 2000 }).catch(() => null)
    : Promise.resolve(null);
  const navPromise = typeof page?.waitForNavigation === 'function'
    ? page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => null)
    : Promise.resolve(null);
  try { await target.scrollIntoViewIfNeeded?.(); } catch {}
  try { await target.click({ force:true }); }
  catch (err) {
    try { await target.evaluate((el) => { if (el) el.click(); }); } catch {}
  }
  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    emit && emit({ type:'log', level:'info', msg:'[MND] 협정자동신청 페이지가 팝업으로 열렸습니다.' });
    return { ok: true, page: popup };
  }
  await navPromise;
  return { ok: true, page };
}

async function ensureAgreementWorkspace(page, emit) {
  const agreementSelectors = [
    'a:has-text("\uD611\uC815\uC790\uB3D9\uC2E0\uCCAD")',
    'a:has-text("\uC790\uB3D9\uC2E0\uCCAD" i)',
    'button:has-text("\uD611\uC815\uC2E0\uCCAD")',
    'text=/\uD611\uC815.?\uC790\uB3D9\uC2E0\uCCAD/i'
  ];
  const res = await clickMndMenuCandidate(page, emit, agreementSelectors);
  return res?.page || page;
}

async function waitForMndResults(page) {
  const resultSelectors = [
    '.table tbody tr:not(.empty)',
    '.tb_list tbody tr',
    'table tbody tr',
    '.grid-body tr',
    '.x-grid-item',
    '.list tbody tr'
  ];
  await waitForMndElement(page, resultSelectors, { timeoutMs: 8000, visibleOnly: false });
}

async function goToMndAgreementAndSearch(page, emit, bidId) {
  const log = (level, msg) => emit && emit({ type:'log', level, msg });
  if (!bidId) {
    log('warn', '[MND] 협정자동신청 공고번호가 비어 있어 검색을 건너뜁니다.');
    return { ok: true, page };
  }
  const digits = String(bidId).trim();
  log('info', `[MND] 협정자동신청 대상 공고번호: ${digits}`);

  let workPage = page;
  let input = await waitForMndElement(workPage, [
    'input[title*="\uACF5\uACE0" i]',
    'input[placeholder*="\uACF5\uACE0" i]',
    'input[name*="bid" i]',
    'input[id*="bid" i]',
    'input[name*="notice" i]',
    'input[id*="notice" i]',
    'input[name*="gonggo" i]',
    'input[name*="numb" i]'
  ], { timeoutMs: 5000 });

  if (!input) {
    workPage = await ensureAgreementWorkspace(workPage, emit);
    input = await waitForMndElement(workPage, [
      'input[title*="\uACF5\uACE0" i]',
      'input[placeholder*="\uACF5\uACE0" i]',
      'input[name*="bid" i]',
      'input[id*="bid" i]',
      'input[name*="notice" i]',
      'input[id*="notice" i]',
      'input[name*="gonggo" i]',
      'input[name*="numb" i]'
    ], { timeoutMs: 6000 });
  }

  if (!input) {
    throw new Error('[MND] 협정자동신청 공고번호 입력창을 찾지 못했습니다.');
  }

  try {
    await input.scrollIntoViewIfNeeded?.();
    await input.click({ force:true }).catch(() => {});
    await input.fill('');
  } catch {}
  await input.type(digits, { delay: 20 }).catch(() => input.fill(digits));
  try {
    await input.dispatchEvent('input');
    await input.dispatchEvent('change');
  } catch {}

  const searchBtn = await waitForMndElement(workPage, [
    'button:has-text("\uC870\uD68C")',
    'button:has-text("\uAC80\uC0C9")',
    'a:has-text("\uC870\uD68C")',
    'a:has-text("\uAC80\uC0C9")',
    '[role="button"]:has-text("\uC870\uD68C")',
    'input[type="submit"][value*="\uC870\uD68C"]'
  ], { timeoutMs: 5000, visibleOnly: true });

  if (searchBtn) {
    try {
      await searchBtn.scrollIntoViewIfNeeded?.();
      await searchBtn.click({ force:true });
    } catch {
      try { await workPage?.keyboard?.press('Enter'); } catch {}
    }
  } else {
    try { await input.press('Enter'); }
    catch {}
  }

  try { await workPage?.waitForTimeout?.(600); } catch {}
  await waitForMndResults(workPage);
  return { ok: true, page: workPage };
}

async function ensureMndRowSelection(page) {
  const rowSelectors = [
    '.table tbody tr:not(.empty)',
    '.tb_list tbody tr',
    'table tbody tr',
    '.grid-body tr'
  ];
  const row = await waitForMndElement(page, rowSelectors, { timeoutMs: 7000, visibleOnly: true });
  if (!row) return null;
  try {
    const checkbox = await row.$('input[type="checkbox"], input[type="radio"]');
    if (checkbox) {
      const checked = await checkbox.isChecked?.().catch(() => false);
      if (!checked) await checkbox.check?.({ force:true }).catch(() => checkbox.click({ force:true }));
    } else {
      await row.click({ force:true }).catch(() => {});
    }
  } catch {}
  return row;
}

async function handleAgreementConfirmation(page, emit) {
  const agreementModal = await waitForMndElement(page, [
    '.layer-pop', '.modal', '.dialog', 'div[role="dialog"]', '.pop-layer'
  ], { timeoutMs: 6000, visibleOnly: false });
  if (!agreementModal) return;
  try {
    await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('label'));
      for (const label of labels) {
        const text = (label.textContent || '').trim();
        if (!text) continue;
        if (/동의|확인|유의사항|안내/.test(text)) {
          const input = label.querySelector('input[type="checkbox"]')
            || document.getElementById(label.getAttribute('for') || '');
          if (input) {
            input.checked = true;
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      }
    });
  } catch {}

  const confirmBtn = await waitForMndElement(page, [
    'button:has-text("\uD655\uC778")',
    'button:has-text("\uC2E0\uCCAD")',
    'button:has-text("\uC804\uC1A1")',
    'a:has-text("\uC2E0\uCCAD")',
    'button:has-text("OK")'
  ], { timeoutMs: 5000, visibleOnly: true });
  if (confirmBtn) {
    try {
      await confirmBtn.scrollIntoViewIfNeeded?.();
      await confirmBtn.click({ force:true });
      emit && emit({ type:'log', level:'info', msg:'[MND] 협정자동신청 확인 버튼을 클릭했습니다.' });
    } catch {}
  }
}

async function applyMndAgreementAfterSearch(page, emit) {
  const log = (level, msg) => emit && emit({ type:'log', level, msg });
  const row = await ensureMndRowSelection(page);
  if (!row) {
    throw new Error('[MND] 협정자동신청 대상 목록을 찾지 못했습니다.');
  }
  const applySelectors = [
    'button:has-text("\uD611\uC815\uC790\uB3D9\uC2E0\uCCAD")',
    'button:has-text("\uC790\uB3D9\uC2E0\uCCAD")',
    'a:has-text("\uC2E0\uCCAD")',
    '[role="button"]:has-text("\uC2E0\uCCAD")'
  ];
  const applyBtn = await waitForMndElement(page, applySelectors, { timeoutMs: 5000, visibleOnly: true });
  if (!applyBtn) {
    throw new Error('[MND] 협정자동신청 버튼을 찾지 못했습니다.');
  }
  try {
    await applyBtn.scrollIntoViewIfNeeded?.();
    await applyBtn.click({ force:true });
    log('info', '[MND] 협정자동신청 버튼을 클릭했습니다.');
  } catch (err) {
    log('warn', `[MND] 협정자동신청 버튼 클릭 실패: ${(err && err.message) || err}`);
    throw err;
  }
  await handleAgreementConfirmation(page, emit);
}

module.exports = { loginMnd, handleMndCertificate, goToMndAgreementAndSearch, applyMndAgreementAfterSearch };
