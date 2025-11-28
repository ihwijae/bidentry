"use strict";

function debugDumpsEnabled() {
  const env = process.env.AUTOMATION_DEBUG_DUMPS;
  if (typeof env === 'string') {
    const lowered = env.trim().toLowerCase();
    if (['1','true','yes','on'].includes(lowered)) return true;
    if (['0','false','no','off'].includes(lowered)) return false;
  }
  return process.env.NODE_ENV !== 'production';
}

module.exports = { debugDumpsEnabled };
