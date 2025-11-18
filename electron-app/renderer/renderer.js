// Tab switching
const tabs = document.querySelectorAll('.tab');
const views = {
  main: document.getElementById('tab-main'),
  settings: document.getElementById('tab-settings'),
};
tabs.forEach(btn => btn.addEventListener('click', () => {
  tabs.forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  Object.values(views).forEach(v => v.classList.remove('active'));
  const v = views[btn.dataset.tab];
  if (v) v.classList.add('active');
}));

// Settings load/save (URLs, companies, accounts)
let settingsCache = { urls:{}, companies:[], options:{ certTimeoutSec:60 } };;
let lastErrorToastMessage = '';
let toastOverlay = null;

function ensureCompanyDefaults(company) {
  if (!company) return;
  company.cert = company.cert || {};
  company.auth = company.auth || {};
  company.auth.kepco = company.auth.kepco || {};
  company.auth.kepco.id = company.auth.kepco.id || '';
  company.auth.kepco.pw = company.auth.kepco.pw || '';
  company.auth.mnd = company.auth.mnd || {};
  company.auth.mnd.id = company.auth.mnd.id || '';
  company.auth.mnd.pw = company.auth.mnd.pw || '';
}

function cleanupSettingsBeforeSave() {
  delete settingsCache.accounts;
  (settingsCache.companies || []).forEach(ensureCompanyDefaults);
}

async function persistSettings() {
  cleanupSettingsBeforeSave();
  return await window.api.saveSettings(settingsCache);
}

function renderCompanyList() {
  const list = document.getElementById('companyList');
  list.innerHTML = '';
  settingsCache.companies = settingsCache.companies || [];
  settingsCache.companies.forEach((c, idx) => {
    ensureCompanyDefaults(c);
    const item = document.createElement('div');
    item.className = 'company-item';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = `${c.name}`;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = `BizNo: ${c.bizNo} · Representative: ${c.representative || '-'}`;
    meta.appendChild(name); meta.appendChild(sub);
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      settingsCache.companies.splice(idx, 1);
      renderCompanyList();
      renderCompanySelect();
      renderCompanyCertSelect();
      renderCompanyAuthSelect();
      persistSettings();
    });
    item.appendChild(meta); item.appendChild(del);
    list.appendChild(item);
  });
}

function renderCompanySelect(){
  const sel = document.getElementById('companySelect');
  sel.innerHTML = '';
  (settingsCache.companies || []).forEach((c, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${c.name} (${c.bizNo})`;
    sel.appendChild(opt);
  });
  if (sel.options.length > 0) sel.selectedIndex = 0;
  renderCompanyAuthSelect();
}

function renderCompanyCertSelect(){
  const sel = document.getElementById('companyCertSelect');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '';
  (settingsCache.companies || []).forEach((c, i) => {
    ensureCompanyDefaults(c);
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${c.name} (${c.bizNo})`;
    sel.appendChild(opt);
  });
  if (prev && Array.from(sel.options).some(o => o.value === prev)) {
    sel.value = prev;
  } else if (sel.options.length > 0) {
    sel.selectedIndex = 0;
  }
  fillCompanyCertForm();
}
function fillCompanyCertForm(){
  const sel = document.getElementById('companyCertSelect');
  const idx = sel && sel.value ? parseInt(sel.value, 10) : 0;
  const c = (settingsCache.companies || [])[idx] || {};
  ensureCompanyDefaults(c);
  const cert = c.cert || {};
  document.getElementById('compCertSubject').value = cert.subjectMatch || '';
  document.getElementById('compCertIssuer').value = cert.issuerMatch || '';
  document.getElementById('compCertSerial').value = cert.serialMatch || '';
  document.getElementById('compCertMedia').value = cert.media || 'hdd';
  const pathEl = document.getElementById('compCertPath'); if (pathEl) pathEl.value = cert.path || '';
  document.getElementById('compCertPin').value = cert.pin || '';
  const authSel = document.getElementById('companyAuthSelect');
  if (authSel && sel) {
    authSel.value = sel.value;
    fillCompanyAuthForm();
  }
}

function renderCompanyAuthSelect(){
  const sel = document.getElementById('companyAuthSelect');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '';
  (settingsCache.companies || []).forEach((c, i) => {
    ensureCompanyDefaults(c);
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${c.name} (${c.bizNo})`;
    sel.appendChild(opt);
  });
  if (prev && Array.from(sel.options).some(o => o.value === prev)) {
    sel.value = prev;
  } else if (sel.options.length > 0) {
    sel.selectedIndex = 0;
  }
  fillCompanyAuthForm();
}

function fillCompanyAuthForm(){
  const sel = document.getElementById('companyAuthSelect');
  const idx = sel && sel.value ? parseInt(sel.value, 10) : 0;
  const c = (settingsCache.companies || [])[idx] || null;
  if (!c) {
    ['compAuthKepcoId','compAuthKepcoPw','compAuthMndId','compAuthMndPw'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    return;
  }
  ensureCompanyDefaults(c);
  const kepco = c.auth.kepco || {};
  const mnd = c.auth.mnd || {};
  const kepcoIdEl = document.getElementById('compAuthKepcoId'); if (kepcoIdEl) kepcoIdEl.value = kepco.id || '';
  const kepcoPwEl = document.getElementById('compAuthKepcoPw'); if (kepcoPwEl) kepcoPwEl.value = kepco.pw || '';
  const mndIdEl = document.getElementById('compAuthMndId'); if (mndIdEl) mndIdEl.value = mnd.id || '';
  const mndPwEl = document.getElementById('compAuthMndPw'); if (mndPwEl) mndPwEl.value = mnd.pw || '';
}


async function loadSettings() {
  const s = await window.api.loadSettings();
  const legacyAccounts = s.accounts || {};
  settingsCache = {
    urls: { kepco: '', mnd: '', ...(s.urls || {}) },
    companies: Array.isArray(s.companies) ? s.companies.map((company) => {
      const clone = { ...company };
      ensureCompanyDefaults(clone);
      if (legacyAccounts.kepco) {
        if (!clone.auth.kepco.id && legacyAccounts.kepco.id) clone.auth.kepco.id = legacyAccounts.kepco.id;
        if (!clone.auth.kepco.pw && legacyAccounts.kepco.pw) clone.auth.kepco.pw = legacyAccounts.kepco.pw;
      }
      if (legacyAccounts.mnd) {
        if (!clone.auth.mnd.id && legacyAccounts.mnd.id) clone.auth.mnd.id = legacyAccounts.mnd.id;
        if (!clone.auth.mnd.pw && legacyAccounts.mnd.pw) clone.auth.mnd.pw = legacyAccounts.mnd.pw;
      }
      return clone;
    }) : [],
    options: { certTimeoutSec: 60, ...(s.options || {}) }
  };
  document.getElementById('urlKepco').value = settingsCache.urls.kepco || '';
  document.getElementById('urlMnd').value = settingsCache.urls.mnd || '';
  const certTimeoutInput = document.getElementById('certTimeoutSec');
  if (certTimeoutInput) certTimeoutInput.value = String(settingsCache.options.certTimeoutSec || 60);
  renderCompanyList();
  renderCompanySelect();
  renderCompanyCertSelect();
  renderCompanyAuthSelect();
}


async function saveSettings() {
  settingsCache.urls.kepco = document.getElementById('urlKepco').value || '';
  settingsCache.urls.mnd = document.getElementById('urlMnd').value || '';
  const certTimeoutInput = document.getElementById('certTimeoutSec');
  const rawTimeout = certTimeoutInput ? parseInt(certTimeoutInput.value || '60', 10) : 60;
  const timeoutSec = Number.isFinite(rawTimeout) ? rawTimeout : 60;
  settingsCache.options.certTimeoutSec = Math.max(10, timeoutSec);
  (settingsCache.companies || []).forEach(ensureCompanyDefaults);
  await persistSettings();
  toast('Settings saved.');
}

document.getElementById('saveSettings').addEventListener('click', saveSettings);

document.getElementById('addCompany').addEventListener('click', () => {
  const name = document.getElementById('newCompanyName').value.trim();
  let bizNo = document.getElementById('newBizNo').value.trim();
  const representative = document.getElementById('newRepresentative').value.trim();
  if (!name || !bizNo) { toast('Company name and business number are required.'); return; }
  const bizDigits = bizNo.replace(/[^0-9]/g,'');
  if (bizDigits.length !== 10 || !validateBizNo(bizDigits)) {
    toast('Business registration number is invalid. (ex: 123-45-67890)');
    return;
  }
  bizNo = formatBizNo(bizDigits);
  if ((settingsCache.companies||[]).some(c => c.bizNo.replace(/[^0-9]/g,'') === bizDigits)) {
    toast('Business registration number already exists.');
    return;
  }
  const newCompany = { name, bizNo, representative, cert: {}, auth: { kepco: { id:'', pw:'' }, mnd: { id:'', pw:'' } } };
  ensureCompanyDefaults(newCompany);
  settingsCache.companies.push(newCompany);
  document.getElementById('newCompanyName').value = '';
  document.getElementById('newBizNo').value = '';
  document.getElementById('newRepresentative').value = '';
  renderCompanyList();
  renderCompanySelect();
  renderCompanyCertSelect();
  renderCompanyAuthSelect();
  persistSettings();
});

// Engine run/stop
const siteEl = document.getElementById('site');
const bidIdEl = document.getElementById('bidId');
const runBtn = document.getElementById('runBtn');
const stopBtn = document.getElementById('stopBtn');
const logEl = document.getElementById('log');

// (Global cert fields removed)

// Company cert browse
const browseCompanyBtn = document.getElementById('browseCompanyCertPath');
if (browseCompanyBtn) {
  browseCompanyBtn.addEventListener('click', async () => {
    const res = await window.api.selectPath({ title: '인증서 경로 선택', defaultPath: document.getElementById('compCertPath').value || undefined });
    if (res && res.ok && res.path) {
      document.getElementById('compCertPath').value = res.path;
      // Try to inspect and autofill subject/issuer/serial
      try {
        const info = await window.api.inspectCert(res.path);
        if (info && info.ok) {
          // Parse Subject CN or Organization friendly
          const subj = info.subject || '';
          // Simple extraction of CN or O from subject
          let pretty = subj;
          const m = subj.match(/CN=([^,]+)/i) || subj.match(/O=([^,]+)/i);
          if (m) pretty = m[1];
          document.getElementById('compCertSubject').value = pretty;
          document.getElementById('compCertIssuer').value = (info.issuer || '').replace(/^CN=/i,'');
          document.getElementById('compCertSerial').value = info.serial || '';
          // Persist into selected company cert
          const sel = document.getElementById('companyCertSelect');
          if (sel && sel.options.length > 0) {
            const idx = parseInt(sel.value || '0',10) || 0;
            const c = (settingsCache.companies||[])[idx];
            if (c) {
              c.cert = c.cert || {};
              c.cert.path = res.path;
              c.cert.subjectMatch = pretty;
              c.cert.issuerMatch = (info.issuer||'');
              c.cert.serialMatch = (info.serial||'');
              await persistSettings();
              toast('Certificate info filled from file.');
            }
          }
        }
      } catch {}
    }
  });
}

// Company cert select change
const companyCertSelectEl = document.getElementById('companyCertSelect');
if (companyCertSelectEl) {
  companyCertSelectEl.addEventListener('change', fillCompanyCertForm);
}

const companyAuthSelectEl = document.getElementById('companyAuthSelect');
if (companyAuthSelectEl) {
  companyAuthSelectEl.addEventListener('change', fillCompanyAuthForm);
}

// Save company cert
const saveCompanyCertBtn = document.getElementById('saveCompanyCert');
if (saveCompanyCertBtn) {
  saveCompanyCertBtn.addEventListener('click', async () => {
    const sel = document.getElementById('companyCertSelect');
    if (!sel || sel.options.length === 0) { toast('Add a company first.'); return; }
    const idx = parseInt(sel.value || '0', 10) || 0;
    const c = (settingsCache.companies || [])[idx];
    if (!c) { toast('Company selection is invalid.'); return; }
    ensureCompanyDefaults(c);
    c.cert = c.cert || {};
    c.cert.subjectMatch = document.getElementById('compCertSubject').value || '';
    c.cert.issuerMatch = document.getElementById('compCertIssuer').value || '';
    c.cert.serialMatch = document.getElementById('compCertSerial').value || '';
    c.cert.media = document.getElementById('compCertMedia').value || 'hdd';
    const pathEl = document.getElementById('compCertPath');
    c.cert.path = pathEl ? (pathEl.value || '') : '';
    c.cert.pin = document.getElementById('compCertPin').value || '';
    await persistSettings();
    toast('Company certificate saved.');
  });
}

const saveCompanyAuthBtn = document.getElementById('saveCompanyAuth');
if (saveCompanyAuthBtn) {
  saveCompanyAuthBtn.addEventListener('click', async () => {
    const sel = document.getElementById('companyAuthSelect');
    if (!sel || sel.options.length === 0) { toast('Add a company first.'); return; }
    const idx = parseInt(sel.value || '0', 10) || 0;
    const c = (settingsCache.companies || [])[idx];
    if (!c) { toast('Company selection is invalid.'); return; }
    ensureCompanyDefaults(c);
    c.auth.kepco.id = document.getElementById('compAuthKepcoId').value || '';
    c.auth.kepco.pw = document.getElementById('compAuthKepcoPw').value || '';
    c.auth.mnd.id = document.getElementById('compAuthMndId').value || '';
    c.auth.mnd.pw = document.getElementById('compAuthMndPw').value || '';
    await persistSettings();
    toast('Company account saved.');
  });
}

function logLine(obj) {
  const line = typeof obj === 'string' ? obj : JSON.stringify(obj);
  logEl.textContent += (line + "\n");
  logEl.scrollTop = logEl.scrollHeight;
}

runBtn.addEventListener('click', async () => {
  await saveSettings(); // persist any pending edits
  const s = settingsCache;
  const selEl = document.getElementById('companySelect');
  if (!selEl || selEl.options.length === 0) { toast('회사 정보를 먼저 추가해 주세요.'); return; }
  const companyIdx = parseInt(selEl.value || '0', 10) || 0;
  const company = (s.companies || [])[companyIdx];
  if (!company || !company.name || !company.bizNo) { toast('회사 정보가 올바르지 않습니다.'); return; }
  ensureCompanyDefaults(company);
  const url = siteEl.value === 'kepco' ? (s.urls.kepco || '') : (s.urls.mnd || '');
  if (!url) { toast('설정에서 사이트 URL을 먼저 입력해 주세요.'); return; }
  const authSet = siteEl.value === 'kepco' ? (company.auth.kepco || {}) : (company.auth.mnd || {});
  const job = {
    site: siteEl.value,
    bidId: bidIdEl.value,
    url,
    company,
    auth: { id: authSet.id || '', pw: authSet.pw || '' },
    cert: (() => {
      const cc = company.cert || {};
      return {
        subjectMatch: (cc.subjectMatch || company.name || ''),
        issuerMatch: (cc.issuerMatch || ''),
        serialMatch: (cc.serialMatch || ''),
        media: cc.media || 'hdd',
        path: '',
        pin: cc.pin || ''
      };
    })(),
    options: { headless: false, timeoutSec: 300, certTimeoutSec: Number(s.options?.certTimeoutSec || 60), debug: false, pauseAfterSuccessMs: 12000, pauseOnErrorMs: 12000, keepBrowserOnError: true, keepBrowserOnSuccess: true }
  };
  // Reset UI
  lastErrorToastMessage = '';
  resetProgressUI();
  updateSummary(job);
  logEl.textContent = '';
  logLine({ type:'info', msg:'Stopped by user request.' });
  runBtn.disabled = true;
  stopBtn.disabled = false;
  await window.api.runEngine(job);
});

stopBtn.addEventListener('click', async () => {
  // 사용자 중지 시 진행상황 초기화
  resetProgressUI();
  document.getElementById('progressStep').textContent = 'waiting';
  document.getElementById('progressPct').textContent = '0%';
  logLine({ type:'info', msg:'Stopped by user request.' });
  await window.api.stopEngine();
});

window.api.onEngineEvent(evt => {
  logLine(evt);
  if (evt.type === 'progress') {
    updateProgress(typeof evt.pct === 'number' ? evt.pct : 0, evt.step || '');
  } else if (evt.type === 'error') {
    setAllSteps('error');
    document.getElementById('progressStep').textContent = '오류';
    const msg = evt && typeof evt.msg === 'string' && evt.msg.trim() ? evt.msg.trim() : '자동화 중 오류가 발생했습니다.';
    if (lastErrorToastMessage !== msg) {
      toast(msg);
      lastErrorToastMessage = msg;
    }
  } else if (evt.type === 'done') {
    updateProgress(100, 'done');
  }
});

window.api.onEngineExit(({ code }) => {
  logLine({ type:'exit', code });
  runBtn.disabled = false;
  stopBtn.disabled = true;
});

// Small toast
function toast(msg){
  if (toastOverlay) {
    toastOverlay.remove();
    toastOverlay = null;
  }
  const overlay = document.createElement('div');
  overlay.style.position = 'fixed';
  overlay.style.left = '0';
  overlay.style.top = '0';
  overlay.style.width = '100%';
  overlay.style.height = '100%';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.background = 'rgba(26,37,80,0.45)';
  overlay.style.zIndex = '9999';
  overlay.style.opacity = '0';
  overlay.style.transition = 'opacity 180ms ease';
  const box = document.createElement('div');
  box.textContent = msg;
  box.style.padding = '18px 28px';
  box.style.background = '#ffffff';
  box.style.borderRadius = '12px';
  box.style.boxShadow = '0 24px 48px rgba(0,0,0,0.25)';
  box.style.color = '#1a2550';
  box.style.fontSize = '17px';
  box.style.fontWeight = '600';
  box.style.maxWidth = '420px';
  box.style.textAlign = 'center';
  box.style.lineHeight = '1.5';
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  toastOverlay = overlay;
  requestAnimationFrame(() => { overlay.style.opacity = '1'; });
  const removeOverlay = () => {
    if (toastOverlay !== overlay) return;
    overlay.style.opacity = '0';
    setTimeout(() => {
      if (toastOverlay === overlay) toastOverlay = null;
      overlay.remove();
    }, 200);
  };
  overlay.addEventListener('click', removeOverlay, { once: true });
  setTimeout(removeOverlay, 3200);
}

// Init
loadSettings();

// Helpers: biz no validation
function formatBizNo(d){ return d.slice(0,3)+'-'+d.slice(3,5)+'-'+d.slice(5,10); }
function validateBizNo(d){
  if (!/^[0-9]{10}$/.test(d)) return false;
  const w = [1,3,7,1,3,7,1,3,5];
  let sum = 0;
  for (let i=0;i<9;i++){
    const prod = Number(d[i]) * w[i];
    sum += prod;
    if (i === 8) sum += Math.floor(prod/10);
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(d[9]);
}

// Progress UI helpers
const stepOrder = ['open_site','navigate','fill_form','cert_dialog','submit'];
function resetProgressUI(){
  document.getElementById('progressBar').style.width = '0%';
  document.getElementById('progressStep').textContent = 'waiting';
  document.getElementById('progressPct').textContent = '0%';
  document.querySelectorAll('.steps .badge').forEach(b=>{
    b.classList.remove('current','done','error');
  });
}
function setAllSteps(state){
  document.querySelectorAll('.steps .badge').forEach(b=>{
    b.classList.remove('current','done','error');
    if (state) b.classList.add(state);
  });
}
function updateProgress(pct, step){
  const p = Math.max(0, Math.min(100, pct|0));
  document.getElementById('progressBar').style.width = p + '%';
  document.getElementById('progressPct').textContent = p + '%';
  if (step && step !== 'done') document.getElementById('progressStep').textContent = stepLabel(step);
  // badge state update
  const stepIdx = stepOrder.indexOf(step);
  document.querySelectorAll('.steps .badge').forEach(b=>{
    const s = b.getAttribute('data-step');
    b.classList.remove('current','done');
    const idx = stepOrder.indexOf(s);
    if (stepIdx === -1) return;
    if (idx < stepIdx) b.classList.add('done');
    else if (idx === stepIdx) b.classList.add('current');
  });
}
function stepLabel(step){
  switch(step){
    case 'open_site': return '접속';
    case 'navigate': return '이동';
    case 'fill_form': return '입력';
    case 'cert_dialog': return '인증';
    case 'submit': return '제출';
    default: return step;
  }
}

function updateSummary(job){
  document.getElementById('summarySite').textContent = job.site === 'kepco' ? 'KEPCO' : 'MND';
  document.getElementById('summaryUrl').textContent = job.url || '-';
  document.getElementById('summaryCompany').textContent = job.company?.name || '-';
  document.getElementById('summaryBizNo').textContent = job.company?.bizNo || '-';
  document.getElementById('summaryRep').textContent = job.company?.representative || '-';
}























