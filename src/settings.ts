import * as vscode from 'vscode';

/**
 * A setting from the user's own settings only. A project's .vscode/settings.json must never decide
 * which repo updates come from or which program gets run, so project values are ignored here even if
 * VS Code would apply them. (package.json also declares these settings application/machine scope.)
 */
export function userSetting<T>(key: string, fallback: T): T {
  const i = vscode.workspace.getConfiguration('checklistBridge').inspect<T>(key);
  return (i?.globalValue ?? i?.defaultValue ?? fallback) as T;
}
