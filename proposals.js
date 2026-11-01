import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';

// Apply exact find/replace pairs; each `find` must occur once so the edit is unambiguous.
export function applyEdits(source, edits) {
  if (!Array.isArray(edits) || !edits.length || edits.length > 50) throw new Error('Provide 1–50 edits');
  let result = source;
  for (const edit of edits) {
    if (!edit || typeof edit.find !== 'string' || typeof edit.replace !== 'string' || !edit.find) throw new Error('Each edit needs non-empty find and a replace string');
    const first = result.indexOf(edit.find);
    if (first < 0) throw new Error(`Edit target not found: ${edit.find.slice(0, 80)}`);
    if (result.indexOf(edit.find, first + 1) >= 0) throw new Error(`Edit target is ambiguous; include more surrounding text: ${edit.find.slice(0, 80)}`);
    result = result.slice(0, first) + edit.replace + result.slice(first + edit.find.length);
  }
  return result;
}

export class ProposalStore {
  constructor(domain) { this.domain = domain; this.tail = Promise.resolve(); }
  async location(projectId) {
    const root = await this.domain.projectRoot(projectId);
    const dir = path.join(root, '.folio');
    const stat = await fs.lstat(dir).catch(() => null);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('Invalid proposal storage');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'proposals.json');
    const fileStat = await fs.lstat(file).catch(() => null);
    if (fileStat?.isSymbolicLink() || (fileStat && fileStat.size > 8 * 1024 * 1024)) throw new Error('Invalid proposal data');
    return file;
  }
  async read(projectId) {
    const file = await this.location(projectId);
    const values = await fs.readFile(file, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    if (!Array.isArray(values)) throw new Error('Invalid proposal list');
    return values;
  }
  async pending(projectId) { return (await this.read(projectId)).filter(item => item.status === 'pending'); }
  async save(projectId, values) {
    const file = await this.location(projectId), tmp = `${file}.${crypto.randomUUID()}.tmp`;
    const encoded = JSON.stringify(values);
    if (Buffer.byteLength(encoded) > 8 * 1024 * 1024) throw new Error('Proposal storage limit reached; review or discard large proposals');
    try {
      await fs.writeFile(tmp, encoded, { mode: 0o600, flag: 'wx' });
      await fs.rename(tmp, file);
    } finally { await fs.rm(tmp, { force: true }); }
  }
  serialized(callback) { const result = this.tail.then(callback); this.tail = result.catch(() => {}); return result; }
  propose(projectId, filePath, { content, edits, expectedHash, summary } = {}) {
    return this.serialized(async () => {
      let current = null;
      try { current = await this.domain.dispatch('readFile', { projectId, path: filePath }); }
      catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
      if (current && (typeof expectedHash !== 'string' || expectedHash !== current.hash)) throw new Error('File changed or missing source hash; call readFile again before proposing');
      if (!current && edits) throw new Error('Use content to propose a new file');
      const next = edits ? applyEdits(current.content, edits) : content;
      if (typeof next !== 'string' || Buffer.byteLength(next) > 2 * 1024 * 1024) throw new Error('Proposal exceeds text limit');
      if (current && next === current.content) throw new Error('The proposal does not change the file');
      const values = await this.read(projectId);
      // A newer suggestion for the same file supersedes the older one instead of stacking conflicts.
      for (const item of values) if (item.status === 'pending' && item.path === filePath) item.status = 'superseded';
      if (values.filter(item => item.status === 'pending').length >= 8) throw new Error('Review existing proposals first');
      const proposal = { id: crypto.randomUUID(), path: filePath, original: current?.content ?? '', content: next, expectedHash: current?.hash ?? null, summary: typeof summary === 'string' ? summary.slice(0, 300) : '', status: 'pending', createdAt: new Date().toISOString() };
      values.push(proposal);
      await this.save(projectId, values.filter(item => item.status === 'pending' || item === proposal).concat(values.filter(item => item.status !== 'pending' && item !== proposal).slice(-10)));
      return { ok: true, id: proposal.id, path: filePath, status: 'pending', note: 'Shown to the user for review. It is NOT applied until the user clicks Apply.' };
    });
  }
  settle(projectId, id, apply) {
    return this.serialized(async () => {
      const values = await this.read(projectId);
      const proposal = values.find(item => item.id === id && item.status === 'pending');
      if (!proposal) throw new Error('Pending proposal not found');
      if (apply) await this.domain.dispatch('writeFile', { projectId, path: proposal.path, content: proposal.content, expectedHash: proposal.expectedHash });
      proposal.status = apply ? 'applied' : 'rejected';
      await this.save(projectId, values);
      return { ok: true, path: proposal.path, status: proposal.status };
    });
  }
}
