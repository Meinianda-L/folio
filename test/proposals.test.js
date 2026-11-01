import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FolioDomain } from '../domain.js';
import { ProposalStore, applyEdits } from '../proposals.js';

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-proposals-'));
  const domain = new FolioDomain({ root }), store = new ProposalStore(domain);
  const project = await domain.dispatch('createProject', { name: 'Research', template: 'blank' });
  return { root, domain, store, project, read: () => domain.dispatch('readFile', { projectId: project.id, path: 'main.tex' }) };
}

test('proposals require explicit acceptance and reject changed sources', async () => {
  const { root, domain, store, project, read } = await setup();
  try {
    const before = await read();
    await assert.rejects(store.propose(project.id, 'main.tex', { content: 'unversioned paper' }), /source hash/);
    const proposal = await store.propose(project.id, 'main.tex', { content: 'new paper', expectedHash: before.hash, summary: 'Rewrite' });
    assert.equal((await read()).content, before.content, 'proposing never writes');
    await domain.dispatch('writeFile', { projectId: project.id, path: 'main.tex', content: 'manual edit', expectedHash: before.hash });
    await assert.rejects(store.settle(project.id, proposal.id, true), e => e.code === 'CONFLICT');
    assert.equal((await read()).content, 'manual edit');
    await store.settle(project.id, proposal.id, false);
    const next = await store.propose(project.id, 'main.tex', { content: 'accepted paper', expectedHash: (await read()).hash });
    await store.settle(project.id, next.id, true);
    assert.equal((await read()).content, 'accepted paper');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('find/replace edits apply exactly once and newer proposals supersede older ones for the same file', async () => {
  const { root, store, project, read } = await setup();
  try {
    const current = await read();
    await assert.rejects(store.propose(project.id, 'main.tex', { edits: [{ find: 'missing', replace: 'x' }], expectedHash: current.hash }), /not found/);
    await assert.rejects(store.propose(project.id, 'main.tex', { edits: [{ find: 'document', replace: 'x' }], expectedHash: current.hash }), /ambiguous/);
    const first = await store.propose(project.id, 'main.tex', { edits: [{ find: '\\documentclass{article}', replace: '\\documentclass[12pt]{article}' }], expectedHash: current.hash });
    const second = await store.propose(project.id, 'main.tex', { edits: [{ find: '\\begin{document}\n', replace: '\\begin{document}\nHello.\n' }], expectedHash: current.hash });
    const pending = await store.pending(project.id);
    assert.deepEqual(pending.map(item => item.id), [second.id]);
    assert.notEqual(first.id, second.id);
    assert.match(pending[0].content, /Hello\./);
    const created = await store.propose(project.id, 'sections/new.tex', { content: '\\section{New}' });
    await store.settle(project.id, created.id, true);
    assert.equal((await store.domain.dispatch('readFile', { projectId: project.id, path: 'sections/new.tex' })).content, '\\section{New}');
    assert.equal(applyEdits('a b c', [{ find: 'b', replace: 'B' }, { find: 'c', replace: 'C' }]), 'a B C');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('oversized proposal stores leave the previous store readable', async () => {
  const { root, store, project } = await setup();
  try {
    await store.save(project.id, []);
    await assert.rejects(store.save(project.id, [{ content: 'x'.repeat(8 * 1024 * 1024) }]), /storage limit/);
    assert.deepEqual(await store.read(project.id), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

