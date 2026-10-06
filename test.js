// Smoke test for lib.js against the real ~/.claude store. Read-only.
// Usage: node test.js [workspace path]
const assert = require('assert');
const lib = require('./lib');

assert.ok(lib.tabLabelMatches('VSCode extension delete …', 'VSCode extension delete session button'));
assert.ok(lib.tabLabelMatches('Short title', 'Short title'));
assert.ok(!lib.tabLabelMatches('Other title…', 'VSCode extension delete session button'));
assert.ok(!lib.tabLabelMatches('Claude Code', 'Something else'));

(async () => {
  const ws = process.argv[2] || process.cwd();
  const dirs = await lib.projectDirsFor([ws]);
  console.log('project dirs:', dirs);
  const sessions = await lib.listSessions(dirs);
  for (const s of sessions.slice(0, 10)) {
    const paths = await lib.sessionPaths(s);
    console.log(`${s.id}  ${new Date(s.mtime).toISOString().slice(0, 16)}  ${s.title}  [${paths.length} paths]`);
  }
  console.log(`${sessions.length} sessions; all projects: ${(await lib.allProjectDirs()).length} dirs`);
})();
