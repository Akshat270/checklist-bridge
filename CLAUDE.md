# Checklist Bridge: notes for Claude

A VS Code extension (Marketplace id `Akshat270.checklist-bridge`) that gives each Claude Code chat its own checklist of manual tasks (t1, t2…) and deferred questions (q1, q2…). It is public and used by people other than the author, so changes must work on Windows, macOS and Linux, and in both the VS Code Claude panel and the terminal.

Read `README.md` for what users see. `PRODUCT.md` and `DESIGN.md` describe who it's for and the panel's visual rules: read them before changing anything in `media/`.

## Commands

```
npm ci                      # install (package-lock.json is committed)
npm run build               # src/*.ts -> dist/*.js (tsc)
npm test                    # every suite in test/, against dist/ — build first
node test/run.js reload     # one suite, by file-name prefix
npx playwright install chromium   # needed for the panel (ui/layout) suites; they SKIP without it
```

Always `npm run build` before `npm test`: the tests run the compiled `dist/extension.js`, not the TypeScript.

## How it fits together

```
Claude Code chat ──stdio──> connector.ts (one per chat, MCP server + Claude Code channel)
                                │  finds its window through registry.ts (~/.checklist-bridge/windows/*.json)
                                ▼
VS Code window ── windowServer.ts (local HTTP, per-window token) ── extension.ts
                                                                     ├─ model.ts   checklist data + Claude's tools
                                                                     ├─ panels.ts  webview tabs (media/panel.js, panel.css)
                                                                     ├─ saver.ts / images.ts / ownership.ts   storage
                                                                     ├─ claudeConnect.ts   `claude mcp add`, auto-connect
                                                                     ├─ claudeSetup.ts     ~/.claude/CLAUDE.md + settings.json block
                                                                     ├─ sidebar.ts, updater.ts, settings.ts
```

- `extension.ts` copies `connector.js` to `~/.checklist-bridge/connector/` and registers it with Claude Code as the user-scope MCP server `checklist`.
- The connector holds no state. Every tool call goes to the chat's VS Code window, which owns the checklist.
- Checklists are saved under the workspace storage (or global storage for folderless windows) in `checklists/<id>.json`; screenshots are separate files in `checklists/images/`.
- Send now reaches Claude by one of: a waiting `checklist_wait` call, a Claude Code channel push, typing into Claude's terminal, or the clipboard.

## Rules that matter

- **Modules without `import 'vscode'` stay that way** (`model`, `saver`, `images`, `ownership`, `registry`, `claudeConnect`, `connector`). They are tested directly in Node. Put new logic there when you can and keep `extension.ts` as glue.
- **Settings that pick a program or an update source** (`updateRepo`, `autoUpdate`, `autoConnect`, `claudePath`) are read only with `userSetting()` from `settings.ts`, never `getConfiguration().get()`. A project's `.vscode/settings.json` must not be able to redirect updates or run a program. Their `scope` in `package.json` must stay `application` or `machine`; `test/settings.test.js` checks this.
- **Test-only environment hooks** (`CHECKLIST_BRIDGE_UPDATE_BASE`, `CHECKLIST_BRIDGE_CLAUDE`) work only when `CHECKLIST_BRIDGE_TEST=1`. Any new hook must follow the same rule. `test/run.js` sets it.
- **Never touch the real user's files in tests.** Pass an `env` with a temp `HOME`, `USERPROFILE`, `CLAUDE_CONFIG_DIR` and `CHECKLIST_BRIDGE_HOME` through to every child process (`claudeConnect.run` takes `env` for this). A test once wrote to the real `~/.claude.json` because env wasn't passed down.
- **Saving must not lose data.** Go through `Saver` (atomic tmp+rename, Windows lock retries, `close()` on shutdown). Don't write checklist files directly. VS Code closes every tab while a window shuts down; that must not be saved as "hidden" (see `undoShutdownCloses` in `panels.ts`).
- **Windows quoting.** Programs are run with `execFile` and no shell. `.cmd` files go through `ComSpec /d /s /c` with the quoting in `claudeConnect.run`. Paths with spaces, `&` and `%` are tested on Windows CI.
- **Claude's instructions** live in `SERVER_INSTRUCTIONS` (`model.ts`) and `INSTRUCTIONS` (`claudeSetup.ts`). Keep them in step when changing how tools behave.
- **Item ids** (t1, q1) are shown in the panel and used by Claude. Don't renumber existing items.

## Tests

- `test/harness/fakewin.js` is a stand-in VS Code window: it runs the real `dist/extension.js` with a fake `vscode` module and is driven over IPC (`W.send({cmd: ...})`). Settings come from `CB_SETTINGS` / `CB_WS_SETTINGS`.
- `test/harness/fake-claude/` is a fake `claude` CLI that records `mcp add/remove/get` into a temp `.claude.json`.
- `test/harness/fakeclaude.js` stands in for a running `claude` process: it starts the real connector as its child, so tests call tools the way a chat does.
- `real-claude.test.js` uses the real `claude` if installed and skips otherwise.
- Suites print `PASS …` / `FAIL …` lines; `run.js` counts them. Add a regression test with every bug fix, and check it fails without the fix.
- CI (`.github/workflows/test.yml`) runs on Ubuntu, Windows and macOS. The panel suites run on Linux only. Failures show as annotations on the run (`gh api repos/Akshat270/checklist-bridge/check-runs/<id>/annotations`).

## Working on a change

- Work on a branch and open a pull request into `main`. `main` is protected: it needs a pull request, and the owner merges it. Several Claude sessions may be working at once, so keep each pull request to one change.
- Add a line for user-visible changes under `## Unreleased` at the top of `CHANGELOG.md` (create the heading if it's missing). Write it for users, in plain words: what changed for them, not how.
- Update `README.md` if behaviour, commands or settings change.
- **Do not release unless the owner asks.** Don't change the version, `latest.json` or `releases/` in a normal pull request.

## Releasing (only when asked)

Pushing `latest.json` to `main` ships the update: every GitHub-installed copy updates itself from it.

1. Bump `version` in `package.json` and in both places at the top of `package-lock.json`.
2. Rename `## Unreleased` in `CHANGELOG.md` to `## <version>`.
3. `python3 scripts/release.py "one-line note"`: builds, writes `releases/checklist-bridge-<version>.vsix` and `releases/checklist-bridge-latest.vsix`, and updates `latest.json` with the SHA-256.
4. `npm test`, then commit everything with the message `Release <version>: …` and merge to `main`.
5. The Marketplace is updated by hand: the owner uploads the `.vsix` at marketplace.visualstudio.com/manage (`publish.yml` only publishes if a `VSCE_PAT` secret exists, and there isn't one). Give the owner the `.vsix` file.

## Writing style

The README, changelog, walkthrough (`media/walkthrough/*.md`), messages shown in VS Code and commit messages are written in plain, short sentences for people who may not be developers. Say what happens and what to do. Avoid jargon, hype and long explanations.
