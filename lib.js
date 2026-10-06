// Session discovery and deletion for Claude Code transcripts. No vscode
// dependency, so it can be exercised with plain node (see test.js).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const FULL_READ_LIMIT = 8 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Mirrors the CLI: every non-alphanumeric char becomes '-'. Long paths are
// truncated with a hash suffix, so we also accept a 200-char prefix match.
function encodeProjectPath(p) {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

async function projectDirsFor(folderPaths) {
  const root = path.join(claudeDir(), 'projects');
  let names;
  try {
    names = await fsp.readdir(root);
  } catch {
    return [];
  }
  const wanted = folderPaths.map((p) => encodeProjectPath(p).toLowerCase());
  return names
    .filter((n) => {
      const ln = n.toLowerCase();
      return wanted.some(
        (w) =>
          ln === w ||
          ln.startsWith(w + '--claude-worktrees-') ||
          (w.length > 200 && ln.startsWith(w.slice(0, 200)))
      );
    })
    .map((n) => path.join(root, n));
}

async function allProjectDirs() {
  const root = path.join(claudeDir(), 'projects');
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}

async function readHeadAndTail(file, size) {
  if (size <= FULL_READ_LIMIT) return fsp.readFile(file, 'utf8');
  const fh = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(CHUNK);
    const tail = Buffer.alloc(CHUNK);
    await fh.read(head, 0, CHUNK, 0);
    await fh.read(tail, 0, CHUNK, size - CHUNK);
    return head.toString('utf8') + '\n' + tail.toString('utf8');
  } finally {
    await fh.close();
  }
}

function userText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = content.find((c) => c && c.type === 'text' && typeof c.text === 'string');
    return t ? t.text : '';
  }
  return '';
}

function cleanPrompt(text) {
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (cmd) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text);
    return (cmd[1] + ' ' + (args ? args[1] : '')).trim();
  }
  if (/^\s*<(local-command|system-reminder)/.test(text)) return '';
  return text.replace(/\s+/g, ' ').trim();
}

// Same precedence as the Claude extension: last custom title, else last AI
// title, else the prompt text.
function extractTitle(text) {
  let custom, ai, lastPrompt, firstPrompt;
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type === 'custom-title' && d.customTitle) custom = d.customTitle;
    else if (d.type === 'ai-title' && d.aiTitle) ai = d.aiTitle;
    else if (d.type === 'last-prompt' && d.lastPrompt) lastPrompt = d.lastPrompt;
    else if (!firstPrompt && d.type === 'user' && !d.isMeta && !d.isSidechain && d.message) {
      firstPrompt = cleanPrompt(userText(d.message.content)) || undefined;
    }
  }
  return custom || ai || firstPrompt || (lastPrompt && cleanPrompt(lastPrompt)) || '(untitled)';
}

async function listSessions(projectDirs) {
  const sessions = [];
  for (const dir of projectDirs) {
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!UUID_JSONL.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const st = await fsp.stat(file);
        if (st.size === 0) continue;
        const title = extractTitle(await readHeadAndTail(file, st.size));
        sessions.push({
          id: name.slice(0, -'.jsonl'.length),
          title,
          file,
          projectDir: dir,
          mtime: st.mtimeMs,
          size: st.size,
        });
      } catch {
        // unreadable or vanished mid-scan: skip
      }
    }
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

// Every on-disk artifact belonging to a session that currently exists.
async function sessionPaths(session) {
  const base = claudeDir();
  const candidates = [
    session.file,
    path.join(session.projectDir, session.id),
    path.join(base, 'file-history', session.id),
    path.join(base, 'session-env', session.id),
    path.join(base, 'debug', session.id + '.txt'),
  ];
  try {
    for (const n of await fsp.readdir(path.join(base, 'todos'))) {
      if (n.startsWith(session.id)) candidates.push(path.join(base, 'todos', n));
    }
  } catch {
    // no todos dir
  }
  const existing = [];
  for (const p of candidates) {
    try {
      await fsp.access(p);
      existing.push(p);
    } catch {
      // not present
    }
  }
  return existing;
}

function normalizeTitle(s) {
  return s.replace(/\s+/g, ' ').trim();
}

// The extension labels tabs with the title cut to 24 chars + '…'.
function tabLabelMatches(label, title) {
  const l = normalizeTitle(label);
  const t = normalizeTitle(title);
  if (!l || !t) return false;
  if (l.endsWith('…')) {
    const prefix = l.slice(0, -1);
    return prefix !== '' && t !== prefix && t.startsWith(prefix);
  }
  return l === t;
}

module.exports = {
  claudeDir,
  encodeProjectPath,
  projectDirsFor,
  allProjectDirs,
  listSessions,
  sessionPaths,
  extractTitle,
  tabLabelMatches,
};
