import * as vscode from 'vscode';
import { Checklist, ChecklistStore } from './model';
import { Panels } from './panels';

export class ChecklistTree implements vscode.TreeDataProvider<Checklist> {
  private emitter = new vscode.EventEmitter<Checklist | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private store: ChecklistStore, private panels: Panels) {}

  refresh() {
    this.emitter.fire();
  }

  getChildren(): Checklist[] {
    return this.store.all();
  }

  getTreeItem(c: Checklist): vscode.TreeItem {
    const left = c.tasks.filter((t) => !t.shared).length;
    const decide = c.questions.filter((q) => !q.answer && !q.retired).length;
    const shown = this.panels.isOpen(c.id);
    const item = new vscode.TreeItem(c.title);
    item.id = c.id;
    const parts = [left && `${left} to do`, decide && `${decide} to decide`].filter(Boolean);
    item.description = c.tasks.length + c.questions.length ? (parts.length ? parts.join(', ') : 'all shared') : 'empty';
    if (c.folder) item.description += `  ${c.folder}`;
    item.iconPath = new vscode.ThemeIcon(
      decide ? 'question' : left ? 'circle-large-outline' : 'pass',
      left || decide ? undefined : new vscode.ThemeColor('testing.iconPassed')
    );
    item.contextValue = shown ? 'checklist.shown' : 'checklist.hidden';
    item.tooltip = new vscode.MarkdownString(
      `**${c.title}**\n\n${c.tasks.length} tasks, ${c.tasks.length - left} shared with Claude` +
        (c.folder ? `\n\nChat in \`${c.folder}\`` : '') +
        `\n\n${shown ? 'Open. Click to bring it to the front.' : 'Hidden. Click to open it.'} Use the eye button to hide it.`
    );
    item.command = { command: 'checklistBridge.show', title: 'Open checklist', arguments: [c.id] };
    return item;
  }
}
