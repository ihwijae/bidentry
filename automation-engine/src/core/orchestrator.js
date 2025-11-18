"use strict";

const path = require('path');
const fs = require('fs');
const { openAndPrepareLogin } = require('../web/playwright');
const { sweepPopups, dismissCommonOverlays } = require('../web/popups');
const { selectCertificateAndConfirm } = require('../native/uia');
const { goToBidApplyAndSearch, handleKepcoCertificate, applyAfterSearch, closeKepcoPostLoginModals } = require('../sites/kepco');
const { handleMndCertificate } = require('../sites/mnd');
const { scanLocalCerts } = require('../native/scanCerts');

function runDir() {
  const dir = path.join(process.cwd(), 'engine_runs', new Date().toISOString().replace(/[:.]/g,'-'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function run(job, emit) {
  if (job?.options?.demo) {
    const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
    emit({ type:'log', level:'info', msg:'Demo mode (no Playwright)' });
    emit({ type:'progress', step:'open_site', pct:10 }); await sleep(200);
    emit({ type:'progress', step:'navigate', pct:25 }); await sleep(250);
    emit({ type:'progress', step:'fill_form', pct:50 }); await sleep(250);
    emit({ type:'progress', step:'cert_dialog', pct:70 }); await sleep(300);
    emit({ type:'progress', step:'submit', pct:90 }); await sleep(200);
    return { receiptId: `DEMO-${Date.now()}`, site: job?.site || 'kepco' };
  }
  const outDir = runDir();
  const site = (job?.site || 'kepco').toLowerCase();
  emit({ type: 'progress', step: 'open_site', pct: 5 });

  const openRes = await openAndPrepareLogin(job, emit, outDir);
  // openRes: { ok, site, browser?, page? }

  if (!openRes.ok) {
    emit({ type: 'error', msg: openRes.error || 'Failed to open site/login' });
    throw new Error(openRes.error || 'open/login failed');
  }

  emit({ type: 'progress', step: 'navigate', pct: 25 });

  // Site-specific hooks could go here (fill common prelims)
  emit({ type: 'progress', step: 'fill_form', pct: 55 });
  if (site === 'kepco') {
    try { await closeKepcoPostLoginModals(openRes.page, emit); } catch {}
  }

  // Handle certificate dialog (web or native)
  emit({ type: 'progress', step: 'cert_dialog', pct: 75 });
  let certRes = { ok: false };
  let usedWebCert = false;
  try {
    if (site === 'kepco') {
      try {
        const webCert = await handleKepcoCertificate(openRes.page, emit, job?.cert || {}, {
          company: job?.company || {},
          timeoutMs: (Number(job?.options?.certTimeoutSec) || 30) * 1000,
          fastMode: job?.options?.kepcoFastMode !== false
        });
        if (webCert?.ok) {
          usedWebCert = true;
          certRes = { ok: true, mode: 'web' };
          if (webCert.page && webCert.page !== openRes.page) {
            openRes.page = webCert.page;
          }
          emit && emit({ type: 'log', level: 'info', msg: '[KEPCO] Web certificate automation completed' });
        } else if (webCert?.error) {
          emit && emit({ type: 'log', level: 'warn', msg: `[KEPCO] Web certificate attempt: ${webCert.error}` });
        }
      } catch (err) {
        emit && emit({ type: 'log', level: 'warn', msg: `[KEPCO] Web certificate handler exception: ${(err && err.message) || err}` });
      }
    }
    else if (site === 'mnd') {
      try {
        const webCert = await handleMndCertificate(openRes.page, emit, job?.cert || {}, {
          company: job?.company || {},
          timeoutMs: (Number(job?.options?.certTimeoutSec) || 30) * 1000
        });
        if (webCert?.ok) {
          usedWebCert = true;
          certRes = { ok: true, mode: 'web' };
          if (webCert.page && webCert.page !== openRes.page) {
            openRes.page = webCert.page;
          }
          emit && emit({ type: 'log', level: 'info', msg: '[MND] Web certificate automation completed' });
        } else if (webCert?.error) {
          emit && emit({ type: 'log', level: 'warn', msg: `[MND] Web certificate attempt: ${webCert.error}` });
        }
      } catch (err) {
        emit && emit({ type: 'log', level: 'warn', msg: `[MND] Web certificate handler exception: ${(err && err.message) || err}` });
      }
    }
    if (!usedWebCert) {
      // Build initial cert options
      const allowCertPath = job?.options?.useCertPath !== false;
      const requestedCertPath = allowCertPath ? String(job?.cert?.path || '').trim() : '';
      const certOpts = {
        provider: job?.cert?.provider || 'KICA',
        media: job?.cert?.media || '',
        subjectMatch: job?.cert?.subjectMatch || job?.company?.name || '',
        issuerMatch: job?.cert?.issuerMatch || job?.cert?.provider || '',
        serialMatch: job?.cert?.serialMatch || '',
        pin: job?.cert?.pin || '',
        path: requestedCertPath,
        timeoutSec: Number(job?.options?.certTimeoutSec) || 30,
        outDir,
        labels: {
          certWindowTitles: ['인증서 선택','공동인증서','인증서','전자서명','인증서 로그인','인증서 비밀번호'],
          browseBtnLabels: ['찾기','찾아보기','열기','경로','경로 변경','폴더 찾아보기','폴더 선택'],
          dialogTitles: ['열기','폴더 선택','찾아보기','폴더 찾아보기','폴더 선택:'],
          dialogOkLabels: ['확인','열기','폴더 선택','선택','열기(O)','확인(O)'],
          detailBtnLabels: ['인증서 보기','인증서 정보','상세 보기','상세','인증서 상세'],
          detailWinTitles: ['인증서 정보','인증서 보기','인증서 상세']
        }
      };

      if (requestedCertPath) {
        if (allowCertPath) {
          emit && emit({ type:'log', level:'info', msg:`[CERT] using path hint: ${requestedCertPath}` });
        } else {
          emit && emit({ type:'log', level:'info', msg:'[CERT] path hint provided but disabled via options.useCertPath=false' });
        }
      }

      // If explicit path is present but missing subject/issuer/serial, try enrich from scan
      if (certOpts.path) {
        const scan = await scanLocalCerts();
        if (scan.ok && scan.items?.length) {
          const found = scan.items.find(it => (it.cnDir || '').toLowerCase() === String(certOpts.path).toLowerCase());
          if (found) {
            certOpts.subjectMatch ||= found.subject;
            certOpts.issuerMatch ||= found.issuer;
            certOpts.serialMatch ||= found.serial;
            emit && emit({ type:'log', level:'info', msg:`[CERT] enriched from path (serial=${found.serial})` });
          }
        }
      }

      // If still no path, try to auto-discover CN via NPKI scan
      if (!certOpts.path) {
        const scan = await scanLocalCerts();
        if (scan.ok && scan.items?.length) {
          const norm = (s)=> String(s||'').toLowerCase();
          const extractCN = (subject) => {
            if (!subject) return '';
            const match = /CN\s*=\s*([^,]+)/i.exec(subject);
            return (match?.[1] || subject).trim();
          };
          let best = null;
          for (const it of scan.items) {
            const subj = norm(it.subject);
            const iss = norm(it.issuer);
            const ser = norm(it.serial);
            const wantS = norm(certOpts.subjectMatch);
            const wantI = norm(certOpts.issuerMatch);
            const wantSer = norm(certOpts.serialMatch);
            let score = 0;
            if (wantSer && ser.includes(wantSer)) score += 1000;
            if (wantS && subj.includes(wantS)) score += 100;
            if (wantI && iss.includes(wantI)) score += 50;
            if (!best || score > best.score) best = { score, it };
          }
          if (best && best.score > 0) {
            const chosen = best.it;
            certOpts.path = chosen.cnDir || chosen.signCert;
            if (!certOpts.subjectMatch) {
              const cn = extractCN(chosen.subject);
              if (cn) certOpts.subjectMatch = cn;
            }
            certOpts.issuerMatch ||= chosen.issuer || '';
            certOpts.serialMatch ||= chosen.serial || '';
            emit && emit({ type:'log', level:'info', msg:`[CERT] auto-selected path=${certOpts.path}` });
          } else {
            emit && emit({ type:'log', level:'warn', msg:`[CERT] auto-scan found ${scan.items.length} certs but none matched filters` });
          }
        } else {
          emit && emit({ type:'log', level:'warn', msg:`[CERT] NPKI scan failed or empty: ${(scan.err||'').slice(0,200)}` });
        }
      }
      certRes = await selectCertificateAndConfirm(certOpts, emit);
}

    if (!certRes.ok) throw new Error(certRes.error || '?占쎌쬆???占쏀깮/?占쎌씤 ?占쏀뙣');

    try { await sweepPopups(openRes.page.context?.(), emit); } catch {}
    try { await dismissCommonOverlays(openRes.page, emit); } catch {}
    if (site === 'kepco') {
      const bidQueue = Array.isArray(job?.bidIds) && job.bidIds.length
        ? job.bidIds.map(b => String(b || '').trim()).filter(Boolean)
        : (job?.bidId ? [String(job.bidId).trim()] : []);
      if (!bidQueue.length) {
        emit && emit({ type:'log', level:'warn', msg:'[KEPCO] 공고번호가 설정되어 있지 않아 검색을 건너뜁니다.' });
      }
      let processed = 0;
      for (const bid of bidQueue) {
        emit && emit({ type:'log', level:'info', msg:`[KEPCO] 공고번호 처리 (${processed + 1}/${bidQueue.length}): ${bid}` });
        emit({ type:'progress', step:'navigate_bid', pct: 82 });
        try {
          await goToBidApplyAndSearch(openRes.page, emit, bid);
        } catch (e) {
          const msg = `[KEPCO] 공고번호 ${bid} 이동 실패: ${(e && e.message) || e}`;
          emit({ type:'log', level:'error', msg });
          throw new Error(msg);
        }
        try { await sweepPopups(openRes.page.context?.(), emit); } catch {}
        try { await dismissCommonOverlays(openRes.page, emit); } catch {}
        emit({ type:'progress', step:'search_bid', pct: 88 });
        try {
          await applyAfterSearch(openRes.page, emit);
        } catch (e) {
          const msg = `[KEPCO] 공고번호 ${bid} 참가신청 실패: ${(e && e.message) || e}`;
          emit({ type:'log', level:'error', msg });
          throw new Error(msg);
        }
        processed += 1;
      }
      emit && emit({ type:'log', level:'info', msg:`[KEPCO] 공고번호 처리 완료: ${processed}/${bidQueue.length}` });
    }
  } finally {
    const keepOnError = job?.options?.keepBrowserOnError === true;
    const keepOnSuccess = job?.options?.keepBrowserOnSuccess === true;
    const shouldClose = (!certRes.ok && !keepOnError) || (certRes.ok && !keepOnSuccess);
    try { await openRes?.page?.waitForTimeout?.(500); } catch {}
    if (shouldClose) {
      try { await openRes?.page?.close?.(); } catch {}
      try { await openRes?.browser?.close?.(); } catch {}
    }
  }

  // Submit (placeholder)
  emit({ type: 'progress', step: 'submit', pct: 90 });
  // Keep page visible briefly after success if configured
  const pauseMs = Number(job?.options?.pauseAfterSuccessMs) || 0;
  if (pauseMs > 0) { try { await openRes?.page?.waitForTimeout?.(pauseMs); } catch {} }
  return { receiptId: `PREPARED-${site}-${Date.now()}`, outDir, site };
}

module.exports = { run };



