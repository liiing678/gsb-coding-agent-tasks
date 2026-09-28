import { createIgnore } from '../lib/globignore.js';

const lines = [
  '# 构建产物不提交',
  'node_modules/',
  'build/',
  '*.log',
  '/dist',
  'docs/**/tmp',
  '!build/keep.md',
  '!important.log',
];

const ignore = createIgnore({ lines });

const rows = [
  { path: 'src/app.js', isDir: false },
  { path: 'node_modules/left-pad/index.js', isDir: false },
  { path: 'deep/nested/error.log', isDir: false },
  { path: 'important.log', isDir: false },
  { path: 'build/keep.md', isDir: false },
  { path: 'build/out.js', isDir: false },
  { path: 'dist/bundle.js', isDir: false },
  { path: 'src/dist/bundle.js', isDir: false },
  { path: 'docs/v1/tmp', isDir: true },
  { path: 'docs/tmp/note.md', isDir: false },
];

console.log('globignore demo');
console.log(`  rules: ${ignore.rules().map((one) => one.source).join(' | ')}`);
for (const row of rows) {
  const verdict = ignore.test(row.path, { isDir: row.isDir });
  const which = verdict.blockedBy
    ? `blockedBy=${verdict.blockedBy}`
    : `rule=${verdict.rule === null ? '-' : verdict.rule}`;
  console.log(`  ${verdict.ignored ? 'IGNORE' : 'keep  '} ${row.path}${row.isDir ? '/' : ''} (${which})`);
}

const { kept, ignored } = ignore.partition(rows);
console.log(`  partition kept=${kept.length} ignored=${ignored.length}`);
