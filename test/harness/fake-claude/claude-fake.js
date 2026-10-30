// A stand-in for the `claude` CLI's `mcp add/remove/get`, writing user-scope servers to
// $CLAUDE_CONFIG_DIR/.claude.json (or ~/.claude.json) like the real one. Logs every call.
// FAKE_CLAUDE_FAIL=1 makes `mcp add` fail without registering anything.
// FAKE_CLAUDE_REMOVE_MS makes `mcp remove` take that long (a slow computer).
const fs = require('fs'), path = require('path'), os = require('os');
const args = process.argv.slice(2);
const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
const cfgPath = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json');
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + '\n');
const read = () => { try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { return {}; } };
const write = (c) => { fs.mkdirSync(path.dirname(cfgPath), { recursive: true }); fs.writeFileSync(cfgPath, JSON.stringify(c, null, 2)); };
if (args[0] !== 'mcp') { console.log('2.0.0 (Claude Code)'); process.exit(0); }
const cfg = read(); cfg.mcpServers ??= {};
if (args[1] === 'add') {
  if (process.env.FAKE_CLAUDE_FAIL) { console.error('Error: something went wrong'); process.exit(1); }
  const dash = args.indexOf('--');
  const before = args.slice(2, dash), after = args.slice(dash + 1);
  const env = {}; let name;
  for (let i = 0; i < before.length; i++) {
    if (before[i] === '--env' || before[i] === '-e') { const [k, v] = before[++i].split('='); env[k] = v; }
    else if (before[i] === '--transport' || before[i] === '--scope' || before[i] === '-s') i++;
    else name = before[i];
  }
  if (cfg.mcpServers[name]) { console.error(`MCP server ${name} already exists in user config`); process.exit(1); }
  cfg.mcpServers[name] = { type: 'stdio', command: after[0], args: after.slice(1), env };
  write(cfg); console.log(`Added stdio MCP server ${name} to user config`); process.exit(0);
}
if (args[1] === 'remove') {
  if (process.env.FAKE_CLAUDE_REMOVE_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_CLAUDE_REMOVE_MS));
  if (!cfg.mcpServers[args[2]]) { console.error(`No user-scoped MCP server found with name: ${args[2]}`); process.exit(1); }
  delete cfg.mcpServers[args[2]]; write(cfg); console.log(`Removed MCP server ${args[2]}`); process.exit(0);
}
if (args[1] === 'get') {
  const s = cfg.mcpServers[args[2]];
  if (!s) { console.error(`No MCP server found with name: ${args[2]}`); process.exit(1); }
  console.log(`${args[2]}:\n  Scope: User config\n  Command: ${s.command}\n  Args: ${s.args.join(' ')}`); process.exit(0);
}
process.exit(1);
