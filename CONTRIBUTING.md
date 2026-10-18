# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Set up

You need Node.js 20 or newer and VS Code.

```
git clone https://github.com/Akshat270/checklist-bridge
cd checklist-bridge
npm ci
npm run build
npm test
```

The panel tests also need a browser: `npx playwright install chromium`. Without it they're skipped.

To try your build in VS Code, open the folder and press **F5** (Run Extension), or package it with `python3 scripts/release.py` and install `releases/checklist-bridge-latest.vsix` with *Extensions: Install from VSIX…*. Packaging changes `latest.json`; don't commit that unless you're making a release.

## Making a change

1. Create a branch from `main`.
2. Make the change, and add or update a test in `test/` (run `npm run build` before `npm test`).
3. If users will notice the change, add a line under `## Unreleased` at the top of `CHANGELOG.md`, and update `README.md` if needed.
4. Open a pull request. Tests run on Linux, Windows and macOS.

Don't change the version number, `latest.json` or `releases/`: the maintainer does that when releasing.

`CLAUDE.md` explains how the code fits together and the rules that keep it safe (settings, storage, tests). It's written for Claude Code but it's the best guide for people too.

## Using Claude Code on this repo

Claude Code reads `CLAUDE.md` automatically. `.claude/settings.json` lets it build and run the tests without asking each time. Ask it to work on a branch and open a pull request.
