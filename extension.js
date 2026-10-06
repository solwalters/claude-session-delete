const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');

const CLAUDE_PANEL_VIEW_TYPE = 'claudeVSCodePanel';
const PROCESS_EXIT_GRACE_MS = 1000;
// A closed session's CLI can outlive its tab by a minute or more, then
// re-append metadata to the deleted transcript on exit. Deleted sessions are
// tombstoned for this long and any metadata-only stub is swept away.
const TOMBSTONE_TTL_MS = 10 * 60 * 1000;
const TOMBSTONE_POLL_MS = 2000;
const TOMBSTONE_KEY = 'tombstones';
const NOTICE_KEY = 'pendingNotice';

let extContext;
let pollTimer;
let sweeping = false;

// Activates on startup (not just on command) so tombstones keep being swept
// after a reload or the post-delete extension host restart.
function activate(context) {
  extContext = context;
  context.subscriptions.push({ dispose: () => clearInterval(pollTimer) });
  sweepTombstones();
  showPendingNotice();
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSessionDelete.deleteSession', () =>
      deleteFlow({ allProjects: false, preselectActiveTab: true })
    ),
    vscode.commands.registerCommand('claudeSessionDelete.deleteSessionFromView', () =>
      deleteFlow({ allProjects: false, preselectActiveTab: false })
    ),
    vscode.commands.registerCommand('claudeSessionDelete.deleteSessionAllProjects', () =>
      deleteFlow({ allProjects: true, preselectActiveTab: true })
    )
  );
}

function claudeTabs() {
  return vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter(
      (t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith(CLAUDE_PANEL_VIEW_TYPE)
    );
}

function activeClaudeTab() {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  return tab && claudeTabs().includes(tab) ? tab : undefined;
}

function workspaceRoots() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length ? folders.map((f) => f.uri.fsPath) : [os.homedir()];
}

function relativeTime(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function deleteFlow({ allProjects, preselectActiveTab }) {
  const dirs = allProjects ? await lib.allProjectDirs() : await lib.projectDirsFor(workspaceRoots());
  const sessions = await lib.listSessions(dirs);
  if (sessions.length === 0) {
    const pick = await vscode.window.showInformationMessage(
      'No Claude sessions found for this workspace.',
      'Show All Projects'
    );
    if (pick) await deleteFlow({ allProjects: true, preselectActiveTab });
    return;
  }

  const openTabs = claudeTabs();
  const active = preselectActiveTab ? activeClaudeTab() : undefined;
  // Several sessions can share a truncated tab label; the newest one wins.
  const activeSession = active && sessions.find((s) => lib.tabLabelMatches(active.label, s.title));

  const items = sessions.map((s) => {
    const isOpen = openTabs.some((t) => lib.tabLabelMatches(t.label, s.title));
    const bits = [relativeTime(s.mtime), formatSize(s.size)];
    if (s === activeSession) bits.unshift('$(arrow-left) this tab');
    else if (isOpen) bits.unshift('$(window) open');
    return {
      label: s.title,
      description: bits.join(' · '),
      detail: allProjects ? `${s.id}  ·  ${path.basename(s.projectDir)}` : s.id,
      session: s,
    };
  });
  if (activeSession) {
    const i = items.findIndex((it) => it.session === activeSession);
    items.unshift(...items.splice(i, 1));
  }

  const qp = vscode.window.createQuickPick();
  qp.title = allProjects ? 'Delete Claude sessions (all projects)' : 'Delete Claude sessions';
  qp.placeholder = 'Select sessions to delete, then press Enter';
  qp.canSelectMany = true;
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.items = items;
  if (activeSession) qp.selectedItems = [items[0]];
  if (!allProjects) {
    qp.buttons = [{ iconPath: new vscode.ThemeIcon('globe'), tooltip: 'Show sessions from all projects' }];
  }

  const chosen = await new Promise((resolve) => {
    let switched = false;
    qp.onDidTriggerButton(() => {
      switched = true;
      qp.hide();
      resolve('all');
    });
    qp.onDidAccept(() => {
      resolve(qp.selectedItems.map((i) => i.session));
      qp.hide();
    });
    qp.onDidHide(() => {
      if (!switched) resolve([]);
      qp.dispose();
    });
    qp.show();
  });

  if (chosen === 'all') return deleteFlow({ allProjects: true, preselectActiveTab });
  if (chosen.length === 0) return;
  await confirmAndDelete(chosen, sessions);
}

function useRecycleBin() {
  return vscode.workspace.getConfiguration('claudeSessionDelete').get('useRecycleBin', true);
}

async function deletePaths(paths, useTrash) {
  const failures = [];
  for (const p of paths) {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(p), { recursive: true, useTrash });
    } catch (err) {
      failures.push(`${p}: ${err.message || err}`);
    }
  }
  return failures;
}

function getTombstones() {
  const now = Date.now();
  return extContext.globalState.get(TOMBSTONE_KEY, []).filter((t) => t.until > now);
}

async function addTombstones(sessions) {
  const until = Date.now() + TOMBSTONE_TTL_MS;
  const ids = new Set(sessions.map((s) => s.id));
  const fresh = sessions.map(({ id, title, file, projectDir }) => ({ id, title, file, projectDir, until }));
  await extContext.globalState.update(TOMBSTONE_KEY, [
    ...getTombstones().filter((t) => !ids.has(t.id)),
    ...fresh,
  ]);
  ensurePolling();
}

function ensurePolling() {
  const pending = getTombstones().length > 0;
  if (pending && !pollTimer) {
    pollTimer = setInterval(sweepTombstones, TOMBSTONE_POLL_MS);
  } else if (!pending && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

async function sweepTombstones() {
  if (sweeping) return;
  sweeping = true;
  const resumed = [];
  try {
    for (const t of getTombstones()) {
      const paths = await lib.sessionPaths(t);
      if (paths.length === 0) continue;
      let text = '';
      try {
        text = await fs.promises.readFile(t.file, 'utf8');
      } catch {
        // transcript absent; only side folders came back
      }
      if (lib.hasConversation(text)) {
        resumed.push(t);
        continue;
      }
      await deletePaths(paths, useRecycleBin());
    }
    const resumedIds = new Set(resumed.map((t) => t.id));
    await extContext.globalState.update(
      TOMBSTONE_KEY,
      getTombstones().filter((t) => !resumedIds.has(t.id))
    );
  } finally {
    sweeping = false;
    ensurePolling();
  }
  if (resumed.length) {
    vscode.window.showWarningMessage(
      `Still in use in Claude, so new messages were saved after the delete: ${resumed
        .map((t) => `"${t.title}"`)
        .join(', ')}. Switch the sidebar to a different session, then delete again.`
    );
  }
}

async function confirmAndDelete(chosen, allSessions) {
  const useTrash = useRecycleBin();
  const restart = restartAfterDelete();
  const names = chosen.map((s) => `• ${s.title}`).join('\n');
  const verb = useTrash ? 'moved to the Recycle Bin' : 'permanently deleted';
  let detail = `${names}\n\nTranscripts and file history will be ${verb}.`;
  if (restart) {
    const resumes = vscode.workspace.getConfiguration('claudeCode').get('continueAfterReload', true);
    detail += resumes
      ? '\n\nExtensions will then restart to refresh Claude Code. Other Claude sessions continue where they left off.'
      : '\n\nExtensions will then restart to refresh Claude Code. Running Claude sessions in other tabs will be interrupted.';
  }
  const ok = await vscode.window.showWarningMessage(
    chosen.length === 1 ? 'Delete this Claude session?' : `Delete ${chosen.length} Claude sessions?`,
    { modal: true, detail },
    'Delete'
  );
  if (ok !== 'Delete') return;

  // Close the editor tabs showing these sessions so their CLI processes exit
  // and stop writing. Skip any tab whose label is ambiguous with a session
  // we are keeping.
  const chosenSet = new Set(chosen);
  const keep = allSessions.filter((s) => !chosenSet.has(s));
  const toClose = claudeTabs().filter(
    (t) =>
      chosen.some((s) => lib.tabLabelMatches(t.label, s.title)) &&
      !keep.some((s) => lib.tabLabelMatches(t.label, s.title))
  );
  if (toClose.length) {
    await vscode.window.tabGroups.close(toClose);
    await new Promise((r) => setTimeout(r, PROCESS_EXIT_GRACE_MS));
  }

  const failures = [];
  for (const s of chosen) {
    failures.push(...(await deletePaths(await lib.sessionPaths(s), useTrash)));
  }
  await addTombstones(chosen);

  if (failures.length) {
    vscode.window.showErrorMessage(`Some files could not be deleted:\n${failures.join('\n')}`);
    return;
  }
  const done = chosen.length === 1 ? `Deleted "${chosen[0].title}".` : `Deleted ${chosen.length} sessions.`;
  if (!restart) {
    vscode.window.showInformationMessage(done);
    return;
  }
  // The Claude extension only rebuilds its session list on startup, so
  // restart the extension host. The notice is shown by the next activation.
  await extContext.globalState.update(NOTICE_KEY, `${done} Claude Code was restarted to refresh its list.`);
  await sweepTombstones();
  await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
}

function restartAfterDelete() {
  return vscode.workspace.getConfiguration('claudeSessionDelete').get('restartAfterDelete', true);
}

async function showPendingNotice() {
  const notice = extContext.globalState.get(NOTICE_KEY);
  if (!notice) return;
  await extContext.globalState.update(NOTICE_KEY, undefined);
  vscode.window.showInformationMessage(notice);
}

function deactivate() {}

module.exports = { activate, deactivate };
