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
      emit && emit({ type: 'log', level: 'info', msg: `[MND] ?대┃ ?쒕룄: ${sel}` });
      const popupPromise = targetPage.waitForEvent('popup', { timeout: 1500 }).catch(() => null);
      await el.click().catch(() => {});
      const popup = await popupPromise;
      if (popup) {
        await popup.waitForLoadState('load').catch(() => {});
        emit && emit({ type: 'log', level: 'info', msg: '[MND] ??李?popup)?쇰줈 ?대룞' });
        return popup;
      }
      await targetPage.waitForTimeout(200).catch(()=>{});
      return null;
    }
    return null;
  }

  // 1) 硫붿씤?먯꽌 濡쒓렇??踰꾪듉 ?대┃
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

  // 2) 濡쒓렇???섎떒 ?좏깮 ?먮뒗 ID/PW ?낅젰
  if (auth.id && auth.pw) {
    try {
      // Container near the orange 濡쒓렇??踰꾪듉
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
        emit && emit({ type:'log', level:'warn', msg:'[MND] PW ?꾨낫 ??됲꽣濡??붿냼 ?먯깋 ?ㅽ뙣' });
        try {
          const info = await loginPage.evaluate(() => Array.from(document.querySelectorAll('input')).map(e => ({
            type: e.type, name: e.name, id: e.id, ph: e.getAttribute('placeholder')||'', disabled: !!e.disabled, vis: !!(e.offsetParent)
          })));
          emit && emit({ type:'log', level:'info', msg:`[MND] input 紐⑸줉: ${JSON.stringify(info)}` });
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
            emit && emit({ type:'log', level:'info', msg:`[MND] ?대갚: ??踰덉㎏ ?낅젰??PW濡??ъ슜 (count=${visInputs.length})` });
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
                   i.includes('pw') || i.includes('pass') || i.includes('password') || ph.includes('鍮꾨?踰덊샇');
          });
          if (isPwActive) {
            await loginPage.keyboard.type(String(auth.pw), { delay: 30 });
            usedKeyboard = true;
            emit && emit({ type:'log', level:'info', msg:'[MND] Tab?쇰줈 PW ?꾨뱶 ?ъ빱?????ㅼ엯???꾨즺' });
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
        emit && emit({ type:'log', level:'info', msg:'[MND] ID/PW 濡쒓렇???쒕룄 ?꾨즺' });
        return popup || null;
      }
      // If only ID is found, try to focus and TAB into PW once, but do NOT click 濡쒓렇??yet
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
          return t === 'password' || n.includes('pw') || n.includes('pass') || n.includes('password') || i.includes('pw') || i.includes('pass') || i.includes('password') || ph.includes('鍮꾨?踰덊샇');
        }).catch(()=>false);
        if (focusedIsPw) {
          try { await loginPage.keyboard.type(String(auth.pw), { delay: 30 }); emit && emit({ type:'log', level:'info', msg:'[MND] Tab ?ъ빱?ㅻ맂 PW???ㅼ엯???꾨즺' }); } catch {}
        }
        pwField = await findInFrames(pwCandidates);
        if (!pwField) {
          // small scroll to ensure visibility
          try { await loginPage.evaluate(() => window.scrollBy(0, 200)); } catch {}
          pwField = await findInFrames(pwCandidates);
        }
        if (!pwField) {
          emit && emit({ type:'log', level:'warn', msg:'[MND] PW ?꾨뱶 ?ы깘???ㅽ뙣' });
          throw new Error('[MND] PW ?꾨뱶 ?먯깋 ?ㅽ뙣');
        }
        try { await pwField.focus(); await pwField.fill(''); await pwField.type(String(auth.pw), { delay: 30 }); } catch {}
        const submit = await scope.$(`button[type="submit"], button:has-text("${TEXT_LOGIN}"), input[type="submit"]`);

        if (submit) { try { await submit.click(); } catch {} }
      }
      emit && emit({ type:'log', level:'warn', msg:'[MND] ID/PW ?낅젰 ?꾨뱶 ?먯깋 ?ㅽ뙣' });
      throw new Error('[MND] 濡쒓렇???낅젰 ?꾨뱶 ?먯깋 ?ㅽ뙣');
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

module.exports = { loginMnd, handleMndCertificate };







