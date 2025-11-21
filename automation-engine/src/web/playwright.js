"use strict";

let pw = null;
function requirePlaywright(emit){
  try { return require('playwright'); } catch (e) {
    emit && emit({ type:'error', msg:'Playwright 미설치: automation-engine 디렉터리에서 "npm i -D playwright" 후 "npx playwright install chromium"을 실행해 주세요.' });
    throw e;
  }
}

const { loginKepco, closeKepcoPostLoginModals } = require('../sites/kepco');
const { loginMnd, closeMndBidGuideModal } = require('../sites/mnd');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { attachPopupAutoCloser, dismissCommonOverlays } = require('./popups');

function ensureCleanProfileExitFlags(profileDir, emit){
  if (!profileDir) return;
  const patchFile = (fileName) => {
    const target = path.join(profileDir, fileName);
    let data = {};
    let dirty = false;
    if (fs.existsSync(target)) {
      try {
        const raw = fs.readFileSync(target, 'utf-8');
        data = JSON.parse(raw);
      } catch (err) {
        emit && emit({ type:'log', level:'warn', msg:`[browser] ${fileName} 파싱 실패, 새로 생성합니다: ${(err && err.message) || err}` });
        data = {};
      }
    }
    if (!data || typeof data !== 'object') data = {};
    const profile = (typeof data.profile === 'object' && data.profile) || {};
    if (profile.exit_type !== 'None') { profile.exit_type = 'None'; dirty = true; }
    if (profile.exited_cleanly !== true) { profile.exited_cleanly = true; dirty = true; }
    data.profile = profile;
    if (data.exit_type && data.exit_type !== 'None') { data.exit_type = 'None'; dirty = true; }
    if (data.exited_cleanly !== undefined && data.exited_cleanly !== true) { data.exited_cleanly = true; dirty = true; }
    if (!fs.existsSync(target)) dirty = true;
    if (dirty) {
      try {
        fs.writeFileSync(target, JSON.stringify(data, null, 2));
        emit && emit({ type:'log', level:'debug', msg:`[browser] ${fileName}에 clean-exit 플래그 설정` });
      } catch (err) {
        emit && emit({ type:'log', level:'warn', msg:`[browser] ${fileName} 쓰기 실패: ${(err && err.message) || err}` });
      }
    }
  };
  patchFile('Preferences');
  patchFile('Local State');
}

function resetAutomationProfileDir(profileDir, emit){
  if (!profileDir) return;
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
    emit && emit({ type:'log', level:'info', msg:`[browser] 자동화 프로필을 초기화했습니다: ${profileDir}` });
  } catch (err) {
    emit && emit({ type:'log', level:'warn', msg:`[browser] 프로필 초기화 실패(${profileDir}): ${(err && err.message) || err}` });
  }
}

// Edge 전용 자동화 프로필 재사용 시 깨끗한 종료 상태를 만들어 복구 팝업을 방지한다.

async function openAndPrepareLogin(job, emit, outDir){
  pw = requirePlaywright(emit);
  const debug = job?.options?.debug === true;
  const headless = job?.options?.headless === true;
  const slowMo = debug ? 250 : 0;
  const viewport = { width: 1280, height: 900 };

  const requestedBrowser = String(job?.options?.browser || 'edge').toLowerCase();
  const browserChannelMap = {
    chrome: 'chrome',
    edge: 'msedge',
    msedge: 'msedge'
  };
  const browserChannel = browserChannelMap[requestedBrowser] || null;
  const browserLabel = browserChannel === 'msedge' ? 'Edge'
    : browserChannel === 'chrome' ? 'Chrome'
    : 'Chromium';
  const useAutomationProfile = job?.options?.useAutomationProfile !== false;
  const resetAutomationProfile = job?.options?.resetAutomationProfile !== false;
  const automationProfileDir = job?.options?.automationProfileDir
    || path.join(os.homedir(), '.automation-engine', `${browserLabel.toLowerCase()}-profile`);
  const requestedPermissions = Array.isArray(job?.options?.browserPermissions)
    ? job.options.browserPermissions.filter(Boolean)
    : [];
  const defaultLaunchArgs = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble'
  ];
  const launchArgs = [...defaultLaunchArgs];
  if (Array.isArray(job?.options?.browserLaunchArgs)) {
    launchArgs.push(...job.options.browserLaunchArgs);
  }
  if (Array.isArray(job?.options?.edgeLaunchArgs)) {
    // 레거시 옵션 호환
    launchArgs.push(...job.options.edgeLaunchArgs);
  }
  const reuseProfile = job?.options?.reuseEdgeProfile === true;
  const profileRoot = job?.options?.edgeUserDataDir
    || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'Edge', 'User Data');
  const profileDirName = job?.options?.edgeProfileDir || 'Default';

  const persistentOpts = (channel, extra = {}) => ({
    headless,
    slowMo,
    viewport,
    args: launchArgs,
    ...(channel ? { channel } : {}),
    ...extra
  });

  const launchOpts = (channel) => ({
    headless,
    slowMo,
    args: launchArgs,
    ...(channel ? { channel } : {})
  });

  let browser = null;
  let ctx = null;

  if (reuseProfile && profileRoot) {
    const persistentArgs = launchArgs.slice();
    if (!persistentArgs.some(arg => typeof arg === 'string' && arg.toLowerCase().startsWith('--profile-directory='))) {
      persistentArgs.push(`--profile-directory=${profileDirName}`);
    }
    try {
      ctx = await pw.chromium.launchPersistentContext(profileRoot, persistentOpts('msedge', { args: persistentArgs }));
      browser = ctx.browser();
      emit && emit({ type:'log', level:'info', msg:`[browser] Reusing Edge profile (${profileRoot})` });
    } catch (err) {
      const reason = (err && err.message) || String(err);
      const hint = 'Edge 브라우저가 이미 실행 중입니다. 모든 Edge 창을 닫은 뒤 다시 실행해 주세요.';
      emit && emit({ type:'log', level:'error', msg: `[browser] ${hint} (자세한 정보: ${reason})` });
      return { ok:false, error: hint };
    }
  }

  if (!ctx && useAutomationProfile) {
    if (resetAutomationProfile) {
      resetAutomationProfileDir(automationProfileDir, emit);
    }
    try {
      fs.mkdirSync(automationProfileDir, { recursive: true });
    } catch (err) {
      emit && emit({ type:'log', level:'warn', msg:`[browser] 프로필 디렉터리 생성 실패(${automationProfileDir}): ${(err && err.message) || err}` });
    }
    ensureCleanProfileExitFlags(automationProfileDir, emit);
    try {
      ctx = await pw.chromium.launchPersistentContext(automationProfileDir, persistentOpts(browserChannel));
    } catch (err) {
      if (browserChannel) {
        emit && emit({ type:'log', level:'warn', msg:`[browser] ${browserLabel} 채널 실행 실패, Chromium으로 재시도 (${(err && err.message) || err})` });
        ctx = await pw.chromium.launchPersistentContext(automationProfileDir, persistentOpts(null));
      } else {
        throw err;
      }
    }
    browser = ctx.browser();
    emit && emit({ type:'log', level:'info', msg:`[browser] 전용 ${browserLabel} 프로필 사용: ${automationProfileDir}` });
  }

  if (!ctx) {
    const tryBrowserLaunch = async (channel) => {
      try { return await pw.chromium.launch(launchOpts(channel)); }
      catch (err) {
        if (channel) {
          emit && emit({ type:'log', level:'warn', msg:`[browser] ${browserLabel} 채널 실행 실패, Chromium으로 재시도 (${(err && err.message) || err})` });
          return await pw.chromium.launch(launchOpts(null));
        }
        throw err;
      }
    };
    browser = await tryBrowserLaunch(browserChannel);
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
  if (requestedPermissions.length) {
    try {
      const origin = new URL(url).origin;
      await ctx.grantPermissions(requestedPermissions, { origin });
      emit && emit({ type:'log', level:'info', msg:`[browser] 권한 부여: ${requestedPermissions.join(', ')} @ ${origin}` });
    } catch (err) {
      emit && emit({ type:'log', level:'warn', msg:`[browser] 권한 부여 실패: ${(err && err.message) || err}` });
    }
  }
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  emit && emit({ type:'log', level:'info', msg:`페이지 접속: ${await page.title().catch(()=>url)} (${page.url()})` });
  await dismissCommonOverlays(page, emit);

  const site = (job?.site || '').toLowerCase();
  try {
    const hasId = !!(job?.auth?.id);
    const hasPw = !!(job?.auth?.pw);
    emit && emit({ type:'log', level:'info', msg:`자격정보 존재 여부: id=${hasId}, pw=${hasPw}` });
    if (site === 'kepco') {
      const newPage = await loginKepco(page, emit, job?.auth || {});
      if (newPage) page = newPage;
      try { await closeKepcoPostLoginModals(page, emit, { abortOnCertModal: true }); } catch {}
    } else if (site === 'mnd') {
      const newPage = await loginMnd(page, emit, job?.auth || {});
      if (newPage) page = newPage;
      try { await closeMndBidGuideModal(page, emit); } catch {}
    } else {
      emit && emit({ type:'log', level:'warn', msg:`알 수 없는 사이트 '${site}', 기본 로그인 버튼 탐색을 시도합니다.` });
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
      emit && emit({ type:'log', level:'error', msg:`HTML 덤프 저장: ${htmlPath}` });
    } catch {}
    // Optional pause to observe before closing
    const pauseMs = Number(job?.options?.pauseOnErrorMs) || 5000;
    if (pauseMs > 0) { try { await page.waitForTimeout(pauseMs); } catch {} }
    try { await ctx?.close?.(); } catch {}
    try { await browser?.close?.(); } catch {}
    return { ok:false, error: String(e) };
  }

  // 추후 진단: 로그인 입력값이 실제로 채워졌는지 추가 확인 (필요한 경우)
  try {
    const hasPwField = await page.$('input[type="password"]').catch(()=>null);
    if (hasPwField) {
      const v = await page.evaluate(el => el && el.value, hasPwField).catch(()=>null);
      if (!v) emit && emit({ type:'log', level:'warn', msg:'주의: 비밀번호 입력 필드 값이 비어 있을 수 있습니다.' });
    }
  } catch {}
  // 여기까지: 인증서 선택 자동화 모듈 호출 직전 상태 유지
  // 네이티브(UIA) 처리까지 위해 브라우저와 페이지 핸들을 반환
  return { ok:true, site, browser, context: ctx, page };
}

async function clickCommonLogin(page, emit){
  // 일반 케이스: aria 라벨 기반 로그인 버튼 탐색
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
      emit && emit({ type:'log', level:'info', msg:`로그인 후보 클릭: ${sel}` });
      return;
    }
  }
  throw new Error('로그인 버튼을 찾지 못했습니다. 셀렉터 보완이 필요합니다.');
}

async function fillCommonCredentials(page, auth, emit){
  const idSel = ['input[name*=id i]','input[id*=id i]','input[name*=userid i]','input[id*=userid i]','input[type="text"]'];
  const pwSel = ['input[type="password"]','input[name*=pw i]','input[id*=pw i]'];
  let idBox = null, pwBox = null;
  for (const s of idSel){ idBox = await page.$(s); if (idBox) break; }
  for (const s of pwSel){ pwBox = await page.$(s); if (pwBox) break; }
  if (!idBox || !pwBox) throw new Error('ID/PW 입력창을 찾지 못했습니다.');
  await idBox.fill(auth.id || '');
  await pwBox.fill(auth.pw || '');
  const submitSel = ['button[type="submit"]','button:has-text("\uB85C\uADF8\uC778")','input[type="submit"]'];
  for (const s of submitSel){ const el = await page.$(s); if (el){ await el.click(); break; } }
  emit && emit({ type:'log', level:'info', msg:'일반 ID/PW 로그인 시도(비밀번호는 로그에 기록되지 않음)' });
}

module.exports = { openAndPrepareLogin };
