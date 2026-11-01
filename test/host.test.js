import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, RPC_PATH, PDF_PATH } from '../index.js';

// A minimal Host stand-in: captures the fetch routes, the tool and the pre-step waterfall listener.
function fixture(root) {
  const routes = new Map(), disposers = [];
  let tool, preStep;
  const ctx = {
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } },
    tools: { register(value) { tool = value; } },
    on(name, listener) { if (name === 'agent/pre-step') preStep = listener; },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); }
  };
  apply(ctx, { projectRoot: root });
  let guard = null, restrictedTo = null;
  const agent = id => ({ id, ctx: { effect: fn => fn(), tools: { restrict({ allow }) { restrictedTo = allow; return () => { restrictedTo = null; }; }, guard(fn) { guard = fn; return () => { guard = null; }; } } } });
  async function rpc(action, args = {}) {
    const response = await routes.get(RPC_PATH).fetch(new Request(`http://host${RPC_PATH}`, { method: 'POST', body: JSON.stringify({ action, args }) }));
    const body = await response.json();
    if (!body.ok) throw Object.assign(new Error(body.error), { code: body.code, status: response.status });
    return body.value;
  }
  const step = async (target, number = 1) => preStep({ agent: target, step: number, signal: new AbortController().signal }, async () => ({ kind: 'continue', messages: [{ role: 'user', marker: 'original' }] }));
  return { routes, rpc, step, agent, get tool() { return tool; }, get guard() { return guard; }, get restrictedTo() { return restrictedTo; }, dispose: () => disposers.forEach(fn => fn()) };
}

test('owner routes serve projects, files and the last PDF', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-host-'));
  try {
    const host = fixture(root);
    assert.deepEqual([...host.routes.keys()].sort(), ['/api/folio', '/api/folio/pdf', '/api/folio/raw']);
    const project = await host.rpc('createProject', { name: 'Harness paper', template: 'blank' });
    assert.equal((await host.rpc('listProjects')).projects[0].id, project.id);
    await assert.rejects(host.rpc('readFile', { projectId: project.id, path: '../x' }));
    await assert.rejects(host.rpc('propose_patch', {}), /Unknown Folio operation/);
    const missing = await host.routes.get(PDF_PATH).fetch(new Request(`http://host${PDF_PATH}?projectId=${project.id}`));
    assert.equal(missing.status, 404);
    host.dispose();
    assert.equal(host.routes.size, 0, 'routes are withdrawn with the plugin');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('bound writing sessions get hidden workspace context, a restricted toolset and reviewed proposals', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-host-'));
  try {
    const host = fixture(root);
    const project = await host.rpc('createProject', { name: 'Harness paper', template: 'blank' });
    const writing = host.agent('writing-session'), unrelated = host.agent('other-session');
    await host.rpc('updateProject', { projectId: project.id, sessionId: writing.id });
    await host.rpc('focus', { projectId: project.id, sessionId: writing.id, path: 'main.tex', line: 2, selection: '\\begin{document}', selectionFrom: 2, selectionTo: 2 });

    const plain = await host.step(unrelated);
    assert.equal(plain.messages.length, 1, 'other sessions are untouched');
    assert.equal(host.restrictedTo, null);

    const decision = await host.step(writing);
    const context = decision.messages.at(-1);
    assert.equal(context.source.kind, 'folio-context', 'non-user source keeps the context out of the visible chat');
    assert.match(context.content[0].text, /Project: "Harness paper"/);
    assert.match(context.content[0].text, /Selected text \(lines 2–2\)/);
    assert.equal((await host.step(writing, 2)).messages.length, 1, 'context is added once per turn');
    assert.deepEqual(host.restrictedTo, ['folio_project']);
    assert.equal(host.guard({ name: 'folio_project' }), undefined);
    assert.match(host.guard({ name: 'bash' }), /folio_project/);

    const call = async (args, target = writing) => JSON.parse(await host.tool.execute(args, { agent: target }));
    assert.match((await call({ action: 'readFile', path: 'main.tex' }, unrelated)).error, /not a Folio writing session/);
    const file = await call({ action: 'readFile', path: 'main.tex' });
    const proposal = await call({ action: 'propose_patch', path: 'main.tex', expectedHash: file.hash, edits: [{ find: '\\begin{document}\n', replace: '\\begin{document}\nHello.\n' }], summary: 'Greet' });
    assert.equal(proposal.status, 'pending');
    assert.equal((await host.rpc('readFile', { projectId: project.id, path: 'main.tex' })).content, file.content, 'the model cannot apply');
    await assert.rejects(call({ action: 'writeFile', path: 'main.tex', content: 'x' }), e => e.code === 'INVALID_ARGS', 'the tool schema has no write action');
    const [pending] = (await host.rpc('listProposals', { projectId: project.id })).proposals;
    assert.equal(pending.summary, 'Greet');
    await host.rpc('applyProposal', { projectId: project.id, id: pending.id });
    assert.match((await host.rpc('readFile', { projectId: project.id, path: 'main.tex' })).content, /Hello\./);

    await host.rpc('updateProject', { projectId: project.id, sessionId: 'fresh-chat' });
    assert.equal(host.restrictedTo, null, 'a replaced chat loses the writing restriction');
    assert.match((await call({ action: 'readFile', path: 'main.tex' })).error, /not a Folio writing session/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
