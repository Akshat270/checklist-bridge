// Makes every Claude Code session on this computer use the checklist without being told:
// a marked block in ~/.claude/CLAUDE.md (read by every session) and "mcp__checklist" in
// permissions.allow in ~/.claude/settings.json (no approval prompt per call). Fully reversible.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const START = '<!-- checklist-bridge:start (managed by the Checklist Bridge VS Code extension) -->';
const END = '<!-- checklist-bridge:end -->';
const PERMISSION = 'mcp__checklist';

export const INSTRUCTIONS = `## Manual steps and decisions (Checklist Bridge)
- Whenever I need to do something by hand, like create an account or API key, run a command, change a setting, click through a dashboard, test something or tell you a value, add it to my checklist with checklist_add_tasks instead of writing the steps in your reply.
- Whenever I need to make a decision that can wait while you keep working, ask it with checklist_ask (options, short details, your recommendation) instead of listing the options in your reply. Ask normally only if you can't do anything until I answer.
- While anything on the checklist is waiting, call checklist_read at the start of each reply, and only trust what I have shared. If you have done everything you can and only my input is left, call checklist_wait instead of ending your turn.
- If some steps must be done in a fixed order, put them in one group, add them in that order and list the group in ordered_groups (checklist_edit can change this later with ordered_groups or unordered_groups, and reorder the steps with step_order). Tags like urgent and important only rank tasks that can be done in any order.
- When you mention a checklist item to me, give its id with a few words of its title, like "q1 (payment gateway)". I see the same ids in the checklist.
- If the checklist tools aren't available, put the steps or the question in your reply as usual.`;

export const claudeDir = (env: NodeJS.ProcessEnv = process.env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

export interface SetupResult {
  instructions: 'added' | 'updated' | 'unchanged' | 'removed' | 'absent';
  permission: 'added' | 'unchanged' | 'removed' | 'absent' | 'skipped';
  note?: string;
}

const blockRe = new RegExp(`\\n*${escapeRe(START)}[\\s\\S]*?${escapeRe(END)}\\n*`);
function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isSetUp(dir = claudeDir()): boolean {
  try {
    return fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8').includes(START);
  } catch {
    return false;
  }
}

function readSettings(file: string): { data: any; ok: boolean } {
  if (!fs.existsSync(file)) return { data: {}, ok: true };
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return { data: {}, ok: true };
  try {
    const data = JSON.parse(raw);
    return { data: data && typeof data === 'object' && !Array.isArray(data) ? data : {}, ok: !!data && typeof data === 'object' && !Array.isArray(data) };
  } catch {
    return { data: null, ok: false }; // comments or invalid JSON: never rewrite a file we can't round-trip
  }
}

function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Updates an existing managed block to this version's wording. Returns true if the file changed. */
export function refreshInstructions(dir = claudeDir()): boolean {
  const md = path.join(dir, 'CLAUDE.md');
  if (!fs.existsSync(md)) return false;
  const before = fs.readFileSync(md, 'utf8');
  if (!before.includes(START)) return false;
  const after = before.replace(blockRe, (m) => (m.startsWith('\n') ? '\n\n' : '') + `${START}\n${INSTRUCTIONS}\n${END}` + '\n');
  if (after === before) return false;
  writeAtomic(md, after);
  return true;
}

export function applySetup(dir = claudeDir()): SetupResult {
  fs.mkdirSync(dir, { recursive: true });
  const res: SetupResult = { instructions: 'unchanged', permission: 'unchanged' };

  // 1. Instructions every session reads.
  const md = path.join(dir, 'CLAUDE.md');
  const before = fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : '';
  const block = `${START}\n${INSTRUCTIONS}\n${END}`;
  let after: string;
  if (before.includes(START)) {
    after = before.replace(blockRe, (m) => (m.startsWith('\n') ? '\n\n' : '') + block + '\n');
    res.instructions = after === before ? 'unchanged' : 'updated';
  } else {
    after = (before.trimEnd() ? before.trimEnd() + '\n\n' : '') + block + '\n';
    res.instructions = 'added';
  }
  if (after !== before) writeAtomic(md, after);

  // 2. Let the checklist tools run without an approval prompt.
  const sf = path.join(dir, 'settings.json');
  const { data, ok } = readSettings(sf);
  if (!ok) {
    res.permission = 'skipped';
    res.note = `${sf} isn't plain JSON (maybe it has comments), so it was left untouched. Add "${PERMISSION}" to permissions.allow yourself to skip approval prompts.`;
  } else {
    const perms = (data.permissions ??= {});
    const allow: unknown[] = Array.isArray(perms.allow) ? perms.allow : (perms.allow = []);
    if (!allow.includes(PERMISSION)) {
      allow.push(PERMISSION);
      if (fs.existsSync(sf) && !fs.existsSync(sf + '.before-checklist-bridge')) fs.copyFileSync(sf, sf + '.before-checklist-bridge');
      writeAtomic(sf, JSON.stringify(data, null, 2) + '\n');
      res.permission = 'added';
    }
  }
  return res;
}

export function removeSetup(dir = claudeDir()): SetupResult {
  const res: SetupResult = { instructions: 'absent', permission: 'absent' };
  const md = path.join(dir, 'CLAUDE.md');
  if (fs.existsSync(md)) {
    const before = fs.readFileSync(md, 'utf8');
    if (before.includes(START)) {
      const after = before.replace(blockRe, '\n\n').replace(/^\n+/, '').replace(/\n{3,}$/, '\n').trimEnd();
      writeAtomic(md, after ? after + '\n' : '');
      res.instructions = 'removed';
    }
  }
  const sf = path.join(dir, 'settings.json');
  const { data, ok } = readSettings(sf);
  if (ok && Array.isArray(data?.permissions?.allow) && data.permissions.allow.includes(PERMISSION)) {
    data.permissions.allow = data.permissions.allow.filter((p: unknown) => p !== PERMISSION);
    writeAtomic(sf, JSON.stringify(data, null, 2) + '\n');
    res.permission = 'removed';
  } else if (!ok) res.permission = 'skipped';
  return res;
}
