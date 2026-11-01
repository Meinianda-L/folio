import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
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
