// Self-update from a GitHub repo: reads <repo>/main/latest.json, downloads the .vsix it names,
// checks its SHA-256, installs it and offers a reload.
import * as vscode from 'vscode';
import { userSetting } from './settings';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { ROOT } from './registry';

interface Latest { version: string; vsix: string; sha256: string; notes?: string }

const CHECK_EVERY_MS = 3 * 3600_000;

function get(url: string, redirects = 3): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    (url.startsWith('http://') ? http : https)
      .get(url, { headers: { 'User-Agent': 'checklist-bridge', 'Cache-Control': 'no-cache' }, timeout: 20_000 }, (res) => {
        const code = res.statusCode ?? 0;
        if (code >= 300 && code < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return resolve(get(new URL(res.headers.location, url).toString(), redirects - 1));
        }
        if (code !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${code} for ${url}`));
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('timeout', function (this: any) {
        this.destroy(new Error('timeout'));
      })
      .on('error', reject);
  });
}

const newer = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

/** Only one VS Code window installs a given version. */
function claim(version: string): boolean {
  const lock = path.join(ROOT, `update-${version}.lock`);
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    const st = fs.statSync(lock);
    if (Date.now() - st.mtimeMs < 10 * 60_000) return false; // another window is on it
  } catch {
    /* no lock yet */
  }
  try {
    fs.writeFileSync(lock, String(process.pid));
    return true;
  } catch {
    return false;
  }
}

export function startUpdater(ctx: vscode.ExtensionContext, current: string, log: (s: string) => void) {
  let busy = false;
  let offered = '';
  let lastCheck = 0;

  const check = async (manual: boolean) => {
    const repo = String(userSetting('updateRepo', 'Akshat270/checklist-bridge')).trim();
    if (!manual && !userSetting('autoUpdate', true)) return;
    if (busy || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return;
    if (!manual && Date.now() - lastCheck < 30 * 60_000) return;
    lastCheck = Date.now();
    busy = true;
    log(`Checking for updates from ${repo}.`);
    // CHECKLIST_BRIDGE_UPDATE_BASE points the updater at a local server, for the test suite only.
    const testBase = process.env.CHECKLIST_BRIDGE_TEST === '1' ? process.env.CHECKLIST_BRIDGE_UPDATE_BASE : undefined;
    const base = testBase || `https://raw.githubusercontent.com/${repo}/main/`;
    try {
      const latest = JSON.parse((await get(base + 'latest.json')).toString('utf8')) as Latest;
      if (!latest?.version || !latest.vsix || !/^[\w./-]+\.vsix$/.test(latest.vsix) || latest.vsix.includes('..')) throw new Error('latest.json is malformed');
      if (!newer(latest.version, current)) {
        if (manual) vscode.window.showInformationMessage(`Checklist Bridge is up to date (${current}).`);
        return;
      }
      if (offered === latest.version) return;
      if (!manual && !claim(latest.version)) return;
      log(`Updating ${current} → ${latest.version} from ${repo}`);
      const data = await get(base + latest.vsix);
      const sum = createHash('sha256').update(data).digest('hex');
      if (latest.sha256 && sum !== latest.sha256.toLowerCase()) throw new Error('download is corrupt (checksum mismatch)');
      const dir = vscode.Uri.joinPath(ctx.globalStorageUri, 'updates').fsPath;
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `checklist-bridge-${latest.version}.vsix`);
      fs.writeFileSync(file, data);
      await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
      offered = latest.version;
      log(`Installed ${latest.version}.`);
      const pick = await vscode.window.showInformationMessage(
        `Checklist Bridge updated to ${latest.version}${latest.notes ? `: ${latest.notes}` : ''}. Reload to use it.`,
        'Reload window'
      );
      if (pick) vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (e: any) {
      log(`Update check failed: ${e?.message ?? e}`);
      if (manual) vscode.window.showWarningMessage(`Couldn't check for Checklist Bridge updates: ${e?.message ?? e}`, {});
    } finally {
      busy = false;
    }
  };

  const first = setTimeout(() => check(false), 15_000);
  const timer = setInterval(() => check(false), CHECK_EVERY_MS);
  ctx.subscriptions.push(
    { dispose: () => (clearTimeout(first), clearInterval(timer)) },
    vscode.commands.registerCommand('checklistBridge.checkForUpdates', () => check(true)),
    vscode.window.onDidChangeWindowState((s) => s.focused && check(false))
  );
}
