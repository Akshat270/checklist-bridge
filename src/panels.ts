import * as vscode from 'vscode';
import { Checklist, ChecklistStore, Img } from './model';
import { isImg } from './images';

/** Where screenshots live on disk, so the panel can load them as files instead of receiving their data. */
export interface ImageSource {
  dir: string;
  has(listId: string, img: Img): boolean;
  file(listId: string, img: Img): string;
}

/** How "Send now" can reach a chat right now. */
export interface Routes { waiting: boolean; channel: boolean; terminal: boolean }
export interface PanelHooks {
  routes(c: Checklist): Routes;
  sendNow(c: Checklist): Promise<void>;
}

export const VIEW_TYPE = 'checklistBridge.checklist';

/** One webview tab per checklist. Closing the tab only hides it. */
export class Panels {
  private open = new Map<string, vscode.WebviewPanel>();
  private ready = new Set<string>();

  constructor(private store: ChecklistStore, private extUri: vscode.Uri, private hooks: PanelHooks, private images?: ImageSource) {}

  private roots() {
    const r = [vscode.Uri.joinPath(this.extUri, 'media')];
    if (this.images) r.push(vscode.Uri.file(this.images.dir));
    return r;
  }

  /**
   * What the panel gets: the checklist, with each saved screenshot as a link to its file
   * (so each update is a few KB, not every screenshot again). Screenshots not on disk yet go inline.
   */
  private state(c: Checklist, webview: vscode.Webview) {
    const imgs = this.images;
    const list = JSON.parse(
      JSON.stringify(c, (_k, v) => {
        if (!isImg(v)) return v;
        const src = imgs?.has(c.id, v) ? webview.asWebviewUri(vscode.Uri.file(imgs.file(c.id, v))).toString() : undefined;
        return src ? { id: v.id, mime: v.mime, w: v.w, h: v.h, src } : v;
      })
    );
    // Decided here, so the panel's own clock can't disagree. The time left is as of now; the panel counts down from it.
    list.away = this.store.isAway(c);
    if (list.away) {
      list.awayLeft = Math.max(0, c.awayUntil! - Date.now());
      // How long until the user's midnight, if the away ends after it: the panel says "tomorrow" until then, as Claude is told.
      if (c.awayMidnight) list.awayMidnightLeft = c.awayMidnight - Date.now();
    }
    return { type: 'state', list, routes: this.hooks.routes(c) };
  }

  /** Re-send state to every visible panel (e.g. when how to reach a chat changes). */
  refreshAll() {
    for (const id of this.open.keys()) {
      const c = this.store.get(id);
      if (c) this.update(c);
    }
  }

  openIds() {
    return [...this.open.keys()];
  }

  isOpen(id: string) {
    return this.open.has(id);
  }

  show(c: Checklist, opts: { focus?: boolean; taskId?: string } = {}) {
    let p = this.open.get(c.id);
    if (p) {
      p.reveal(undefined, !opts.focus);
    } else {
      p = vscode.window.createWebviewPanel(
        VIEW_TYPE,
        c.title,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: !opts.focus },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: this.roots() }
      );
      this.attach(p, c);
    }
    if (c.hidden) this.store.setHidden(c.id, false);
    if (opts.taskId) p.webview.postMessage({ type: 'reveal', taskId: opts.taskId });
  }

  /** A tab VS Code kept open across a reload or restart: take it over again. */
  restore(p: vscode.WebviewPanel, state: any) {
    const c = typeof state?.listId === 'string' ? this.store.get(state.listId) : undefined;
    if (!c || c.closed || this.open.has(c.id)) {
      p.dispose();
      return;
    }
    p.webview.options = { enableScripts: true, localResourceRoots: this.roots() };
    this.attach(p, c);
    if (c.hidden) this.store.setHidden(c.id, false);
  }

  /**
   * VS Code closes every tab while a window shuts down. Those closes aren't the user hiding
   * checklists, so on shutdown undo any that happened in the last moment.
   */
  undoShutdownCloses(withinMs = 3000): Checklist[] {
    // Changes the flag directly: the UI is being torn down, so no change events, just a save.
    const now = Date.now();
    const out: Checklist[] = [];
    for (const [id, at] of this.closedAt)
      if (now - at <= withinMs) {
        const c = this.store.get(id);
        if (c && !c.closed && c.hidden) {
          c.hidden = false;
          out.push(c);
        }
      }
    return out;
  }

  private closedAt = new Map<string, number>();

  private attach(p: vscode.WebviewPanel, c: Checklist) {
    p.title = c.title;
    p.iconPath = vscode.Uri.joinPath(this.extUri, 'media', 'tab.svg');
    p.webview.html = this.html(p.webview);
    p.webview.onDidReceiveMessage((m) => this.onMessage(c.id, m));
    p.onDidDispose(() => {
      this.open.delete(c.id);
      this.ready.delete(c.id);
      // Closing the tab = hiding. Closing the checklist for good is a separate action.
      const cur = this.store.get(c.id);
      if (cur && !cur.closed && !cur.hidden) {
        this.closedAt.set(c.id, Date.now());
        this.store.setHidden(c.id, true);
      }
    });
    this.open.set(c.id, p);
    this.closedAt.delete(c.id);
  }

  hide(id: string) {
    this.open.get(id)?.dispose();
    this.closedAt.delete(id); // the user asked for this one
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
    if (this.ready.has(c.id)) p.webview.postMessage(this.state(c, p.webview));
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
        const p = this.open.get(id);
        if (c && p) p.webview.postMessage(this.state(c, p.webview));
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
      case 'answerDraft':
        s.setAnswerDraft(id, m.qid, { picks: m.picks, other: m.other, note: m.note });
        break;
      case 'shareAnswer':
        s.setAnswerDraft(id, m.qid, { picks: m.picks, other: m.other, note: m.note });
        if (!s.shareAnswer(id, m.qid)) this.open.get(id)?.webview.postMessage({ type: 'toast', text: 'Pick an option first' });
        break;
      case 'unshareAnswer':
        s.unshareAnswer(id, m.qid);
        break;
      case 'sendNow': {
        const c = s.get(id);
        if (c) await this.hooks.sendNow(c);
        break;
      }
      case 'setAway': {
        if (s.setAway(id, m.ms, m.label, m.midnightIn)) break;
        const c = s.get(id);
        if (!c || c.closed) break; // it is gone: nothing to tell
        // Say what was wrong, and let the panel go back to the picker instead of sitting on a question that does nothing.
        const web = this.open.get(id)?.webview;
        web?.postMessage({ type: 'toast', text: 'Pick a time within the next 24 hours' });
        web?.postMessage({ type: 'awayRefused' });
        break;
      }
      case 'endAway':
        s.endAway(id);
        break;
      case 'copy':
        if (typeof m.text === 'string') {
          await vscode.env.clipboard.writeText(m.text);
          const what = typeof m.label === 'string' && /^[a-z]\d{1,4}$/.test(m.label) ? ` ${m.label}. Paste it into the Claude chat to refer to it.` : '';
          this.open.get(id)?.webview.postMessage({ type: 'toast', text: `Copied${what}` });
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
