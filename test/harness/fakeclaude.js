// Stands in for a `claude` process: its command line carries whatever flags the test passes,
// and it runs the connector as its child with the same stdio (like Claude Code does).
const { spawn } = require('child_process');
const [connector] = process.argv.slice(2).filter((a) => a.endsWith('connector.js'));
const child = spawn(process.execPath, [connector], { stdio: 'inherit', env: process.env });
child.on('exit', (c) => process.exit(c ?? 0));
process.on('SIGTERM', () => child.kill());
