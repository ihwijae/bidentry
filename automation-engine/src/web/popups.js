"use strict";

const DEFAULT_POPUP_KEYWORDS = [
  /\uACF5\uC9C0/i, // notice
  /\uC548\uB0B4/i, // guide
  /\uC774\uBCA4\uD2B8/i, // event
  /\uC54C\uB9BC/i, // alert
  /\uC8FC\uC758/i, // caution
  /\uACBD\uACE0/i  // warning
];

const DEFAULT_POPUP_SKIP = [
  /\uC778\uC99D/i, // 인증
  /\uACF5\uB3D9/i, // 공동
  /\uC785\uCC30/i,
  /\uC785\uCC30\uCC38\uAC00/i,
  /\uC785\uCC30\uB3D9\uC758/i,
  /\uC785\uCC30\uB2F9\uD589/i,
  /\uC785\uCC30\uB2F9\uC5F0/i,
  /cert/i,
  /certificate/i
];

// Attach listeners to auto-close typical notice/event popups opened as new windows
function attachPopupAutoCloser(context, emit, opts = {}) {
  const keywords = opts.keywords || DEFAULT_POPUP_KEYWORDS;
  const skip = opts.skipKeywords || DEFAULT_POPUP_SKIP;
  context.on('page', async (pg) => {
    try {
      await pg.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      const title = (await pg.title().catch(() => '')) || '';
      const url = (pg.url && typeof pg.url === 'function') ? pg.url() : '';
      if (skip.some(rx => rx.test(title) || rx.test(url))) {
        emit && emit({ type: 'log', level: 'debug', msg: `[popup] skip certificate window title='${title}'` });
        return;
      }
      if (keywords.some(rx => rx.test(title) || rx.test(url))) {
        emit && emit({ type: 'log', level: 'info', msg: `[popup] closed title='${title}' url='${url}'` });
        await pg.close({ runBeforeUnload: true }).catch(() => {});
      }
    } catch {}
  });
}

// Try to dismiss in-page modals/overlays that block interactions
async function dismissCommonOverlays(page, emit) {
  try {
    page.on('dialog', d => d.dismiss().catch(() => {}));

    const selectors = [
      'button[aria-label="Close" i]',
      'button[aria-label*="\\uB2EB\\uAE30" i]', // 닫기
      '.modal .btn-close, .modal .close, .layer, .layer_popup .btn_close',
      'button:has-text("\\uB2EB\\uAE30")',
      'a:has-text("\\uB2EB\\uAE30")',
      'button:has-text("\\uC624\\uB298 \\uB2E4\\uC2DC \\uBCF4\\uAE30")',
      'a:has-text("\\uC624\\uB298 \\uB2E4\\uC2DC \\uBCF4\\uAE30")'
    ];

    for (const sel of selectors) {
      const els = await page.$$(sel).catch(() => []);
      for (const el of els) {
        try {
          await el.click({ timeout: 500 }).catch(() => {});
          emit && emit({ type: 'log', level: 'info', msg: `[overlay] closed ${sel}` });
        } catch {}
      }
    }

    await page.evaluate(() => {
      const kill = (q) => Array.from(document.querySelectorAll(q)).forEach(n => {
        n.style.display = 'none';
        if (typeof n.remove === 'function') n.remove();
      });
      kill('.modal-backdrop, .backdrop, .overlay, .dim, .block-ui, .blockOverlay');
    }).catch(() => {});
  } catch {}
}

// One-shot sweep to close already-open popups after login
async function sweepPopups(context, emit, opts = {}) {
  const keywords = opts.keywords || DEFAULT_POPUP_KEYWORDS;
  const skip = opts.skipKeywords || DEFAULT_POPUP_SKIP;
  try {
    const pages = context.pages?.() || [];
    for (const pg of pages) {
      try {
        if (pg.isClosed && pg.isClosed()) continue;
        await pg.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => {});
        const title = (await pg.title().catch(() => '')) || '';
        const url = (pg.url && typeof pg.url === 'function') ? pg.url() : '';
        if (skip.some(rx => rx.test(title) || rx.test(url))) {
          emit && emit({ type: 'log', level: 'debug', msg: `[popup] skip certificate window title='${title}'` });
          continue;
        }
        if (keywords.some(rx => rx.test(title) || rx.test(url))) {
          emit && emit({ type: 'log', level: 'info', msg: `[popup] closed title='${title}' url='${url}'` });
          await pg.close({ runBeforeUnload: true }).catch(() => {});
        }
      } catch {}
    }
  } catch {}
}

module.exports = { attachPopupAutoCloser, dismissCommonOverlays, sweepPopups };
