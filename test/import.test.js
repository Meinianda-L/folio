import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { readZip, planImport, toBase64 } from '../import.js';
import { FolioDomain } from '../domain.js';

const scratch = await mkdtemp(path.join(os.tmpdir(), 'folio-import-test-'));
test.after(async () => { await rm(scratch, { recursive: true, force: true }); });
const text = value => new TextEncoder().encode(value);

test('reads stored and deflated zip entries, unwrapping the archive folder', { skip: spawnSync('zip', ['-v']).status !== 0 && 'zip not installed' }, async () => {
  const source = path.join(scratch, 'Paper');
  await mkdir(path.join(source, 'figures'), { recursive: true });
  await mkdir(path.join(source, '.git'), { recursive: true });
  await writeFile(path.join(source, 'paper.tex'), '% !TEX program = xelatex\n\\documentclass{article}\n\\begin{document}\n' + 'Long text. '.repeat(500) + '\n\\end{document}\n');
  await writeFile(path.join(source, 'intro.tex'), '\\section{Intro}\n');
  await writeFile(path.join(source, 'paper.aux'), 'aux');
  await writeFile(path.join(source, '.git', 'HEAD'), 'ref');
  await writeFile(path.join(source, 'figures', 'plot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  spawnSync('zip', ['-qr', 'paper.zip', 'Paper'], { cwd: scratch });
  spawnSync('zip', ['-q0', 'paper.zip', 'Paper/intro.tex'], { cwd: scratch });
  const entries = await readZip(await readFile(path.join(scratch, 'paper.zip')));
  const plan = planImport(entries);
  assert.deepEqual(plan.files.map(file => file.path).sort(), ['figures/plot.png', 'intro.tex', 'paper.tex']);
  assert.deepEqual(plan.skipped.sort(), ['Paper/.git/HEAD', 'Paper/paper.aux']);
  assert.equal(plan.mainFile, 'paper.tex');
  assert.equal(plan.engine, 'xelatex');
  assert.match(new TextDecoder().decode(plan.files.find(file => file.path === 'paper.tex').data), /Long text\. Long text\./);
  await assert.rejects(readZip(text('not a zip')), /Not a \.zip/);
});

test('picks the main file and engine from the sources', () => {
  const plan = planImport([
    { path: 'chapters/one.tex', data: text('\\chapter{One}') },
    { path: 'thesis.tex', data: text('\\documentclass[UTF8]{ctexbook}\n\\input{chapters/one}') },
    { path: 'old/main.tex', data: text('% \\documentclass{article}\nnot a root') }
  ]);
  assert.equal(plan.mainFile, 'thesis.tex');
  assert.equal(plan.engine, 'xelatex');
  assert.equal(planImport([{ path: 'main.tex', data: text('\\documentclass{article}\n\\usepackage{amsmath}') }]).engine, 'pdflatex');
  assert.equal(planImport([{ path: 'a.tex', data: text('\\documentclass{article}\n\\usepackage{luacode}') }]).engine, 'lualatex');
  assert.throws(() => planImport([{ path: '.DS_Store', data: text('x') }]), /No project files/);
});

test('an imported plan uploads into an empty project', async () => {
  const domain = new FolioDomain({ root: path.join(scratch, 'projects') });
  const plan = planImport([{ path: 'src/main.tex', data: text('\\documentclass{article}\\begin{document}Hi\\end{document}') }, { path: 'src/refs.bib', data: text('@misc{a}') }]);
  const project = await domain.dispatch('createProject', { name: 'Imported', template: 'empty' });
  assert.deepEqual((await domain.dispatch('listFiles', { projectId: project.id })).files, []);
  for (const file of plan.files) await domain.dispatch('uploadFile', { projectId: project.id, path: file.path, base64: toBase64(file.data), overwrite: true });
  const updated = await domain.dispatch('updateProject', { projectId: project.id, mainFile: plan.mainFile, engine: plan.engine });
  assert.equal(updated.mainFile, 'main.tex');
  assert.equal((await domain.dispatch('readFile', { projectId: project.id, path: 'main.tex' })).content, '\\documentclass{article}\\begin{document}Hi\\end{document}');
});
