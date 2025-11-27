"use strict";

const fs = require('fs');
const path = require('path');
const { handleNxCertificate } = require('./nxCertificate');
const TEXT_LOGIN = '\uB85C\uADF8\uC778';
const TEXT_CERT_CORE = '\uACF5\uB3D9\uC778\uC99D';
const TEXT_CERT_LOGIN = TEXT_CERT_CORE + ' \uB85C\uADF8\uC778';
const BID_GUIDE_TEXT_REGEX = /\uC785\uCC30\uC11C\s*\uC791\uC131\uC548\uB0B4/i;
const BID_GUIDE_SKIP_REGEXES = [/\uC778\uC99D/i, /\uACF5\uB3D9/i, /certificate/i, /cert/i];
const MND_GUARDED_CONTEXTS = new WeakSet();
const MND_GUARDED_PAGES = new WeakSet();

function runBidGuideGuardClient() {
  if (window.__mndBidGuideGuardInstalled) return;
  window.__mndBidGuideGuardInstalled = true;
  const maskSelectors = ['#mask', '.x-mask', '.layer_dim', '.dim', '.bg_dim', '.layer_pop', '.layer_pop_box', '.modal', '.layer'];
  const targetText = /\uC785\uCC30\uC11C\s*\uC791\uC131\uC548\uB0B4/;
  const buttonSelector = 'button, a, [role="button"], .btn';
  const normalizeText = (node) => ((node && (node.innerText || node.textContent)) || '').replace(/\s+/g, '');
  const isCloseText = (text) => /\uB2EB\uAE30|\uCDE8\uC18C|close|\uC885\uB8CC|\uCC29\uB958|X/i.test(text);
  const isConfirmText = (text) => /\uD655\uC778|\uC608|ok|confirm/i.test(text);
  const clickPreferredButton = (root) => {
    if (!root) return false;
    const seen = new Set();
    const buttons = [];
    const add = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      buttons.push(el);
    };
    if (root.matches && root.matches(buttonSelector)) add(root);
    if (typeof root.querySelectorAll === 'function') {
      root.querySelectorAll(buttonSelector).forEach(add);
    }
    if (!buttons.length) return false;
    const pick = buttons.find(btn => isCloseText(normalizeText(btn)))
      || buttons.find(btn => isConfirmText(normalizeText(btn)))
      || buttons[0];
    if (pick && typeof pick.click === 'function') {
      pick.click();
      return true;
    }
    return false;
  };
  const hideNodes = () => {
    let touched = false;
    maskSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        el.style.display = 'none';
        if (typeof el.remove === 'function') el.remove();
        touched = true;
      });
    });
    const nodes = Array.from(document.querySelectorAll('#alertLayer, #alertModal, .alertLayer, .layer_pop, .layer_pop_box, div, section, article'));
    for (const node of nodes) {
      const text = (node.innerText || node.textContent || '').replace(/\s+/g, '');
      if (!text) continue;
      if (targetText.test(text) || node.id === 'alertLayer') {
        if (clickPreferredButton(node)) {
          touched = true;
          continue;
        }
        if (typeof node.remove === 'function') {
          node.remove();
        } else {
          node.style.display = 'none';
        }
        touched = true;
      }
    }
    return touched;
  };

  const wrapFunctions = () => {
    const names = ['alertLayerOpen', 'alertLayerClose', 'alertLayerShow', 'confirmLayerOpen', 'confirmLayerClose', 'confirmLayerShow', 'noticeLayerOpen'];
    names.forEach(name => {
      try {
        const fn = window[name];
        if (typeof fn !== 'function' || fn.__mndBidGuideWrapped) return;
        const wrapped = function(...args) {
          const result = fn.apply(this, args);
          setTimeout(hideNodes, 0);
          return result;
        };
        wrapped.__mndBidGuideWrapped = true;
        window[name] = wrapped;
      } catch {}
    });
  };

  wrapFunctions();
  hideNodes();
  setInterval(() => {
    wrapFunctions();
    hideNodes();
  }, 900);
  document.addEventListener('DOMContentLoaded', () => setTimeout(hideNodes, 0), true);
  window.addEventListener('load', () => setTimeout(hideNodes, 0), true);
  window.addEventListener('pageshow', () => setTimeout(hideNodes, 0), true);
  ['click', 'keydown'].forEach(evt => document.addEventListener(evt, () => setTimeout(hideNodes, 0), true));
  window.__mndBidGuideGuardKill = hideNodes;
}
async function loginMnd(page, emit, auth = {}) {
  try { await installMndPopupGuards(page, emit); } catch {}
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
        try { await installMndPopupGuards(popup, emit); } catch {}
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
  try { await installMndPopupGuards(loginPage, emit); } catch {}
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
  if (certPopup) { try { await installMndPopupGuards(certPopup, emit); } catch {} }
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

async function dumpMndState(page, emit, tag) {
  if (!page) return;
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  const base = `${stamp}_${tag || 'mnd'}`;
  const dir = path.join(process.cwd(), 'engine_runs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const logPageMeta = async (label, ctx) => {
    if (!ctx) return;
    try {
      const url = typeof ctx.url === 'function' ? ctx.url() : '';
      let title = '';
      if (typeof ctx.title === 'function') {
        title = await ctx.title().catch(() => '') || '';
      } else if (ctx.page && typeof ctx.page === 'function') {
        try { title = await ctx.page().title(); } catch {}
      }
      let name = '';
      if (typeof ctx.name === 'function') {
        name = ctx.name();
      } else if (ctx.frame && typeof ctx.frame === 'function') {
        try { name = ctx.frame().name(); } catch {}
      }
      let preview = '';
      if (typeof ctx.evaluate === 'function') {
        preview = await ctx.evaluate(() => {
          const body = document.body;
          if (!body) return '';
          const txt = (body.innerText || body.textContent || '').trim();
          return txt.length > 600 ? txt.slice(0, 600) : txt;
        }).catch(() => '') || '';
      }
      emit && emit({
        type: 'log',
        level: 'info',
        msg: `[MND] dump[${label}] title='${title}' name='${name}' url='${url}' text='${preview.slice(0, 120).replace(/\s+/g, ' ')}'`
      });
    } catch (err) {
      emit && emit({ type:'log', level:'warn', msg:`[MND] dump meta 실패(${label}): ${(err && err.message) || err}` });
    }
  };
  const writeFile = (suffix, contents) => {
    if (!contents) return;
    const file = path.join(dir, `${base}_${suffix}.html`);
    try {
      fs.writeFileSync(file, contents, 'utf-8');
      emit && emit({ type:'log', level:'info', msg:`[MND] HTML 덤프 저장: ${file}` });
    } catch (err) {
      emit && emit({ type:'log', level:'warn', msg:`[MND] HTML 덤프 실패(${suffix}): ${(err && err.message) || err}` });
    }
  };
  try {
    await page.bringToFront?.().catch(()=>{});
    await page.waitForLoadState?.('domcontentloaded').catch(()=>{});
    await page.waitForTimeout?.(1200);
    const mainHtml = await page.content().catch(async () => {
      return await page.evaluate(() => document.documentElement.outerHTML).catch(() => '');
    });
    writeFile('main', mainHtml);
    await logPageMeta('main', page);
  } catch {}

  try {
    const contexts = buildMndContexts(page) || [];
    let idx = 0;
    for (const ctx of contexts) {
      if (!ctx) continue;
      let html = '';
      try {
        await ctx.bringToFront?.().catch(()=>{});
        await ctx.waitForLoadState?.('domcontentloaded').catch(()=>{});
        await ctx.waitForTimeout?.(300).catch(()=>{});
        if (typeof ctx.content === 'function') {
          html = await ctx.content();
        } else if (typeof ctx.evaluate === 'function') {
          html = await ctx.evaluate(() => document.documentElement.outerHTML).catch(() => '');
        }
      } catch {}
      if (html) {
        writeFile(`ctx${idx}`, html);
        await logPageMeta(`ctx${idx}`, ctx);
        idx += 1;
      }
    }
  } catch {}

  try {
    const shot = path.join(dir, `${base}.png`);
    await page.bringToFront?.().catch(()=>{});
    await page.waitForTimeout?.(500);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => null);
    emit && emit({ type:'log', level:'info', msg:`[MND] 스크린샷 저장: ${shot}` });
  } catch (err) {
    emit && emit({ type:'log', level:'warn', msg:`[MND] 스크린샷 실패: ${(err && err.message) || err}` });
  }

  try {
    const pages = page.context?.().pages?.() || [];
    let idx = 0;
    for (const pg of pages) {
      if (!pg || pg === page) continue;
      const name = `${base}_popup${idx}`;
      try {
        await pg.bringToFront?.().catch(()=>{});
        await pg.waitForLoadState?.('load', { timeout: 8000 }).catch(()=>{});
        await pg.waitForTimeout?.(800).catch(()=>{});
        const url = pg.url?.() || '';
        emit && emit({ type:'log', level:'info', msg:`[MND] 팝업 페이지 감지: ${url}` });
        const html = await pg.content().catch(async () => {
          return await pg.evaluate(() => document.documentElement.outerHTML).catch(() => '');
        });
        writeFile(`popup${idx}`, html);
        const shotPath = path.join(dir, `${name}.png`);
        await pg.screenshot({ path: shotPath, fullPage: true }).catch(()=>{});
        emit && emit({ type:'log', level:'info', msg:`[MND] 팝업 스크린샷 저장: ${shotPath}` });
        await logPageMeta(`popup${idx}`, pg);
      } catch (err) {
        emit && emit({ type:'log', level:'warn', msg:`[MND] 팝업 덤프 실패: ${(err && err.message) || err}` });
      }
      idx += 1;
    }
  } catch {}
}

async function closeMndBidGuideModal(page, emit, opts = {}) {
  const timeoutMs = Number(opts?.timeoutMs) || 5000;
  const skipOtherPages = opts?.skipOtherPages === true;
  try { await page?.waitForLoadState?.('domcontentloaded', { timeout: 2000 }); } catch {}
  const start = Date.now();
  const modalSelectors = [
    'text=/\uC785\uCC30\uC11C\s*\uC791\uC131\uC548\uB0B4/i',
    'text=/\uC785\uCC30\s*\uC791\uC131\uC548\uB0B4/i'
  ];
  const buttonSelectors = [
    'div:has-text("\uC785\uCC30\uC11C \uC791\uC131\uC548\uB0B4") button:has-text("\uB2EB\uAE30")',
    'button:has-text("\uB2EB\uAE30")',
    'a:has-text("\uB2EB\uAE30")',
    '[role="button"]:has-text("\uB2EB\uAE30")',
    'button:has-text("\uD655\uC778")'
  ];

  while (Date.now() - start < timeoutMs) {
    const modal = await findInMndContexts(page, modalSelectors, { visibleOnly: false });
    if (!modal) {
      if (!skipOtherPages) {
        const remain = timeoutMs - (Date.now() - start);
        if (remain <= 0) break;
        const others = page.context?.().pages?.() || [];
        for (const other of others) {
          if (!other || other === page) continue;
          if (typeof other.isClosed === 'function' && other.isClosed()) continue;
          let title = '';
          let url = '';
          try { title = (await other.title?.().catch(() => '')) || ''; } catch {}
          try { url = typeof other.url === 'function' ? other.url() : ''; } catch {}
          if (BID_GUIDE_SKIP_REGEXES.some(rx => rx.test(title) || rx.test(url))) continue;
          emit && emit({ type:'log', level:'debug', msg:`[MND] 다른 페이지 팝업 검사: title='${title}' url='${url}'` });
          const nested = await closeMndBidGuideModal(other, emit, { timeoutMs: Math.min(remain, 3000), skipOtherPages: true });
          if (nested) return true;
        }
      }
      await page?.waitForTimeout?.(200).catch(() => {});
      continue;
    }
    const element = modal.asElement?.() || modal;
    for (const sel of buttonSelectors) {
      let btn = null;
      try { btn = await element.$(sel); } catch {}
      if (!btn) {
        try { btn = await findInMndContexts(page, [sel], { visibleOnly: true }); } catch {}
      }
      if (!btn) continue;
      try {
        await btn.scrollIntoViewIfNeeded?.().catch(() => {});
        await btn.click({ force: true });
        emit && emit({ type: 'log', level: 'info', msg: '[MND] "입찰서 작성안내" 팝업을 닫았습니다.' });
        return true;
      } catch {}
    }
    const handled = await evaluateInMndContexts(page, () => {
      const buttonSelector = 'button, a, [role="button"], .btn';
      const normalizeText = (node) => ((node && (node.innerText || node.textContent)) || '').replace(/\s+/g, '');
      const isCloseText = (text) => /\uB2EB\uAE30|\uCDE8\uC18C|close|\uC885\uB8CC|\uCC29\uB958|X/i.test(text);
      const isConfirmText = (text) => /\uD655\uC778|\uC608|ok|confirm/i.test(text);
      const clickPreferredButton = (root) => {
        if (!root) return false;
        const seen = new Set();
        const buttons = [];
        const add = (el) => {
          if (!el || seen.has(el)) return;
          seen.add(el);
          buttons.push(el);
        };
        if (root.matches && root.matches(buttonSelector)) add(root);
        if (typeof root.querySelectorAll === 'function') {
          root.querySelectorAll(buttonSelector).forEach(add);
        }
        if (!buttons.length) return false;
        const pick = buttons.find(btn => isCloseText(normalizeText(btn)))
          || buttons.find(btn => isConfirmText(normalizeText(btn)))
          || buttons[0];
        if (pick && typeof pick.click === 'function') {
          pick.click();
          return true;
        }
        return false;
      };
      const scheduleWatcher = () => {
        if (window.__autoCloseBidGuide) return '';
        const closer = () => {
          const guidetext = /입찰서\s*작성안내/;
          const maskCandidates = ['#mask', '.x-mask', '.layer_dim', '.dim'];
          maskCandidates.forEach(sel => {
            document.querySelectorAll(sel).forEach(el => {
              el.style.display = 'none';
              if (typeof el.remove === 'function') el.remove();
            });
          });
          const dialog = document.querySelector('#alertLayer, #alertModal, .alertLayer, .layer_pop, .layer_pop_box');
          if (dialog) {
            dialog.style.display = 'none';
            clickPreferredButton(dialog);
          }
          const nodes = Array.from(document.querySelectorAll('div, section, article'));
          for (const node of nodes) {
            const txt = (node.textContent || '').replace(/\s+/g, '');
            if (guidetext.test(txt)) {
              if (clickPreferredButton(node)) { return; }
              if (typeof node.remove === 'function') node.remove();
              node.style.display = 'none';
              return;
            }
          }
        };
        closer();
        window.__autoCloseBidGuide = setInterval(closer, 1200);
        return 'watcher';
      };
      const killNodes = () => {
        const layers = Array.from(document.querySelectorAll('div, section, article, .layer, .modal, .layer_pop, #mask, .x-mask'));
        let hit = '';
        for (const el of layers) {
          const txt = (el.textContent || '').replace(/\s+/g, '');
          if (/입찰서\s*작성안내/.test(txt) || el.id === 'mask') {
            el.style.display = 'none';
            if (clickPreferredButton(el)) {
              return 'button';
            }
            if (typeof el.remove === 'function') el.remove();
            hit = 'removed';
          }
        }
        const dialogs = Array.from(document.querySelectorAll('#alertLayer, #alertModal, .alertLayer, .layer_pop, .layer_pop_box'));
        for (const dialog of dialogs) {
          dialog.style.display = 'none';
          if (clickPreferredButton(dialog)) {
            return 'button';
          }
          if (typeof dialog.remove === 'function') dialog.remove();
          hit = 'removed';
        }
        return hit;
      };
      const closeViaExt = () => {
        if (!(window.Ext && Ext.ComponentQuery)) return '';
        const wins = Ext.ComponentQuery.query('window');
        for (const win of wins) {
          try {
            const title = String(win.title || (win.getTitle && win.getTitle()) || '');
            if (/입찰서/.test(title) || /참가/.test(title)) {
              win.close?.();
              return 'ext';
            }
          } catch {}
        }
        return '';
      };
      const clickByText = () => {
        const closers = [];
        const fallbacks = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        while (walker.nextNode()) {
          const el = walker.currentNode;
          const text = (el.innerText || el.textContent || '').replace(/\s+/g, '');
          if (!text) continue;
          if (isCloseText(text)) {
            if (typeof el.click === 'function') closers.push(el);
            continue;
          }
          if (/입찰서.*작성안내/.test(text) || isConfirmText(text)) {
            if (typeof el.click === 'function') fallbacks.push(el);
          }
        }
        const target = closers[0] || fallbacks[0];
        if (target && typeof target.click === 'function') {
          target.click();
          return closers.includes(target) ? 'text-close' : 'text';
        }
        return '';
      };
      const fnCall = () => {
        try {
          if (typeof window.confirmLayerClose === 'function') {
            window.confirmLayerClose();
            return 'fn-confirmLayer';
          }
          if (window.Mdi && window.Mdi.view && window.Mdi.view.mdi && typeof window.Mdi.view.mdi.alertClose === 'function') {
            window.Mdi.view.mdi.alertClose();
            return 'fn-alertClose';
          }
        } catch {}
        return '';
      };
      return fnCall() || closeViaExt() || killNodes() || clickByText() || scheduleWatcher();
    });
    if (handled?.value) {
      emit && emit({ type: 'log', level: 'info', msg: `[MND] "입찰서 작성안내" 팝업을 제거했습니다. (${handled.value})` });
      return true;
    }
    try {
      await page.keyboard?.press('Escape').catch(() => {});
      await page.keyboard?.press('Enter').catch(() => {});
    } catch {}
    await page?.waitForTimeout?.(200).catch(() => {});
  }
  return false;
}

async function inspectMndBidGuidePopup(pg, emit) {
  if (!pg) return;
  try {
    await pg.waitForLoadState?.('domcontentloaded', { timeout: 5000 }).catch(() => {});
    const title = (typeof pg.title === 'function' ? await pg.title().catch(() => '') : '') || '';
    const url = typeof pg.url === 'function' ? pg.url() : '';
    const skip = BID_GUIDE_SKIP_REGEXES.some(rx => rx.test(title) || rx.test(url));
    if (skip) return;
    let text = '';
    if (typeof pg.evaluate === 'function') {
      try {
        text = await pg.evaluate(() => {
          const body = document.body;
          if (!body) return '';
          return (body.innerText || body.textContent || '').trim();
        });
      } catch {}
    }
    if (!text && typeof pg.content === 'function') {
      try { text = await pg.content(); } catch {}
    }
    const matched = BID_GUIDE_TEXT_REGEX.test(title) || BID_GUIDE_TEXT_REGEX.test(url) || BID_GUIDE_TEXT_REGEX.test(text);
    if (matched) {
      emit && emit({ type:'log', level:'info', msg:`[MND] 팝업 창에서 "입찰서 작성안내" 감지(title='${title}' url='${url}'). 닫기 시도.` });
      try {
        await closeMndBidGuideModal(pg, emit, { timeoutMs: 3500, skipOtherPages: true });
        return;
      } catch {}
      try { await pg.close({ runBeforeUnload: true }); } catch {}
    }
  } catch (err) {
    emit && emit({ type:'log', level:'debug', msg:`[MND] 팝업 감시 중 오류: ${(err && err.message) || err}` });
  }
}

async function installMndPopupGuards(page, emit) {
  if (!page) return;
  const ctx = typeof page.context === 'function' ? page.context() : null;
  if (ctx && !MND_GUARDED_CONTEXTS.has(ctx)) {
    MND_GUARDED_CONTEXTS.add(ctx);
    try {
      ctx.on('page', (pg) => {
        if (!pg) return;
        installMndPopupGuards(pg, emit).catch(() => {});
        setTimeout(() => {
          inspectMndBidGuidePopup(pg, emit).catch(() => {});
        }, 400);
      });
    } catch {}
  }
  if (!MND_GUARDED_PAGES.has(page)) {
    MND_GUARDED_PAGES.add(page);
    try { await page.addInitScript(runBidGuideGuardClient); } catch {}
  }
  try { await page.evaluate(runBidGuideGuardClient); } catch {}
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

async function evaluateInMndContexts(page, evaluator) {
  const ctxs = buildMndContexts(page);
  for (const ctx of ctxs) {
    if (!ctx || typeof ctx.evaluate !== 'function') continue;
    try {
      const result = await ctx.evaluate(evaluator);
      if (result) return { context: ctx, value: result };
    } catch {}
  }
  return null;
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
  try { await installMndPopupGuards(page, emit); } catch {}
  const digits = bidId ? String(bidId).trim() : '';
  if (!digits) {
    log('warn', '[MND] 공고번호가 설정되어 있지 않습니다.');
  } else {
    log('info', `[MND] 공고번호 검색 준비: ${digits}`);
  }

  const resolveWorkPage = async () => {
    if (!page) return page;
    const ctx = typeof page.context === 'function' ? page.context() : null;
    const seen = new Set();
    const candidates = [];
    const push = (pg) => {
      if (!pg || seen.has(pg)) return;
      seen.add(pg);
      candidates.push(pg);
    };
    push(page);
    if (ctx) {
      const pages = ctx.pages?.() || [];
      for (const pg of pages) push(pg);
    }
    for (const pg of candidates) {
      let url = '';
      try { url = typeof pg.url === 'function' ? pg.url() : ''; } catch {}
      if (!url || url === 'about:blank') continue;
      if (!/d2b\.go\.kr/i.test(url)) continue;
      try { await pg.bringToFront?.(); } catch {}
      return pg;
    }
    return page;
  };

  let workPage = await resolveWorkPage() || page;
  const adoptWorkPage = async (nextPage) => {
    if (!nextPage || workPage === nextPage) return;
    workPage = nextPage;
    try { await installMndPopupGuards(workPage, emit); } catch {}
  };
  const adoptPageByPattern = async (patterns = []) => {
    const ctx = (workPage && typeof workPage.context === 'function' && workPage.context())
      || (page && typeof page.context === 'function' && page.context());
    if (!ctx || typeof ctx.pages !== 'function') return null;
    const pages = ctx.pages() || [];
    for (const pg of pages.reverse()) {
      if (!pg) continue;
      try {
        const closed = typeof pg.isClosed === 'function' ? pg.isClosed() : false;
        if (closed) continue;
      } catch {}
      let url = '';
      let title = '';
      try { url = typeof pg.url === 'function' ? pg.url() : ''; } catch {}
      try { title = typeof pg.title === 'function' ? await pg.title().catch(() => '') : ''; } catch {}
      if (!patterns?.length || patterns.some(rx => rx.test(url) || rx.test(title))) {
        await adoptWorkPage(pg);
        return workPage;
      }
    }
    return null;
  };
  const ensureWorkPageAlive = async () => {
    if (workPage) {
      try {
        if (typeof workPage.isClosed === 'function' && !workPage.isClosed()) return workPage;
      } catch {}
    }
    const resolved = await resolveWorkPage() || page;
    if (resolved && resolved !== workPage) {
      workPage = resolved;
      try { await installMndPopupGuards(workPage, emit); } catch {}
    }
    return workPage;
  };
  const prepareWorkPage = async ({ scrollBottom = false } = {}) => {
    const current = await ensureWorkPageAlive();
    if (!current) return null;
    try { await current.waitForLoadState?.('domcontentloaded', { timeout: 6000 }); } catch {}
    try { await current.waitForTimeout?.(250); } catch {}
    if (scrollBottom) {
      try {
        await current.evaluate(() => {
          try {
            const height = document.body?.scrollHeight || document.documentElement?.scrollHeight || 0;
            window.scrollTo?.(0, height);
          } catch {}
        });
      } catch {}
    }
    return current;
  };
  const openBidDetailViaController = async ({ rowOffset = 0 } = {}) => {
    if (!workPage) return false;
    const popupPromise = typeof workPage.waitForEvent === 'function'
      ? workPage.waitForEvent('popup', { timeout: 5000 }).catch(() => null)
      : Promise.resolve(null);
    const navPromise = typeof workPage.waitForNavigation === 'function'
      ? workPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => null)
      : Promise.resolve(null);
    const result = await workPage.evaluate(({ rowOffset }) => {
      try {
        const viewObj = window.view;
        const controllerObj = window.controller;
        const gridWrapper = viewObj && viewObj.grid ? viewObj.grid : null;
        const grid = gridWrapper && gridWrapper.ID ? gridWrapper.ID : null;
        if (!grid || typeof grid.getRows !== 'function' || typeof grid.getFixedRows !== 'function') {
          return { ok: false, reason: 'missing-grid' };
        }
        const totalRows = Number(grid.getRows());
        const fixedRows = Number(grid.getFixedRows());
        if (!(totalRows > fixedRows)) {
          return { ok: false, reason: 'no-data', details: { totalRows, fixedRows } };
        }
        const offset = Number.isFinite(rowOffset) ? rowOffset : 0;
        const targetRow = Math.min(Math.max(fixedRows + offset, fixedRows), totalRows - 1);
        const rowData = typeof grid.getRowData === 'function' ? grid.getRowData(targetRow) : null;
        if (!rowData) {
          return { ok: false, reason: 'missing-row-data', details: { row: targetRow } };
        }
        const searchInput = document.querySelector('#searchData');
        let searchData = {};
        if (searchInput) {
          try { searchData = JSON.parse(searchInput.value || '{}'); } catch {}
        }
        searchData.idx_row = targetRow;
        const payload = {
          dprt_code: rowData.dprtCode,
          anmt_divs: rowData.anmtDivs,
          anmt_numb: rowData.anmtNumb,
          rqst_degr: rowData.rqstDegr,
          dcsn_numb: rowData.dcsnNumb,
          rqst_year: rowData.rqstYear,
          bsic_stat: rowData.bsicStat,
          dmst_itnb: rowData.dmstItnb,
          anmt_date: rowData.anmtDate,
          csrt_numb: rowData.dcsnNumb,
          lv2Divs: rowData.lv2Divs,
          cont_mthd: rowData.contMthd,
          pageDivs: 'E1',
          lv1_divs: rowData.lv1Divs,
          searchData: JSON.stringify(searchData)
        };
        const level = String(rowData.lv2Divs ?? '');
        if (level === '2') {
          const ctrl = controllerObj;
          if (ctrl && typeof ctrl.goOpenNegoDetail === 'function') {
            ctrl.goOpenNegoDetail({
              csrt_numb: rowData.dcsnNumb,
              negn_pldt: rowData.anmtDate,
              dprt_code: rowData.dprtCode,
              ordr_year: rowData.rqstYear,
              negn_degr: rowData.rqstDegr,
              anmt_numb: rowData.anmtNumb,
              searchData: JSON.stringify(searchData)
            });
            return { ok: true, mode: 'goOpenNegoDetail', row: targetRow };
          }
        }
        const ctrl = controllerObj;
        if (ctrl && typeof ctrl.goBidDetail === 'function') {
          ctrl.goBidDetail(payload);
          return { ok: true, mode: 'goBidDetail', row: targetRow };
        }
        if (typeof window.goBidDetail === 'function') {
          window.goBidDetail(payload);
          return { ok: true, mode: 'window-goBidDetail', row: targetRow };
        }
        return { ok: false, reason: 'missing-goBidDetail' };
      } catch (err) {
        return { ok: false, error: (err && err.message) || String(err || '') };
      }
    }, { rowOffset }).catch(err => ({ ok: false, error: (err && err.message) || String(err || '') }));
    const popup = await popupPromise;
    let opened = false;
    if (popup) {
      opened = true;
      log('info', '[MND] SBGrid 상세 팝업이 새 창으로 열렸습니다.');
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      await adoptWorkPage(popup);
    }
    const navResult = await navPromise;
    if (navResult) opened = true;
    if (result?.ok) opened = true;
    if (result?.error) {
      log('warn', `[MND] SBGrid 컨트롤러 호출 오류: ${result.error}`);
    } else if (result?.reason && !opened) {
      log('debug', `[MND] SBGrid 컨트롤러 호출 실패: ${result.reason}`);
    } else if (result?.mode) {
      log('info', `[MND] SBGrid 컨트롤러 호출 성공(${result.mode}).`);
    }
    return opened;
  };
  const clickAndAdopt = async (handle, { waitMs = 8000, mouseClick = false, clickCount = 1 } = {}) => {
    if (!handle) return null;
    const popupPromise = typeof workPage.waitForEvent === 'function'
      ? workPage.waitForEvent('popup', { timeout: 4000 }).catch(() => null)
      : Promise.resolve(null);
    const navPromise = typeof workPage.waitForNavigation === 'function'
      ? workPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: waitMs }).catch(() => null)
      : Promise.resolve(null);
    try { await handle.scrollIntoViewIfNeeded?.(); } catch {}
    let clicked = false;
    if (mouseClick) {
      try {
        const box = await handle.boundingBox();
        if (box) {
          const x = box.x + box.width / 2;
          const y = box.y + box.height / 2;
          await workPage.mouse.move(x, y);
          await workPage.mouse.click(x, y, { clickCount });
          clicked = true;
        }
      } catch {}
    }
    if (!clicked) {
      try { await handle.click({ force:true, clickCount }); clicked = true; }
      catch { try { await handle.evaluate(el => el && el.click()); clicked = true; } catch {} }
    }
    const popup = await popupPromise;
    if (popup) {
      log('info', '[MND] 새 창이 열려 전환합니다.');
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      await adoptWorkPage(popup);
      return workPage;
    }
    await navPromise;
    return workPage;
  };
  try {
    const resolvedUrl = workPage && typeof workPage.url === 'function' ? workPage.url() : '';
    if (resolvedUrl) log('debug', `[MND] 작업 페이지: ${resolvedUrl}`);
  } catch {}
  if (workPage && workPage !== page) {
    try { await installMndPopupGuards(workPage, emit); } catch {}
  }

  const menuSelectors = [
    '#lnb a:has-text("\uC785\uCC30\uACF5\uACE0")',
    '.lnb a:has-text("\uC785\uCC30\uACF5\uACE0")',
    '.left_menu a:has-text("\uC785\uCC30\uACF5\uACE0")',
    'nav a:has-text("\uC785\uCC30\uACF5\uACE0")',
    'aside a:has-text("\uC785\uCC30\uACF5\uACE0")',
    '[class*="lnb"] a:has-text("\uC785\uCC30\uACF5\uACE0")',
    'a[href*="bidAnnounce" i]:has-text("\uC785\uCC30\uACF5\uACE0")',
    'a[href*="announceList" i]:has-text("\uC785\uCC30\uACF5\uACE0")'
  ];

  const isBidNoticePage = async () => {
    try {
      const currentUrl = typeof workPage.url === 'function' ? workPage.url() : '';
      if (/bidAnnounce|announceList|BidAnnounce/i.test(currentUrl)) return true;
      const hasHeading = await workPage.evaluate(() => {
        const selectors = [
          '.contents h3', '.cont_tit', '.content_title', '.tit_area h3',
          'h2', 'h3', '.board_tit', '.page_title'
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && /입찰공고/.test((el.textContent || '').replace(/\s+/g, ''))) return true;
        }
        return false;
      }).catch(() => false);
      return hasHeading;
    } catch {
      return false;
    }
  };

  const waitForBidNoticePage = async (timeoutMs = 5000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await isBidNoticePage()) return true;
      try { await workPage.waitForTimeout(200); } catch {}
    }
    return await isBidNoticePage();
  };

  const clickBidMenu = async () => {
    const link = await findInMndContexts(workPage, menuSelectors, { visibleOnly: true });
    if (!link) {
      log('warn', '[MND] 좌측 "입찰공고" 메뉴를 찾지 못했습니다.');
      return false;
    }
    try {
      const popupPromise = typeof workPage.waitForEvent === 'function'
        ? workPage.waitForEvent('popup', { timeout: 4000 }).catch(() => null)
        : Promise.resolve(null);
      const navPromise = typeof workPage.waitForNavigation === 'function'
        ? workPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => null)
        : Promise.resolve(null);
      await link.scrollIntoViewIfNeeded?.();
      await link.click({ force:true }).catch(()=>link.evaluate(el => el && el.click()));
      log('info', '[MND] 좌측 "입찰공고" 메뉴를 클릭했습니다.');
      const popup = await popupPromise;
      if (popup) {
        log('info', '[MND] "입찰공고" 메뉴가 새 창으로 열려 전환합니다.');
        await popup.waitForLoadState('domcontentloaded').catch(() => {});
        await adoptWorkPage(popup);
      } else {
        await navPromise;
      }
      await waitForBidNoticePage(4000);
      return true;
    } catch (err) {
      log('warn', `[MND] "입찰공고" 메뉴 클릭 실패: ${(err && err.message) || err}`);
      return false;
    }
  };

  try { await closeMndBidGuideModal(workPage, emit, { timeoutMs: 5000 }); } catch {}
  const clicked = await clickBidMenu();
  let onBidPage = await isBidNoticePage();
  if (!onBidPage && !clicked) {
    log('warn', '[MND] 메뉴 클릭이 실패하여 직접 이동을 시도합니다.');
  }
  if (!onBidPage) {
    const fallbackUrls = [
      'https://www.d2b.go.kr/peb/bid/bidAnnounceList.do?key=541',
      'https://www.d2b.go.kr/peb/bid/announceList.do?key=541',
      'https://www.d2b.go.kr/pdb/bid/goodsBidAnnounceList.do?key=129',
      'https://www.d2b.go.kr/psb/bid/serviceBidAnnounceList.do?key=137'
    ];
    for (const target of fallbackUrls) {
      try {
        await workPage.goto(target, { waitUntil:'domcontentloaded', timeout: 10000 });
        log('info', `[MND] 직접 이동 시도: ${target}`);
        onBidPage = await waitForBidNoticePage(2500);
        if (onBidPage) break;
      } catch (err) {
        log('warn', `[MND] 직접 이동 실패(${target}): ${(err && err.message) || err}`);
      }
    }
  }

  if (!onBidPage) {
    await dumpMndState(workPage, emit, 'bid_notice_page_missing');
    throw new Error('[MND] 입찰공고 페이지로 이동하지 못했습니다.');
  }

  if (!digits) return { ok: true, page: workPage };

  const inputSelectors = [
    'input#numb_divs',
    'input[name="numb_divs" i]',
    'input[title*="G2B" i]',
    'input[placeholder*="G2B" i]',
    'input[name*="gonggo" i]',
    'input[id*="gonggo" i]',
    'input[title*="\uACF5\uACE0" i]',
    '.search_tbl input[type="text" i]',
    '.search_area input[type="text" i]',
    '#bidNo',
    'input[name*="bidNo" i]',
    'input[name*="gonggo_no" i]',
    'input[id*="gonggo_no" i]',
    'label:has-text("\uACF5\uACE0\uBC88\uD638") ~ input',
    'td:has-text("\uACF5\uACE0\uBC88\uD638") input',
    'th:has-text("\uACF5\uACE0\uBC88\uD638") ~ td input',
    'div:has-text("\uACF5\uACE0\uBC88\uD638") input'
  ];
  const input = await waitForMndElement(workPage, inputSelectors, { timeoutMs: 6000, visibleOnly: true });
  if (!input) {
    try {
      const info = await workPage.evaluate(() => {
        return Array.from(document.querySelectorAll('input'))
          .filter(el => el.type !== 'hidden')
          .map(el => ({
            id: el.id,
            name: el.name,
            title: el.title,
            placeholder: el.getAttribute('placeholder'),
            label: ((el.closest('td, label, div') || {}).innerText || '').trim().slice(0, 40)
          }));
      });
      log('warn', `[MND] 입력 후보 목록: ${JSON.stringify(info)}`);
    } catch {}
    await dumpMndState(workPage, emit, 'bid_notice_input_missing');
    throw new Error('[MND] 입찰공고 공고번호 입력창을 찾지 못했습니다.');
  }

  try {
    await input.scrollIntoViewIfNeeded?.();
    await input.click({ force:true }).catch(()=>{});
    await input.fill('');
    await input.type(digits, { delay: 20 }).catch(()=>input.fill(digits));
    await input.dispatchEvent('input').catch(()=>{});
    await input.dispatchEvent('change').catch(()=>{});
  } catch (err) {
    log('warn', `[MND] 공고번호 입력 실패: ${(err && err.message) || err}`);
  }

  const searchSelectors = [
    '.search_area button:has-text("\uAC80\uC0C9")',
    '.search_area button:has-text("\uC870\uD68C")',
    '.search_tbl button:has-text("\uAC80\uC0C9")',
    '.search_tbl button:has-text("\uC870\uD68C")',
    'form[action*="bid"] button:has-text("\uAC80\uC0C9")',
    'form[action*="bid"] button:has-text("\uC870\uD68C")',
    'button#searchBtn',
    'button[name="searchBtn"]',
    'button:has-text("\uAC80\uC0AC")',
    'button:has-text("\uC870\uD68C")'
  ];
  const searchBtn = await waitForMndElement(workPage, searchSelectors, { timeoutMs: 5000, visibleOnly: true });
  if (searchBtn) {
    try {
      await searchBtn.scrollIntoViewIfNeeded?.();
      await searchBtn.click({ force:true }).catch(()=>{});
    } catch {}
  } else {
    try { await input.press('Enter'); } catch {}
  }
  try { await workPage.waitForTimeout(400); } catch {}
  await prepareWorkPage();

  const firstRowSelectors = [
    '.table tbody tr:not(.empty) td a',
    '.tb_list tbody tr:first-child td a',
    '.grid-body tr:first-child a',
    'table tbody tr:first-child a',
    '#sbGridArea .sbgrid_datagrid_GridWhole_table tbody tr:first-child td:nth-of-type(5)',
    '#sbGridArea .sbgrid_datagrid_GridWhole_table tbody tr:first-child td:nth-of-type(4)',
    'div[id^="SBHE_DATAGRID"] tbody tr:first-child td:nth-of-type(5)'
  ];
  const first = await waitForMndElement(workPage, firstRowSelectors, { timeoutMs: 6000, visibleOnly: true });
  if (!first) {
    await dumpMndState(workPage, emit, 'bid_results_missing');
    throw new Error('[MND] 공고 검색 결과를 찾지 못했습니다.');
  }
  let detailOpened = false;
  try {
    const viaController = await openBidDetailViaController({ rowOffset: 0 });
    if (viaController) {
      detailOpened = true;
      log('info', '[MND] SBGrid 컨트롤러를 통해 상세 페이지를 열었습니다.');
    }
  } catch (err) {
    log('debug', `[MND] SBGrid 컨트롤러 직접 호출 실패: ${(err && err.message) || err}`);
  }
  if (!detailOpened) {
    try {
      try { await first.click({ clickCount: 2, delay: 50 }); } catch {}
      await clickAndAdopt(first, { waitMs: 8000, mouseClick: true, clickCount: 2 });
      log('info', '[MND] 공고 검색 결과의 공사명을 클릭했습니다.');
      detailOpened = true;
    } catch (err) {
      log('warn', `[MND] 검색 결과 클릭 실패: ${(err && err.message) || err}`);
      throw err;
    }
  }
  await waitForMndResults(workPage);

  const detailButtonSelectors = [
    '#btn_join',
    'button#btn_join',
    'button:has-text("\uC785\uCC30\uCC38\uAC00\uC2E0\uCCAD\uC11C \uC791\uC131")',
    'a:has-text("\uC785\uCC30\uCC38\uAC00\uC2E0\uCCAD\uC11C \uC791\uC131")',
    'button:has-text("\uC2E0\uCCAD\uC11C \uC791\uC131")',
    'a:has-text("\uC2E0\uCCAD\uC11C \uC791\uC131")'
  ];
  let resolvedDetail = await waitForMndElement(workPage, detailButtonSelectors, { timeoutMs: 8000, visibleOnly: false });
  if (!resolvedDetail) {
    await prepareWorkPage({ scrollBottom: true });
    resolvedDetail = await waitForMndElement(workPage, detailButtonSelectors, { timeoutMs: 6000, visibleOnly: false });
  }
  if (!resolvedDetail) {
    log('warn', '[MND] 상세페이지 전환이 감지되지 않아 SBGrid 컨트롤러를 호출합니다.');
    const fallback = await openBidDetailViaController({ rowOffset: 0 });
    if (fallback) {
      await prepareWorkPage({ scrollBottom: true });
      resolvedDetail = await waitForMndElement(workPage, detailButtonSelectors, { timeoutMs: 8000, visibleOnly: false });
    }
  }
  if (!resolvedDetail) {
    await dumpMndState(workPage, emit, 'bid_detail_missing');
    throw new Error('[MND] 입찰공고 상세의 "입찰참가신청서 작성" 버튼을 찾지 못했습니다.');
  }

  await prepareWorkPage({ scrollBottom: true });
  try {
    await resolvedDetail.scrollIntoViewIfNeeded?.().catch(() => {});
    await resolvedDetail.focus?.().catch(() => {});
  } catch {}
  await clickAndAdopt(resolvedDetail, { waitMs: 8000 });
  await adoptPageByPattern([/writeOath/i, /oath/i]);
  try { await closeMndBidGuideModal(workPage, emit, { timeoutMs: 4000 }); } catch {}

  const agreementPresence = await waitForMndElement(workPage, [
    '#c_box1',
    '#c_box2',
    '#c_box3',
    'input[name="subcont_dir_pay_yn" i]',
    '#btn_confirm',
    'button:has-text("\uD655\uC778")'
  ], { timeoutMs: 7000, visibleOnly: false });
  if (!agreementPresence) {
    await dumpMndState(workPage, emit, 'agreement_page_missing');
    throw new Error('[MND] 서약서 동의 페이지를 확인하지 못했습니다.');
  }

  const ensureAgreementSelections = async () => {
    await workPage.evaluate(() => {
      const mark = (el) => {
        if (!el) return;
        if (el.type === 'checkbox' || el.type === 'radio') {
          el.checked = true;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      };
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        if (!style || style.visibility === 'hidden' || style.display === 'none') return false;
        return true;
      };
      const withRect = (els) => els
        .filter(isVisible)
        .map(el => ({ el, rect: el.getBoundingClientRect() }))
        .sort((a, b) => (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left))
        .map(item => item.el);

      const checkboxTargets = withRect(Array.from(document.querySelectorAll('input[type="checkbox"]')));
      checkboxTargets.slice(0, 4).forEach(mark);

      const radios = withRect(Array.from(document.querySelectorAll('input[type="radio"]')));
      const findText = (el) => {
        const label = el.closest('label');
        if (label && label.innerText) return label.innerText.replace(/\s+/g, '');
        const labelled = document.querySelector(`label[for="${el.id}"]`);
        if (labelled && labelled.innerText) return labelled.innerText.replace(/\s+/g, '');
        const parentText = (el.parentElement?.innerText || el.title || el.getAttribute('aria-label') || '').replace(/\s+/g, '');
        return parentText;
      };
      const optionOne = radios.find(r => /선택1|Select1|Option1|①/.test(findText(r) || '')) || radios[0];
      mark(optionOne);
    }).catch(() => {});
  };

  const agreementButtonSelectors = [
    '#btn_confirm',
    'button:has-text("\uD655\uC778")',
    '.btn_area button:has-text("\uD655\uC778")',
    '.btn_box button:has-text("\uD655\uC778")',
    'a:has-text("\uD655\uC778")'
  ];

  await ensureAgreementSelections();

  const finalConfirm = await waitForMndElement(workPage, agreementButtonSelectors, { timeoutMs: 6000, visibleOnly: true });
  if (!finalConfirm) {
    await dumpMndState(workPage, emit, 'agreement_confirm_missing');
    throw new Error('[MND] 서약서 동의 화면에서 확인 버튼을 찾지 못했습니다.');
  }
  await clickAndAdopt(finalConfirm, { waitMs: 6000 });
  log('info', '[MND] 서약서 동의 및 확인을 완료했습니다.');

  return { ok: true, page: workPage };
}

async function ensureMndRowSelection(page) {
  const rowSelectors = [
    'table tbody tr td:has-text("\uBB3C\uD488\uBA85")',
    'table tbody tr'
  ];
  let row = null;
  for (const ratio of [0, 0.3, 0.6, 0.9]) {
    if (!row) {
      try {
        await page.evaluate((r) => {
          const doc = document.documentElement || document.body;
          const h = doc?.scrollHeight || document.body?.scrollHeight || 0;
          window.scrollTo?.(0, Math.max(0, Math.min(1, r)) * h);
        }, ratio);
      } catch {}
      try { await page.waitForTimeout?.(200); } catch {}
      row = await waitForMndElement(page, rowSelectors, { timeoutMs: 1500, visibleOnly: true });
    }
  }
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
  const scrollToSection = async (ratio = 1) => {
    try {
      await page.evaluate((r) => {
        const doc = document.documentElement || document.body;
        const height = doc?.scrollHeight || document.body?.scrollHeight || 0;
        const target = Math.max(0, Math.min(1, r)) * height;
        window.scrollTo?.(0, target);
      }, ratio);
    } catch {}
    try { await page.waitForTimeout?.(200); } catch {}
  };
  await scrollToSection(0.4);
  const selectDepositWaiver = async () => {
    const waiverSelectors = [
      'select[name*="guar" i]',
      'select#guarDivs',
      'select[id*="guar" i]',
      'select:has(option:has-text("\uBAA8\uB4DD\uAE08\uBA74\uC81C"))'
    ];
    const select = await waitForMndElement(page, waiverSelectors, { timeoutMs: 5000, visibleOnly: true });
    if (!select) return false;
    try {
      await select.scrollIntoViewIfNeeded?.().catch(() => {});
      await select.selectOption?.({ label: '보증금면제' }).catch(async () => {
        await select.selectOption?.({ value: 'E' }).catch(() => select.type?.('보증금면제', { delay: 20 }));
      });
      await select.dispatchEvent?.('change').catch(() => {});
      log('info', '[MND] 보증금면제 옵션을 선택했습니다.');
    } catch (err) {
      log('warn', `[MND] 보증금면제 선택 실패: ${(err && err.message) || err}`);
    }
    return true;
  };
  const ensureDepositWaiverPopup = async () => {
    await selectDepositWaiver();
    const ctx = typeof page.context === 'function' ? page.context() : null;
    const popup = ctx ? ctx.pages().find(pg => {
      try {
        const url = typeof pg.url === 'function' ? pg.url() : '';
        const title = typeof pg.title === 'function' ? pg.title().catch(() => '') : '';
        return /guar|deposit|보증금/.test(url || '') || /보증금/.test(title || '');
      } catch { return false; }
    }) : null;
    if (popup) {
      try { await popup.waitForLoadState?.('domcontentloaded', { timeout: 5000 }); } catch {}
      try { await popup.bringToFront?.(); } catch {}
      try { await page.waitForTimeout?.(200); } catch {}
      try {
        await popup.evaluate(() => {
          const mark = (el) => {
            if (!el) return;
            if (el.type === 'checkbox' || el.type === 'radio') {
              el.checked = true;
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          };
          document.querySelectorAll('input[type="checkbox"]').forEach(mark);
        });
        const confirm = await popup.$('button:has-text("확인"), #btn_confirm');
        if (confirm) {
          await confirm.click({ force:true }).catch(() => confirm.evaluate(el => el && el.click()));
        }
      } catch (err) {
        log('warn', `[MND] 보증금면제 팝업 처리 실패: ${(err && err.message) || err}`);
      }
      try { await popup.close?.({ runBeforeUnload: true }); } catch {}
      await page.bringToFront?.().catch(() => {});
    }
  };
  const ensureTermsAgreement = async () => {
    const termBoxes = [
      '#agreeTerms',
      'input[name*="terms" i]',
      'input[type="checkbox"]:near(:text("약관"))'
    ];
    const checkbox = await waitForMndElement(page, termBoxes, { timeoutMs: 4000, visibleOnly: false });
    if (checkbox) {
      try {
        await checkbox.scrollIntoViewIfNeeded?.().catch(() => {});
        const checked = await checkbox.isChecked?.().catch(() => false);
        if (!checked) await checkbox.check?.({ force:true }).catch(() => checkbox.click({ force:true }));
        log('info', '[MND] 약관 동의 체크 완료');
      } catch (err) {
        log('warn', `[MND] 약관 동의 체크 실패: ${(err && err.message) || err}`);
      }
    }
  };
  await ensureDepositWaiverPopup();
  await scrollToSection(0.8);
  await ensureTermsAgreement();
  await scrollToSection(0.95);
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

module.exports = {
  loginMnd,
  handleMndCertificate,
  goToMndAgreementAndSearch,
  applyMndAgreementAfterSearch,
  closeMndBidGuideModal,
  installMndPopupGuards
};
