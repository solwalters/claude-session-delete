const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');

const CLAUDE_PANEL_VIEW_TYPE = 'claudeVSCodePanel';
const PROCESS_EXIT_GRACE_MS = 1000;
const RESPAWN_CHECK_MS = 3000;

function activate(context) {
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

async function confirmAndDelete(chosen, allSessions) {
  const useTrash = vscode.workspace.getConfiguration('claudeSessionDelete').get('useRecycleBin', true);
  const names = chosen.map((s) => `• ${s.title}`).join('\n');
  const verb = useTrash ? 'moved to the Recycle Bin' : 'permanently deleted';
  const ok = await vscode.window.showWarningMessage(
    chosen.length === 1 ? 'Delete this Claude session?' : `Delete ${chosen.length} Claude sessions?`,
    { modal: true, detail: `${names}\n\nTranscripts and file history will be ${verb}.` },
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
    for (const p of await lib.sessionPaths(s)) {
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(p), { recursive: true, useTrash });
      } catch (err) {
        failures.push(`${p}: ${err.message || err}`);
      }
    }
  }

  if (failures.length) {
    vscode.window.showErrorMessage(`Some files could not be deleted:\n${failures.join('\n')}`);
  } else {
    vscode.window.showInformationMessage(
      chosen.length === 1 ? `Deleted "${chosen[0].title}".` : `Deleted ${chosen.length} sessions.`
    );
  }

  // A session still live in the sidebar keeps its CLI running and will
  // recreate the transcript on its next write.
  setTimeout(() => {
    const respawned = chosen.filter((s) => fs.existsSync(s.file));
    if (respawned.length) {
      vscode.window.showWarningMessage(
        `Still running in Claude, so its transcript came back: ${respawned
          .map((s) => `"${s.title}"`)
          .join(', ')}. Switch the sidebar to a different session, then delete again.`
      );
    }
  }, RESPAWN_CHECK_MS);
}

function deactivate() {}

module.exports = { activate, deactivate };
