# Changelog

## 0.2.0

- After deleting, restart the extension host so Claude Code refreshes its session list (`claudeSessionDelete.restartAfterDelete`, on by default). Other sessions resume when `claudeCode.continueAfterReload` is on.
- Activate on startup so stub cleanup continues after a reload or restart.

## 0.1.1

- Fix: a deleted session that was open came back as an empty entry in the Claude list. Its CLI re-writes title/cost metadata when it exits, sometimes a minute or more later. Deleted sessions are now watched for 10 minutes and any metadata-only stub is removed.

## 0.1.0

- Initial release: delete-session button on Claude Code sidebar, sessions list and editor tabs.
