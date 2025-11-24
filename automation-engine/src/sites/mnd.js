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
        const btn = node.querySelector('button, a, [role="button"], .btn');
        if (btn && typeof btn.click === 'function') {
          btn.click();
        } else if (typeof node.remove === 'function') {
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
            const btn = dialog.querySelector('button, a');
            if (btn) btn.click();
          }
          const nodes = Array.from(document.querySelectorAll('div, section, article'));
          for (const node of nodes) {
            const txt = (node.textContent || '').replace(/\s+/g, '');
            if (guidetext.test(txt)) {
              const btn = node.querySelector('button, a, [role="button"]');
              if (btn) { btn.click(); return; }
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
        layers.forEach(el => {
          const txt = (el.textContent || '').replace(/\s+/g, '');
          if (/입찰서\s*작성안내/.test(txt) || el.id === 'mask') {
            el.style.display = 'none';
            if (typeof el.remove === 'function') el.remove();
            hit = 'removed';
          }
        });
        const dialog = document.querySelector('#alertLayer, #alertModal, .alertLayer');
        if (dialog) {
          dialog.style.display = 'none';
          if (typeof dialog.remove === 'function') dialog.remove();
          hit = 'removed';
        }
        const btn = document.querySelector('#alertLayer button, #alertLayer a, .alertLayer button, .alertLayer a');
        if (btn) {
          btn.click();
          hit = 'button';
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
        const texts = ['닫기', '확인', '확인하기', '예'];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        while (walker.nextNode()) {
          const el = walker.currentNode;
          const text = (el.innerText || el.textContent || '').replace(/\s+/g, '');
          if (!text) continue;
          if (/입찰서.*작성안내/.test(text) || texts.some(t => text.includes(t))) {
            if (typeof el.click === 'function') {
              el.click();
              return 'text';
            }
          }
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

  const workPage = await resolveWorkPage() || page;
  try {
    const resolvedUrl = workPage && typeof workPage.url === 'function' ? workPage.url() : '';
    if (resolvedUrl) log('debug', `[MND] 작업 페이지: ${resolvedUrl}`);
  } catch {}
  if (workPage && workPage !== page) {
    try { await installMndPopupGuards(workPage, emit); } catch {}
  }

  const menuSelectors = [
    'a:has-text("\uC785\uCC30\uACF5\uACE0")',
    'a:has-text("\uACF5\uACE0" i)',
    'a[href*="bidAnnounce" i]'
  ];
  const clickBidMenu = async () => {
    const link = await findInMndContexts(workPage, menuSelectors, { visibleOnly: true });
    if (!link) {
      log('warn', '[MND] 좌측 "입찰공고" 메뉴를 찾지 못했습니다.');
      return;
    }
    try {
      await link.scrollIntoViewIfNeeded?.();
      await link.click({ force:true }).catch(()=>link.evaluate(el => el && el.click()));
    log('info', '[MND] 좌측 "입찰공고" 메뉴를 클릭했습니다.');
    } catch (err) {
      log('warn', `[MND] "입찰공고" 메뉴 클릭 실패: ${(err && err.message) || err}`);
    }
    try { await workPage.waitForTimeout(800); } catch {}
  };

  try { await closeMndBidGuideModal(workPage, emit, { timeoutMs: 5000 }); } catch {}
  await clickBidMenu();

  if (!digits) return { ok: true, page: workPage };

  const inputSelectors = [
    '#numb_divs',
    'input[name="numb_divs" i]',
    'input[title*="G2B" i]',
    'input[placeholder*="G2B" i]',
    'input[title*="\uACF5\uACE0" i]',
    'input[placeholder*="\uACF5\uACE0" i]',
    'input[name*="gonggo" i]',
    'input[id*="gonggo" i]',
    'input[name*="bid" i]',
    'input[id*="bid" i]'
  ];
  const input = await waitForMndElement(workPage, inputSelectors, { timeoutMs: 6000, visibleOnly: true });
  if (!input) {
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
    'button:has-text("\uAC80\uC0C9")',
    'button:has-text("\uAC80\uC0AC")',
    'button:has-text("\uC870\uD68C")',
    'a:has-text("\uC870\uD68C")'
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
  await waitForMndResults(workPage);

  const firstRowSelectors = [
    '.table tbody tr:not(.empty) td a',
    '.tb_list tbody tr:first-child td a',
    '.grid-body tr:first-child a',
    'table tbody tr:first-child a'
  ];
  const first = await waitForMndElement(workPage, firstRowSelectors, { timeoutMs: 6000, visibleOnly: true });
  if (!first) {
    await dumpMndState(workPage, emit, 'bid_results_missing');
    throw new Error('[MND] 공고 검색 결과를 찾지 못했습니다.');
  }
  try {
    await first.scrollIntoViewIfNeeded?.();
    await first.click({ force:true });
    log('info', '[MND] 공고 검색 후 첫 공고를 클릭했습니다.');
  } catch (err) {
    log('warn', `[MND] 검색 결과 클릭 실패: ${(err && err.message) || err}`);
    throw err;
  }

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

module.exports = {
  loginMnd,
  handleMndCertificate,
  goToMndAgreementAndSearch,
  applyMndAgreementAfterSearch,
  closeMndBidGuideModal,
  installMndPopupGuards
};
