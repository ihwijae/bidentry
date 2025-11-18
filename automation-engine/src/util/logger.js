"use strict";

function createLogger(out = process.stdout) {
  const write = (obj) => {
    try { out.write(JSON.stringify(obj) + "\n"); } catch {}
  };
  return {
    event: (type, data = {}) => write({ type, ...data }),
    info: (msg, extra = {}) => write({ type: 'log', level: 'info', msg, ...extra }),
    error: (msg, extra = {}) => write({ type: 'log', level: 'error', msg, ...extra }),
  };
}

module.exports = { createLogger };

