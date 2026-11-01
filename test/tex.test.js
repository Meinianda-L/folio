import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { TexEnvironment } from '../tex.js';

const scratch = await mkdtemp(path.join(os.tmpdir(), 'folio-tex-test-'));
test.after(async () => { await rm(scratch, { recursive: true, force: true }); });

test('a chosen TeX folder is validated, remembered and searched first', { skip: process.platform === 'win32' }, async () => {
  const bin = path.join(scratch, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'xelatex'), '#!/bin/sh\necho "XeTeX 3.14 (Folio fake)"\n');
  await chmod(path.join(bin, 'xelatex'), 0o755);
  const env = new TexEnvironment({ settingsFile: path.join(scratch, 'settings.json') });
  await assert.rejects(env.setBin('relative/bin'), /absolute/);
  await assert.rejects(env.setBin(scratch), /No pdflatex/);
  const status = await env.setBin(bin);
  assert.equal(status.texBin, bin);
  assert.equal(status.tools.xelatex.path, path.join(bin, 'xelatex'));
  assert.match(status.tools.xelatex.version, /Folio fake/);
  assert.ok((await env.path()).split(path.delimiter)[0] === bin);
  const fresh = new TexEnvironment({ settingsFile: path.join(scratch, 'settings.json') });
  assert.equal((await fresh.status({ quick: true })).texBin, bin);
  assert.equal((await fresh.setBin('')).texBin, '');
});

test('SyncTeX maps source lines to PDF boxes and back, across included files', { skip: spawnSync('synctex', ['help', 'view']).error && 'synctex not installed' }, async () => {
  const { FolioDomain } = await import('../domain.js');
  const domain = new FolioDomain({ root: path.join(scratch, 'projects') });
  const project = await domain.dispatch('createProject', { name: 'Sync', template: 'blank' });
  const main = await domain.dispatch('readFile', { projectId: project.id, path: 'main.tex' });
  await domain.dispatch('writeFile', { projectId: project.id, path: 'main.tex', expectedHash: main.hash, content: '\\documentclass{article}\n\\begin{document}\nA first paragraph in the main file.\n\n\\input{parts/two}\n\\end{document}\n' });
  await domain.dispatch('writeFile', { projectId: project.id, path: 'parts/two.tex', expectedHash: null, content: 'A second paragraph that lives in an included file.\n' });
  assert.equal((await domain.dispatch('synctex', { projectId: project.id, direction: 'toPdf', file: 'main.tex', line: 3 })).available, false);
  assert.ok((await domain.dispatch('compile', { projectId: project.id })).ok);
  const forward = await domain.dispatch('synctex', { projectId: project.id, direction: 'toPdf', file: 'parts/two.tex', line: 1 });
  assert.ok(forward.available && forward.boxes.length > 0);
  const box = forward.boxes[0];
  const back = await domain.dispatch('synctex', { projectId: project.id, direction: 'toSource', page: box.page, x: box.x + 20, y: box.y + box.height - 1 });
  assert.deepEqual([back.file, back.line], ['parts/two.tex', 1]);
  await assert.rejects(domain.dispatch('synctex', { projectId: project.id, direction: 'toPdf', file: '../escape.tex', line: 1 }));
});
