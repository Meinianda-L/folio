import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, symlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { FolioDomain, contentHash, kindOf } from '../domain.js';
import { buildCommand, snapshotSources, parseLog } from '../compiler.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'folio-domain-test-'));
const domain = new FolioDomain({ root });
let project;
test.after(async () => { await rm(root, { recursive: true, force: true }); });

test('creates projects from templates with persisted build settings', async () => {
  project = await domain.dispatch('createProject', { name: 'My paper', template: 'blank' });
  assert.equal(project.name, 'My paper');
  assert.equal(project.mainFile, 'main.tex');
  assert.equal(project.engine, 'pdflatex');
  assert.deepEqual((await domain.dispatch('listFiles', { projectId: project.id })).files.map(f => f.path), ['main.tex']);
  const chinese = await domain.dispatch('createProject', { name: '中文论文', template: 'ctex' });
  assert.equal(chinese.engine, 'xelatex');
  const article = await domain.dispatch('createProject', { name: 'Article' });
  assert.deepEqual((await domain.dispatch('listFiles', { projectId: article.id })).files.map(f => f.path), ['main.tex', 'references.bib']);
  const file = await domain.dispatch('readFile', { projectId: project.id, path: 'main.tex' });
  assert.equal(file.hash, contentHash(file.content));
  const updated = await domain.dispatch('updateProject', { projectId: project.id, engine: 'xelatex', sessionId: 'session-1', name: 'Renamed' });
  assert.deepEqual([updated.engine, updated.sessionId, updated.name], ['xelatex', 'session-1', 'Renamed']);
  await assert.rejects(domain.dispatch('updateProject', { projectId: project.id, engine: 'sh' }));
  await assert.rejects(domain.dispatch('updateProject', { projectId: project.id, mainFile: 'notes.txt' }));
});

test('writes atomically with optimistic hashes, rejects lost updates and deletes by revision', async () => {
  const args = { projectId: project.id, path: 'sections/new.tex' };
  await assert.rejects(domain.dispatch('writeFile', { ...args, content: 'missing expected hash' }), e => e.code === 'CONFLICT');
  const created = await domain.dispatch('writeFile', { ...args, content: 'first', expectedHash: null });
  const [a, b] = await Promise.allSettled([
    domain.dispatch('writeFile', { ...args, content: 'second', expectedHash: created.hash }),
    domain.dispatch('writeFile', { ...args, content: 'stale', expectedHash: created.hash })
  ]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.reason.code, 'CONFLICT');
  await domain.dispatch('deleteFile', { ...args, expectedHash: contentHash('second') });
  await assert.rejects(domain.dispatch('readFile', args), e => e.code === 'NOT_FOUND');
  assert.equal((await readdir(path.join(root, project.id))).includes('sections'), false, 'empty folders are pruned');
});

test('renames files, follows the main file, and uploads binary assets', async () => {
  await domain.dispatch('renameFile', { projectId: project.id, from: 'main.tex', to: 'paper.tex' });
  assert.equal((await domain.dispatch('getProject', { projectId: project.id })).mainFile, 'paper.tex');
  await domain.dispatch('writeFile', { projectId: project.id, path: 'other.tex', content: '', expectedHash: null });
  await assert.rejects(domain.dispatch('renameFile', { projectId: project.id, from: 'other.tex', to: 'paper.tex' }), e => e.code === 'CONFLICT');
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const uploaded = await domain.dispatch('uploadFile', { projectId: project.id, path: 'figures/plot.png', base64: png.toString('base64') });
  assert.equal(uploaded.kind, 'image');
  await assert.rejects(domain.dispatch('uploadFile', { projectId: project.id, path: 'figures/plot.png', base64: '' }), e => e.code === 'CONFLICT');
  assert.deepEqual((await domain.dispatch('readRaw', { projectId: project.id, path: 'figures/plot.png' })).bytes, png);
  await assert.rejects(domain.dispatch('readFile', { projectId: project.id, path: 'figures/plot.png' }), /Binary/);
  await domain.dispatch('deleteFile', { projectId: project.id, path: 'figures/plot.png' });
  assert.equal(kindOf('refs.bib'), 'text');
  assert.equal(kindOf('archive.zip'), 'binary');
});

test('rejects traversal, private paths, symlinks and oversized content', async () => {
  for (const file of ['../outside', '/etc/passwd', 'project.json', '.folio/proposals.json', 'a/../../out', 'a\\b', 'output/a', 'node_modules/a']) {
    await assert.rejects(domain.dispatch('readFile', { projectId: project.id, path: file }));
  }
  await assert.rejects(domain.dispatch('listFiles', { projectId: '../escape' }));
  await symlink(os.tmpdir(), path.join(root, project.id, 'linked'));
  await assert.rejects(domain.dispatch('readFile', { projectId: project.id, path: 'linked/example' }));
  await assert.rejects(domain.dispatch('writeFile', { projectId: project.id, path: 'large.tex', content: 'x'.repeat(2 * 1024 * 1024 + 1), expectedHash: null }), e => e.code === 'LIMIT_EXCEEDED');
  await rm(path.join(root, project.id, 'linked'));
});

test('deleting a project moves it to .trash instead of erasing it', async () => {
  const doomed = await domain.dispatch('createProject', { name: 'Doomed', template: 'blank' });
  await domain.dispatch('deleteProject', { projectId: doomed.id });
  assert.equal((await domain.dispatch('listProjects')).projects.some(item => item.id === doomed.id), false);
  assert.ok((await readdir(path.join(root, '.trash'))).some(name => name.startsWith(doomed.id)));
});

test('compiler denies shell escape, snapshots exclude private state, and logs become problems', async () => {
  assert.ok(buildCommand('pdflatex', 'main.tex').args.includes('-no-shell-escape'));
  assert.ok(buildCommand('tectonic', 'main.tex').args.includes('--untrusted'));
  assert.throws(() => buildCommand('sh', 'main.tex'));
  const destination = await mkdtemp(path.join(os.tmpdir(), 'folio-snapshot-test-'));
  await writeFile(path.join(root, project.id, '.secret'), 'private');
  try {
    assert.match(await snapshotSources(path.join(root, project.id), destination), /^[a-f0-9]{64}$/);
    await assert.rejects(readFile(path.join(destination, '.secret')));
    await assert.rejects(readFile(path.join(destination, 'project.json')));
  } finally { await rm(destination, { recursive: true, force: true }); }
  const problems = parseLog("./sections/intro.tex:12: Undefined control sequence.\nLaTeX Warning: Citation `x' on page 1 undefined on input line 9.\nPackage epstopdf Warning: Shell escape feature is not enabled.\nI found no \\citation commands---while reading file output/main.aux");
  assert.deepEqual(problems.map(item => [item.level, item.file, item.line]), [['error', 'sections/intro.tex', 12], ['warning', '', 9], ['warning', '', 0]]);
});

const has = tool => spawnSync(tool, ['--version'], { stdio: 'ignore' }).status === 0;
test('pdflatex builds the article template despite an empty bibliography and keeps the last PDF', { skip: !has('pdflatex') || !has('bibtex') }, async () => {
  const paper = await domain.dispatch('createProject', { name: 'Build me' });
  const result = await domain.dispatch('compile', { projectId: paper.id });
  assert.equal(result.ok, true, result.log);
  assert.equal(result.hasPdf, true);
  assert.equal(result.problems.some(item => item.level === 'error'), false);
  assert.equal((await domain.readPdf(paper.id)).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await domain.dispatch('lastBuild', { projectId: paper.id })).build.ok, true);
});

test('BibTeX resolves citations and TeX errors are reported with file and line', { skip: !has('pdflatex') || !has('bibtex') }, async () => {
  const paper = await domain.dispatch('createProject', { name: 'References', template: 'blank' });
  const original = await domain.dispatch('readFile', { projectId: paper.id, path: 'main.tex' });
  await domain.dispatch('writeFile', { projectId: paper.id, path: 'main.tex', expectedHash: original.hash, content: '\\documentclass{article}\\begin{document}Reference~\\cite{knuth}.\\bibliographystyle{plain}\\bibliography{refs}\\end{document}' });
  await domain.dispatch('writeFile', { projectId: paper.id, path: 'refs.bib', expectedHash: null, content: '@book{knuth, author={Donald Knuth}, title={The Art of Computer Programming}, year={1968}, publisher={Addison-Wesley}}' });
  const good = await domain.dispatch('compile', { projectId: paper.id });
  assert.equal(good.ok, true, good.log);
  assert.match(good.log, /BibTeX/);
  const current = await domain.dispatch('readFile', { projectId: paper.id, path: 'main.tex' });
  await domain.dispatch('writeFile', { projectId: paper.id, path: 'main.tex', expectedHash: current.hash, content: '\\documentclass{article}\n\\begin{document}\n\\undefinedmacro\n\\end{document}\n' });
  const bad = await domain.dispatch('compile', { projectId: paper.id });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.problems.find(item => item.level === 'error'), { level: 'error', file: 'main.tex', line: 3, message: 'Undefined control sequence.' });
  assert.equal((await domain.readPdf(paper.id)).subarray(0, 5).toString(), '%PDF-', 'a failed build keeps the previous PDF');
});

test('log parsing keeps errors on long paths and gives each warning the file it came from', () => {
  const long = 'chapters/a-rather-long-chapter-file-name-about-sparse-attention-mechanisms.tex';
  const problems = parseLog([
    'This is pdfTeX, Version 3.141592653-2.6-1.40.27 (TeX Live 2025) (preloaded format=pdflatex)',
    '(./main.tex',
    '(/usr/local/texlive/2025/texmf-dist/tex/latex/base/article.cls',
    'Document Class: article 2024/06/29 v1.4n Standard LaTeX document class',
    'LaTeX Warning: Something inside the class on input line 77.',
    ') (./output/main.aux)',
    'LaTeX Warning: Reference `fig:one\' on page 1 undefined on input line 3.',
    `(./${long}`,
    'Overfull \\hbox (12.3pt too wide) in paragraph at lines 5--6',
    'LaTeX Warning: Citation `missing\' on page 1 undefined on input line 9.',
    `./${long}:12: Undefined control sequence.`,
    'l.12 \\undefinedcommand (with a stray parenthesis',
    `./${long}:12:  ==> Fatal error occurred, no output PDF file produced!`,
    ')',
    'LaTeX Warning: Label(s) may have changed on input line 20.'
  ].join('\n'));
  assert.deepEqual(problems.map(item => [item.level, item.file, item.line]), [
    ['warning', '', 0],
    ['warning', 'main.tex', 3],
    ['typesetting', long, 5],
    ['warning', long, 9],
    ['error', long, 12],
    ['warning', 'main.tex', 20]
  ]);
});

test('text files too large for the editor are listed as binary and can be deleted', async () => {
  const large = await domain.dispatch('createProject', { name: 'Large', template: 'blank' });
  await domain.dispatch('uploadFile', { projectId: large.id, path: 'data.csv', base64: Buffer.alloc(2 * 1024 * 1024 + 1, 'a').toString('base64') });
  assert.equal((await domain.dispatch('listFiles', { projectId: large.id })).files.find(file => file.path === 'data.csv').kind, 'binary');
  await domain.dispatch('deleteFile', { projectId: large.id, path: 'data.csv', expectedHash: null });
  assert.deepEqual((await domain.dispatch('listFiles', { projectId: large.id })).files.map(file => file.path), ['main.tex']);
});
