# Delete Session for Claude Code

> Unofficial. Not affiliated with or endorsed by Anthropic.

Adds a trash button to the Claude Code extension's sidebar, sessions list and
editor tabs. It deletes a session's transcript (`~/.claude/projects/<proj>/<id>.jsonl`
plus its folder), `file-history/<id>`, `session-env/<id>`, and any `todos`/`debug` files.

- **Editor tab button**: pre-selects the session in the active tab.
- **Sidebar / sessions list button**: lists this workspace's sessions, newest first.
- **Command Palette**: `Claude Code: Delete Session…` and `…(All Projects)…`.
- The globe button in the picker switches to all projects.

Files go to the Recycle Bin by default (`claudeSessionDelete.useRecycleBin`).
Open editor tabs for deleted sessions are closed first so the CLI exits. For 10
minutes afterwards, any metadata-only stub the exiting CLI writes back is removed. A
session that is live in the sidebar can't be closed from here: switch the sidebar
to another session, then delete it.

The archived list lives in the Claude extension's private storage, so a deleted
session's ID stays in it. A leftover ID there does nothing.

## Build

```
node test.js "C:\path\to\workspace"   # read-only smoke test
npx @vscode/vsce package
code --install-extension claude-session-delete-0.1.0.vsix
```
