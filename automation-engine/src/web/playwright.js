"use strict";

let pw = null;
function requirePlaywright(emit){
  try { return require('playwright'); } catch (e) {
    emit && emit({ type:'error', msg:'Playwright 미설? automation-engine ?렉?리?서 npm i -D playwright && npx playwright install chromium ??행?세??' });
    throw e;
  }
}

const { loginKepco } = require('../sites/kepco');
const { loginMnd } = require('../sites/mnd');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { attachPopupAutoCloser, dismissCommonOverlays } = require('./popups');

async function openAndPrepareLogin(job, emit, outDir){
  pw = requirePlaywright(emit);
  const debug = job?.options?.debug === true;
  const headless = job?.options?.headless === true;
  const slowMo = debug ? 250 : 0;
  const viewport = { width: 1280, height: 900 };

  const reuseProfile = job?.options?.reuseEdgeProfile !== false;
  const profileRoot = job?.options?.edgeUserDataDir
    || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'Edge', 'User Data');
  const profileDirName = job?.options?.edgeProfileDir || 'Default';
  const launchArgs = Array.isArray(job?.options?.edgeLaunchArgs) ? [...job.options.edgeLaunchArgs] : [];

  let browser = null;
  let ctx = null;
  if (reuseProfile && profileRoot) {
    const persistentArgs = launchArgs.slice();
    if (!persistentArgs.some(arg => typeof arg === 'string' && arg.toLowerCase().startsWith('--profile-directory='))) {
      persistentArgs.push(`--profile-directory=${profileDirName}`);
    }
    try {
      ctx = await pw.chromium.launchPersistentContext(profileRoot, {
        channel: 'msedge',
        headless,
        slowMo,
        viewport,
        args: persistentArgs
      });
      browser = ctx.browser();
      emit && emit({ type:'log', level:'info', msg:`[browser] Reusing Edge profile (${profileRoot})` });
    } catch (err) {
      const reason = (err && err.message) || String(err);
      const hint = 'Edge 브라우저가 이미 실행 중입니다. 모든 Edge 창을 닫은 뒤 다시 실행해 주세요.';
      emit && emit({ type:'log', level:'error', msg: `[browser] ${hint} (자세한 정보: ${reason})` });
      return { ok:false, error: hint };
    }
  }

  if (!ctx) {
    browser = await pw.chromium
      .launch({ headless, channel: 'msedge', slowMo, args: launchArgs })
      .catch(async () => pw.chromium.launch({ headless, slowMo, args: launchArgs }));
    ctx = await browser.newContext({ viewport });
  }

  // auto-close notice/event popups across the context
  attachPopupAutoCloser(ctx, emit);
  let page = await ctx.newPage();
  const url = job?.url || '';
  if (!url) {
    try { await ctx?.close?.(); } catch {}
    try { await browser?.close?.(); } catch {}
    return { ok:false, error:'URL not configured (job.url missing)' };
  }
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  emit && emit({ type:'log', level:'info', msg:`?이지 ?속: ${await page.title().catch(()=>url)} (${page.url()})` });
  await dismissCommonOverlays(page, emit);

  const site = (job?.site || '').toLowerCase();
  try {
    const hasId = !!(job?.auth?.id);
    const hasPw = !!(job?.auth?.pw);
    emit && emit({ type:'log', level:'info', msg:`?격?보 존재 ??: id=${hasId}, pw=${hasPw}` });
    if (site === 'kepco') {
      const newPage = await loginKepco(page, emit, job?.auth || {});
      if (newPage) page = newPage;
    } else if (site === 'mnd') {
      const newPage = await loginMnd(page, emit, job?.auth || {});
      if (newPage) page = newPage;
    } else {
      emit && emit({ type:'log', level:'warn', msg:`Unknown site '${site}', 기본 로그??버튼 ?색 ?도` });
      if (job?.auth?.id && job?.auth?.pw) {
        await fillCommonCredentials(page, job.auth, emit);
      } else {
        await clickCommonLogin(page, emit);
      }
    }
  } catch (e) {
    // Capture HTML for debugging
    try {
      const htmlPath = path.join(outDir, '02_login_error.html');
      fs.writeFileSync(htmlPath, await page.content(), 'utf-8');
      emit && emit({ type:'log', level:'error', msg:`HTML ??? ${htmlPath}` });
    } catch {}
    // Optional pause to observe before closing
    const pauseMs = Number(job?.options?.pauseOnErrorMs) || 5000;
    if (pauseMs > 0) { try { await page.waitForTimeout(pauseMs); } catch {} }
    try { await ctx?.close?.(); } catch {}
    try { await browser?.close?.(); } catch {}
    return { ok:false, error: String(e) };
  }

  // 추? 진단: 로그???력값이 존재?는지 ?플 체크 (가?한 경우)
  try {
    const hasPwField = await page.$('input[type="password"]').catch(()=>null);
    if (hasPwField) {
      const v = await page.evaluate(el => el && el.value, hasPwField).catch(()=>null);
      if (!v) emit && emit({ type:'log', level:'warn', msg:'주의: 비?번호 ?드 값이 비어?을 ???습?다.' });
    }
  } catch {}
  // ?기까?: ?증???택 ????이?브 모듈 ?계 직전 ?태
  // ?이?브(UIA) 처리??해 브라????? ?고 ?들??반환
  return { ok:true, site, browser, context: ctx, page };
}

async function clickCommonLogin(page, emit){
  // ?한 ?스??aria ?벨 기반 로그??버튼 ?색
  const candidates = [
    'text=/\uACF5\uB3D9\uC778\uC99D/',
    'text=/\uACF5\uC778\uC99D/',
    'text=/\uB85C\uADF8\uC778/',
    '[aria-label*="\uC778\uC99D" i]',
    '[aria-label*="\uB85C\uADF8\uC778" i]',
    'button:has-text("\uC778\uC99D")',
    'button:has-text("\uB85C\uADF8\uC778")'
  ];
  for (const sel of candidates){
    const el = await page.$(sel);
    if (el){
      await el.click();
      emit && emit({ type:'log', level:'info', msg:`로그???리??릭: ${sel}` });
      return;
    }
  }
  throw new Error('로그??버튼??찾? 못했?니?? ??터 보완???요?니??');
}

async function fillCommonCredentials(page, auth, emit){
  const idSel = ['input[name*=id i]','input[id*=id i]','input[name*=userid i]','input[id*=userid i]','input[type="text"]'];
  const pwSel = ['input[type="password"]','input[name*=pw i]','input[id*=pw i]'];
  let idBox = null, pwBox = null;
  for (const s of idSel){ idBox = await page.$(s); if (idBox) break; }
  for (const s of pwSel){ pwBox = await page.$(s); if (pwBox) break; }
  if (!idBox || !pwBox) throw new Error('ID/PW ?력창을 찾? 못했?니??');
  await idBox.fill(auth.id || '');
  await pwBox.fill(auth.pw || '');
  const submitSel = ['button[type="submit"]','button:has-text("로그??)','input[type="submit"]'];
  for (const s of submitSel){ const el = await page.$(s); if (el){ await el.click(); break; } }
  emit && emit({ type:'log', level:'info', msg:'?반 ID/PW 로그???도(비?번호??로그??기록?? ?음)' });
}

module.exports = { openAndPrepareLogin };









