// Copies the modules the Claude Code mod shares with the extension into mod/hooks/lib/.
// A mod can only import files inside its own folder. The copies are committed, so the mod
// installs straight from GitHub. Run by `npm run build`; test/handover.test.js checks they match.
const fs = require('fs'), path = require('path');

const root = path.join(__dirname, '..');
const SHARED = ['model.ts', 'handover.ts'];
const header = (f) => `// Copied from src/${f} by scripts/copy-mod-lib.js. Do not edit here: edit src/${f} and run npm run build.\n`;

const expected = (f) => header(f) + fs.readFileSync(path.join(root, 'src', f), 'utf8').replace(/\r\n/g, '\n');

if (require.main === module) {
  const dir = path.join(root, 'mod', 'hooks', 'lib');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of SHARED) {
    const out = path.join(dir, f);
    const text = expected(f);
    if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== text) fs.writeFileSync(out, text);
  }
}

module.exports = { SHARED, expected };
