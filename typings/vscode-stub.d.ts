// Minimal typing stub for the parts of the VS Code API this extension uses.
// Only used for offline typechecking; the real `vscode` module is provided by VS Code at runtime.
interface Thenable<T> extends PromiseLike<T> {}
declare module 'vscode' {
  export interface Disposable { dispose(): any }
  export interface Event<T> { (listener: (e: T) => any): Disposable }
  export class EventEmitter<T> { event: Event<T>; fire(data?: T): void; dispose(): void }
  export class ThemeColor { constructor(id: string) }
  export class ThemeIcon { constructor(id: string, color?: ThemeColor) }
  export class MarkdownString { constructor(value?: string) }
  export class Uri {
    static joinPath(base: Uri, ...parts: string[]): Uri;
    static file(p: string): Uri;
    static parse(value: string): Uri;
    readonly fsPath: string;
    toString(): string;
  }
  export enum ViewColumn { Active = -1, Beside = -2, One = 1 }
  export enum ProgressLocation { SourceControl = 1, Window = 10, Notification = 15 }
  export enum StatusBarAlignment { Left = 1, Right = 2 }
  export class TreeItem {
    constructor(label: string);
    id?: string; description?: string; tooltip?: string | MarkdownString;
    iconPath?: ThemeIcon | Uri; contextValue?: string;
    command?: { command: string; title: string; arguments?: any[] };
  }
  export interface TreeDataProvider<T> {
    onDidChangeTreeData?: Event<T | undefined | void>;
    getTreeItem(e: T): TreeItem;
    getChildren(e?: T): T[] | Thenable<T[]>;
  }
  export interface TreeView<T> extends Disposable {
    badge?: { value: number; tooltip: string };
    message?: string;
    visible: boolean;
    onDidChangeVisibility: Event<{ visible: boolean }>;
  }
  export interface Webview {
    html: string;
    options: { enableScripts?: boolean; localResourceRoots?: Uri[] };
    readonly cspSource: string;
    asWebviewUri(u: Uri): Uri;
    onDidReceiveMessage: Event<any>;
    postMessage(message: any): Thenable<boolean>;
  }
  export interface WebviewPanel {
    webview: Webview;
    title: string;
    iconPath?: Uri;
    reveal(column?: ViewColumn, preserveFocus?: boolean): void;
    onDidDispose: Event<void>;
    dispose(): any;
  }
  export interface StatusBarItem {
    text: string; tooltip: string | undefined; command: string | undefined;
    backgroundColor: ThemeColor | undefined; show(): void; hide(): void; dispose(): void;
  }
  export interface OutputChannel { appendLine(v: string): void; show(preserveFocus?: boolean): void; dispose(): void }
  export interface Terminal { show(): void; sendText(text: string, addNewLine?: boolean): void; readonly processId: Thenable<number | undefined>; readonly name: string }
  export interface Memento { get<T>(key: string): T | undefined; update(key: string, value: any): Thenable<void> }
  export interface EnvironmentVariableCollection { replace(variable: string, value: string): void }
  export interface ExtensionContext {
    extension?: { id: string };
    subscriptions: { dispose(): any }[];
    extensionUri: Uri;
    storageUri: Uri | undefined;
    globalStorageUri: Uri;
    globalState: Memento;
    environmentVariableCollection: EnvironmentVariableCollection;
  }
  export interface WorkspaceFolder { uri: Uri; name: string }
  export interface WindowState { focused: boolean }
  export interface QuickPickItem { label: string; description?: string; detail?: string }
  export namespace window {
    const state: WindowState;
    const onDidChangeWindowState: Event<WindowState>;
    const terminals: readonly Terminal[];
    const onDidOpenTerminal: Event<Terminal>;
    const onDidCloseTerminal: Event<Terminal>;
    function createWebviewPanel(
      viewType: string, title: string,
      showOptions: ViewColumn | { viewColumn: ViewColumn; preserveFocus?: boolean },
      options?: { enableScripts?: boolean; retainContextWhenHidden?: boolean; localResourceRoots?: Uri[] }
    ): WebviewPanel;
    const tabGroups: { all: readonly { tabs: readonly { label: string; input: unknown }[] }[] };
    function withProgress<R>(options: { location: ProgressLocation; title?: string }, task: () => Thenable<R>): Thenable<R>;
    function showWarningMessage(message: string, ...items: string[]): Thenable<string | undefined>;
    function registerWebviewPanelSerializer(viewType: string, serializer: { deserializeWebviewPanel(panel: WebviewPanel, state: any): Thenable<void> }): Disposable;
    function createTreeView<T>(id: string, opts: { treeDataProvider: TreeDataProvider<T> }): TreeView<T>;
    function showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>;
    function showInformationMessage(message: string, options: { modal?: boolean; detail?: string }, ...items: string[]): Thenable<string | undefined>;
    function showErrorMessage(message: string, ...items: string[]): Thenable<string | undefined>;
    function showWarningMessage(message: string, options: { modal?: boolean; detail?: string }, ...items: string[]): Thenable<string | undefined>;
    function showQuickPick<T extends QuickPickItem>(items: T[], opts?: { placeHolder?: string }): Thenable<T | undefined>;
    function setStatusBarMessage(text: string, hideAfterTimeout: number): Disposable;
    function createOutputChannel(name: string): OutputChannel;
    function createStatusBarItem(alignment?: StatusBarAlignment, priority?: number): StatusBarItem;
    function createTerminal(opts: { name: string }): Terminal;
  }
  export namespace commands {
    function registerCommand(command: string, callback: (...args: any[]) => any): Disposable;
    function executeCommand(command: string, ...args: any[]): Thenable<any>;
  }
  export namespace workspace {
    const name: string | undefined;
    const workspaceFolders: readonly WorkspaceFolder[] | undefined;
    const workspaceFile: Uri | undefined;
    const onDidChangeWorkspaceFolders: Event<any>;
    function getConfiguration(section?: string): { get<T>(key: string, defaultValue: T): T };
  }
  export namespace extensions {
    function getExtension(id: string): { id: string; extensionPath: string } | undefined;
  }
  export namespace env {
    const clipboard: { writeText(value: string): Thenable<void> };
    function openExternal(target: Uri): Thenable<boolean>;
  }
}
