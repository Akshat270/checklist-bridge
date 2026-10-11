import * as vscode from 'vscode';
import { Checklist, ChecklistStore } from './model';

/** One webview tab per checklist. Closing the tab only hides it. */
export class Panels {
  private open = new Map<string, vscode.WebviewPanel>();
  private ready = new Set<string>();

  constructor(private store: ChecklistStore, private extUri: vscode.Uri) {}

  isOpen(id: string) {
    return this.open.has(id);
  }

  show(c: Checklist, opts: { focus?: boolean; taskId?: string } = {}) {
    let p = this.open.get(c.id);
    if (p) {
      p.reveal(undefined, !opts.focus);
    } else {
      p = vscode.window.createWebviewPanel(
        'checklistBridge.checklist',
        c.title,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: !opts.focus },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.extUri, 'media')] }
      );
      p.iconPath = vscode.Uri.joinPath(this.extUri, 'media', 'tab.svg');
      p.webview.html = this.html(p.webview);
      p.webview.onDidReceiveMessage((m) => this.onMessage(c.id, m));
      p.onDidDispose(() => {
        this.open.delete(c.id);
        this.ready.delete(c.id);
        // Closing the tab = hiding. Closing the checklist for good is a separate action.
        const cur = this.store.get(c.id);
        if (cur && !cur.closed) this.store.setHidden(c.id, true);
      });
      this.open.set(c.id, p);
    }
    if (c.hidden) this.store.setHidden(c.id, false);
    if (opts.taskId) p.webview.postMessage({ type: 'reveal', taskId: opts.taskId });
  }

  hide(id: string) {
    this.open.get(id)?.dispose();
    this.store.setHidden(id, true);
  }

  /** Push fresh state to a visible panel. */
  update(c: Checklist) {
    const p = this.open.get(c.id);
    if (!p) return;
    if (c.closed) {
      p.dispose();
      return;
    }
    p.title = c.title;
    if (this.ready.has(c.id)) p.webview.postMessage({ type: 'state', list: c });
  }

  disposeAll() {
    for (const p of [...this.open.values()]) p.dispose();
  }

  private async onMessage(id: string, m: any) {
    const s = this.store;
    switch (m?.type) {
      case 'ready': {
        this.ready.add(id);
        const c = s.get(id);
        if (c) this.open.get(id)?.webview.postMessage({ type: 'state', list: c });
        break;
      }
      case 'draft':
        s.setDraft(id, m.taskId, { done: m.done, note: m.note });
        break;
      case 'addImages':
        s.addImages(id, m.taskId, Array.isArray(m.images) ? m.images : []);
        break;
      case 'removeImage':
        s.removeImage(id, m.taskId, m.imageId);
        break;
      case 'share':
        s.setDraft(id, m.taskId, { done: !!m.done, note: typeof m.note === 'string' ? m.note : undefined });
        s.share(id, m.taskId);
        break;
      case 'unshare':
        s.unshare(id, m.taskId);
        break;
      case 'copy':
        if (typeof m.text === 'string') {
          await vscode.env.clipboard.writeText(m.text);
          this.open.get(id)?.webview.postMessage({ type: 'toast', text: 'Copied' });
        }
        break;
      case 'hide':
        this.hide(id);
        break;
      case 'close':
        await vscode.commands.executeCommand('checklistBridge.close', id);
        break;
    }
  }

  private html(webview: vscode.Webview) {
    const nonce = [...Array(32)].map(() => Math.random().toString(36)[2]).join('');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'media', 'panel.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'media', 'panel.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob: ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
</head>
<body><script nonce="${nonce}" src="${js}"></script></body>
</html>`;
  }
}
