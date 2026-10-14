// Playwright is optional: UI tests skip when it isn't installed (or CB_NO_BROWSER is set).
if (process.env.CB_NO_BROWSER) {
  module.exports = null;
  return;
}
const candidates = ['playwright', process.env.PLAYWRIGHT_MODULE, '/home/claude/.npm-global/lib/node_modules/playwright'].filter(Boolean);
for (const c of candidates) {
  try {
    module.exports = require(c);
    return;
  } catch {}
}
module.exports = null;
