#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { run } = require('./core/orchestrator');
const { ensurePlaywright } = require('./util/ensurePlaywright');

function emit(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + "\n");
  } catch {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('usage: automation-engine --job <path> [--demo]');
    process.exit(0);
  }

  const demo = args.includes('--demo');
  const i = args.indexOf('--job');
  const jobPath = i >= 0 ? args[i + 1] : null;
  let job = null;
  if (jobPath && fs.existsSync(jobPath)) {
    try { job = JSON.parse(fs.readFileSync(jobPath, 'utf-8')); } catch {}
  }

  emit({ type: 'started', pid: process.pid, ts: new Date().toISOString(), demo });
  try {
    const logFn = (msg) => emit({ type: 'log', level: 'info', msg });
    const { browsersPath } = await ensurePlaywright(process.env.PLAYWRIGHT_BROWSERS_PATH, logFn);
    if (browsersPath) process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  } catch (err) {
    emit({ type: 'error', msg: `[PLAYWRIGHT] 브라우저 설치 실패: ${(err && err.message) || err}` });
    process.exit(1);
  }
  try {
    const result = await run(job || { site: 'kepco', url: job?.url || '', bidId: 'DEMO', options: { demo } }, emit);
    emit({ type: 'done', ok: true, result });
    process.exit(0);
  } catch (err) {
    emit({ type: 'error', msg: String(err && err.message ? err.message : err) });
    process.exit(1);
  }
}

main();
