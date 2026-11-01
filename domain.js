import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { compileProject, parseLog, ENGINES } from './compiler.js';

const MAX_FILE = 2 * 1024 * 1024;
const MAX_UPLOAD = 10 * 1024 * 1024;
const MAX_PROJECT = 40 * 1024 * 1024;
const MAX_FILES = 500;
const TEXT_EXTENSIONS = new Set(['tex', 'bib', 'sty', 'cls', 'bst', 'bbx', 'cbx', 'def', 'cfg', 'clo', 'dtx', 'ins', 'txt', 'md', 'csv', 'tsv', 'dat', 'json', 'yaml', 'yml', 'lua', 'py', 'r', 'm', 'gp', 'tikz', 'pgf', 'latexmkrc']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'pdf', 'eps']);
export const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', pdf: 'application/pdf', eps: 'application/postscript' };

export const TEMPLATES = {
  article: {
    engine: 'pdflatex',
    files: {
      'main.tex': '\\documentclass[11pt]{article}\n\\usepackage[margin=1in]{geometry}\n\\usepackage{amsmath,amssymb}\n\\usepackage{graphicx}\n\\usepackage[hidelinks]{hyperref}\n\n\\title{Untitled Paper}\n\\author{Your Name}\n\\date{\\today}\n\n\\begin{document}\n\\maketitle\n\n\\begin{abstract}\nWrite your abstract here.\n\\end{abstract}\n\n\\section{Introduction}\nStart writing here. Inline math such as $E = mc^2$ and display math:\n\\begin{equation}\n  \\int_0^1 x^2 \\, dx = \\frac{1}{3}.\n\\end{equation}\n\n\\bibliographystyle{plain}\n\\bibliography{references}\n\\end{document}\n',
      'references.bib': '@article{example2024,\n  title   = {An Example Reference},\n  author  = {Doe, Jane},\n  journal = {Journal of Examples},\n  year    = {2024}\n}\n'
    }
  },
  ctex: {
    engine: 'xelatex',
    files: {
      'main.tex': '\\documentclass[UTF8,a4paper,12pt]{ctexart}\n\\usepackage[margin=2.5cm]{geometry}\n\\usepackage{amsmath,amssymb}\n\\usepackage{graphicx}\n\\usepackage[hidelinks]{hyperref}\n\n\\title{论文标题}\n\\author{作者}\n\\date{\\today}\n\n\\begin{document}\n\\maketitle\n\n\\begin{abstract}\n在这里写摘要。\n\\end{abstract}\n\n\\section{引言}\n从这里开始写作。行内公式 $a^2 + b^2 = c^2$，以及行间公式：\n\\begin{equation}\n  \\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}.\n\\end{equation}\n\n\\end{document}\n'
    }
  },
  blank: {
    engine: 'pdflatex',
    files: { 'main.tex': '\\documentclass{article}\n\\begin{document}\n\n\\end{document}\n' }
  },
  // Imports start empty; the client uploads the files, then sets the main file and engine.
  empty: { engine: 'pdflatex', files: {} }
};

export const contentHash = content => crypto.createHash('sha256').update(content).digest('hex');
export function fail(message, code = 'INVALID_ARGUMENT') { return Object.assign(new Error(message), { code }); }
const extensionOf = file => (path.posix.extname(file).slice(1) || path.posix.basename(file)).toLowerCase();
export function kindOf(file) {
  const extension = extensionOf(file);
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  return 'binary';
}
function validatePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\\') || value.includes('\0') || path.isAbsolute(value) || value.split('/').some(p => !p || p.startsWith('.') || p === 'project.json' || p === 'node_modules' || p === 'output')) throw fail('Invalid or private file path');
  return value;
}
async function rejectSymlinks(root, target) {
  let current = root;
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw fail('Project root must be a real directory');
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw fail('Symlink paths are not allowed'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
async function atomicWrite(target, content) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
  try { await fs.writeFile(temporary, content, { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, target); }
  finally { await fs.rm(temporary, { force: true }); }
}
async function removeEmptyParents(root, file) {
  for (let directory = path.dirname(file); directory !== root && directory.startsWith(root); directory = path.dirname(directory)) {
    try { await fs.rmdir(directory); } catch { return; }
  }
}

export class FolioDomain {
  constructor(options = {}) {
    const root = typeof options === 'string' ? options : options.root;
    if (typeof root !== 'string' || !root) throw fail('A project root is required');
    this.root = path.resolve(root);
    this.tail = Promise.resolve();
    this.tex = options.tex || null;
  }
  async initialize() { await fs.mkdir(this.root, { recursive: true, mode: 0o700 }); await rejectSymlinks(this.root, this.root); }
  async projectRoot(projectId) {
    if (typeof projectId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(projectId)) throw fail('Invalid project ID');
    const root = path.join(this.root, projectId);
    await rejectSymlinks(this.root, root);
    const stat = await fs.stat(root).catch(() => null);
    if (!stat?.isDirectory()) throw fail('Project not found', 'NOT_FOUND');
    await rejectSymlinks(root, path.join(root, 'project.json'));
    const metadata = await fs.lstat(path.join(root, 'project.json')).catch(() => null);
    if (!metadata?.isFile() || metadata.size > 16 * 1024) throw fail('Invalid project metadata');
    return root;
  }
  async meta(root) { return JSON.parse(await fs.readFile(path.join(root, 'project.json'), 'utf8')); }
  async saveMeta(root, patch) {
    const next = { ...(await this.meta(root)), ...patch, updatedAt: new Date().toISOString() };
    await atomicWrite(path.join(root, 'project.json'), JSON.stringify(next));
    return next;
  }
  async filePath(root, file) { validatePath(file); const absolute = path.join(root, file); await rejectSymlinks(root, absolute); return absolute; }
  async scan(root) {
    const files = [];
    let bytes = 0;
    async function walk(relative = '') {
      const entries = (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name.startsWith('.') || ['project.json', 'node_modules', 'output'].includes(entry.name)) continue;
        const name = path.posix.join(relative, entry.name);
        const stat = await fs.lstat(path.join(root, name));
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) await walk(name);
        else if (stat.isFile()) {
          bytes += stat.size;
          if (files.length >= MAX_FILES || bytes > MAX_PROJECT) throw fail('Project file or size limit exceeded', 'LIMIT_EXCEEDED');
          files.push({ path: name, size: stat.size, kind: kindOf(name) });
        }
      }
    }
    await walk();
    return { files, bytes };
  }
  async ensureRoom(root, previousBytes, nextBytes, creating) {
    const { files, bytes } = await this.scan(root);
    if ((creating && files.length >= MAX_FILES) || bytes - previousBytes + nextBytes > MAX_PROJECT) throw fail('Project size limit exceeded', 'LIMIT_EXCEEDED');
  }
  summary(id, meta, root) {
    return { id, name: String(meta.name || id), createdAt: meta.createdAt, updatedAt: meta.updatedAt || meta.createdAt, mainFile: meta.mainFile || 'main.tex', engine: ENGINES.includes(meta.engine) ? meta.engine : 'pdflatex', sessionId: typeof meta.sessionId === 'string' ? meta.sessionId : '', directory: root };
  }
  dispatch(action, args = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return Promise.reject(fail('Arguments must be an object'));
    // Serialize mutations and snapshot creation to make hash checks meaningful across callers.
    const result = this.tail.then(async () => { await this.initialize(); return this.execute(action, args); });
    this.tail = result.catch(() => {});
    return result;
  }
  async execute(action, args) {
    if (action === 'listProjects') {
      const projects = [];
      for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        try {
          const root = await this.projectRoot(entry.name);
          projects.push(this.summary(entry.name, await this.meta(root), root));
        } catch { /* Ignore unrelated directories and malformed project metadata. */ }
      }
      return { projects: projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) };
    }
    if (action === 'createProject') {
      if (typeof args.name !== 'string' || !args.name.trim() || args.name.length > 200) throw fail('Project name must contain 1–200 characters');
      const template = TEMPLATES[args.template] || TEMPLATES.article;
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const meta = { id, name: args.name.trim(), createdAt: now, updatedAt: now, mainFile: 'main.tex', engine: template.engine };
      const root = path.join(this.root, id);
      await fs.mkdir(root, { mode: 0o700 });
      await atomicWrite(path.join(root, 'project.json'), JSON.stringify(meta));
      for (const [file, content] of Object.entries(template.files)) await atomicWrite(path.join(root, file), content);
      return this.summary(id, meta, root);
    }
    const root = await this.projectRoot(args.projectId);
    if (action === 'getProject') return this.summary(args.projectId, await this.meta(root), root);
    if (action === 'updateProject') {
      const patch = {};
      if (args.name !== undefined) {
        if (typeof args.name !== 'string' || !args.name.trim() || args.name.length > 200) throw fail('Project name must contain 1–200 characters');
        patch.name = args.name.trim();
      }
      if (args.engine !== undefined) { if (!ENGINES.includes(args.engine)) throw fail('Unsupported TeX engine'); patch.engine = args.engine; }
      if (args.mainFile !== undefined) { validatePath(args.mainFile); if (!args.mainFile.endsWith('.tex')) throw fail('Main file must be a .tex file'); patch.mainFile = args.mainFile; }
      if (args.sessionId !== undefined) { if (typeof args.sessionId !== 'string' || args.sessionId.length > 200) throw fail('Invalid session'); patch.sessionId = args.sessionId; }
      return this.summary(args.projectId, await this.saveMeta(root, patch), root);
    }
    if (action === 'deleteProject') {
      // Projects are moved aside rather than erased, so a mistaken click is recoverable from disk.
      const trash = path.join(this.root, '.trash');
      await fs.mkdir(trash, { recursive: true, mode: 0o700 });
      await fs.rename(root, path.join(trash, `${args.projectId}-${Date.now()}`));
      return { ok: true };
    }
    if (action === 'listFiles') return { files: (await this.scan(root)).files };
    if (action === 'compile') {
      const meta = await this.meta(root);
      const mainFile = args.mainFile || meta.mainFile || 'main.tex';
      const engine = args.engine || meta.engine || 'pdflatex';
      await this.filePath(root, mainFile);
      if (!ENGINES.includes(engine) || !mainFile.endsWith('.tex')) throw fail('Invalid engine or main TeX file');
      const started = Date.now();
      const result = await compileProject({ root, mainFile, engine, path: await this.tex?.path() });
      const build = { ok: result.ok, log: result.log, problems: parseLog(result.diagnostics ?? result.log), version: result.version, engine, mainFile, durationMs: Date.now() - started, builtAt: new Date().toISOString(), hasPdf: Boolean(result.pdf) };
      const folder = path.join(root, '.folio');
      await rejectSymlinks(root, folder);
      if (result.pdf) await atomicWrite(path.join(folder, 'output.pdf'), result.pdf);
      const { log: _log, ...stored } = build;
      await atomicWrite(path.join(folder, 'build.json'), JSON.stringify({ ...stored, hasPdf: Boolean(result.pdf) || Boolean(await this.lastPdf(root)) }));
      return build;
    }
    if (action === 'lastBuild') {
      const folder = path.join(root, '.folio');
      await rejectSymlinks(root, folder);
      const build = await fs.readFile(path.join(folder, 'build.json'), 'utf8').then(JSON.parse).catch(() => null);
      return { build: build && { ...build, hasPdf: Boolean(await this.lastPdf(root)) } };
    }
    if (action === 'renameFile') {
      const from = await this.filePath(root, args.from);
      const to = await this.filePath(root, args.to);
      const stat = await fs.lstat(from).catch(() => null);
      if (!stat?.isFile()) throw fail('File not found', 'NOT_FOUND');
      if (await fs.lstat(to).catch(() => null)) throw fail('A file with that name already exists', 'CONFLICT');
      await fs.mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
      await fs.rename(from, to);
      await removeEmptyParents(root, from);
      const meta = await this.meta(root);
      await this.saveMeta(root, meta.mainFile === args.from && args.to.endsWith('.tex') ? { mainFile: args.to } : {});
      return { ok: true, path: args.to };
    }
    if (action === 'uploadFile') {
      const target = await this.filePath(root, args.path);
      if (typeof args.base64 !== 'string') throw fail('Upload content is required');
      const bytes = Buffer.from(args.base64, 'base64');
      if (bytes.length > MAX_UPLOAD) throw fail('Uploads are limited to 10 MiB', 'LIMIT_EXCEEDED');
      const existing = await fs.lstat(target).catch(() => null);
      if (existing && !args.overwrite) throw fail('A file with that name already exists', 'CONFLICT');
      if (existing && !existing.isFile()) throw fail('Not a regular file');
      await this.ensureRoom(root, existing?.size || 0, bytes.length, !existing);
      await atomicWrite(target, bytes);
      await this.saveMeta(root, {});
      return { ok: true, path: args.path, size: bytes.length, kind: kindOf(args.path) };
    }
    const target = await this.filePath(root, args.path);
    let stat = null;
    try { stat = await fs.lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat && !stat.isFile()) throw fail('Not a regular file');
    if (action === 'readRaw') {
      if (!stat) throw fail('File not found', 'NOT_FOUND');
      if (stat.size > MAX_UPLOAD) throw fail('File exceeds 10 MiB', 'LIMIT_EXCEEDED');
      return { bytes: await fs.readFile(target), type: MIME[extensionOf(args.path)] || 'application/octet-stream' };
    }
    if (action === 'deleteFile' && stat && kindOf(args.path) !== 'text') {
      await fs.unlink(target);
      await removeEmptyParents(root, target);
      await this.saveMeta(root, {});
      return { ok: true };
    }
    let content = '';
    if (stat) {
      if (stat.size > MAX_FILE) throw fail('File is not text-readable or exceeds 2 MiB', 'LIMIT_EXCEEDED');
      content = await fs.readFile(target, 'utf8');
    }
    const hash = stat ? contentHash(content) : null;
    if (action === 'readFile') {
      if (!stat) throw fail('File not found', 'NOT_FOUND');
      if (kindOf(args.path) !== 'text') throw fail('Binary files cannot be opened as text');
      return { path: args.path, content, hash };
    }
    if (!['writeFile', 'deleteFile'].includes(action)) throw fail('Unknown action');
    if (!Object.hasOwn(args, 'expectedHash') || args.expectedHash !== hash) throw fail('File changed since it was read', 'CONFLICT');
    if (action === 'deleteFile') {
      if (!stat) throw fail('File not found', 'NOT_FOUND');
      await fs.unlink(target);
      await removeEmptyParents(root, target);
    } else {
      if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > MAX_FILE) throw fail('Text content exceeds 2 MiB', 'LIMIT_EXCEEDED');
      if (kindOf(args.path) !== 'text') throw fail('Only text files can be edited');
      await this.ensureRoom(root, Buffer.byteLength(content), Buffer.byteLength(args.content), !stat);
      await atomicWrite(target, args.content);
    }
    await this.saveMeta(root, {});
    return action === 'deleteFile' ? { ok: true } : { ok: true, path: args.path, hash: contentHash(args.content) };
  }
  async lastPdf(root) {
    const file = path.join(root, '.folio', 'output.pdf');
    const stat = await fs.lstat(file).catch(() => null);
    return stat?.isFile() && !stat.isSymbolicLink() ? file : null;
  }
  async readPdf(projectId) {
    return this.dispatch('lastBuild', { projectId }).then(async () => {
      const root = await this.projectRoot(projectId);
      const file = await this.lastPdf(root);
      return file ? fs.readFile(file) : null;
    });
  }
}
export default FolioDomain;
