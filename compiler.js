import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const ENGINES = ['pdflatex', 'xelatex', 'lualatex', 'tectonic'];
const MAX_SOURCE = 20 * 1024 * 1024;
const MAX_PDF = 20 * 1024 * 1024;
const MAX_LOG = 64 * 1024;
// Biber unpacks itself on first run; a persistent folder keeps later runs at ~3 s instead of ~25 s.
export const BIBER_CACHE = path.join(os.tmpdir(), 'dsh-folio-biber');
let tail = Promise.resolve();
let waiting = 0;
export function buildCommand(engine, mainFile) {
  if (!ENGINES.includes(engine)) throw new Error('Unsupported TeX engine');
  if (typeof mainFile !== 'string' || !mainFile.endsWith('.tex') || path.isAbsolute(mainFile) || mainFile.includes('\\') || mainFile.split('/').some(part => !part || part.startsWith('.'))) throw new Error('Invalid main TeX path');
  mainFile = `./${mainFile}`;
  return engine === 'tectonic'
    ? { command: 'tectonic', args: ['--only-cached', '--untrusted', '--synctex', '--outdir', 'output', mainFile] }
    : { command: engine, args: ['-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-synctex=1', '-output-directory=output', mainFile] };
}
export async function snapshotSources(root, target) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let count = 0;
  async function walk(rel = '') {
    const entries = (await fs.readdir(path.join(root, rel), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'project.json' || entry.name === 'node_modules' || entry.name === 'output') continue;
      const name = path.posix.join(rel, entry.name);
      const source = path.join(root, name);
      const stat = await fs.lstat(source);
      if (stat.isSymbolicLink()) throw new Error('Symlink source is not allowed');
      if (stat.isDirectory()) { await fs.mkdir(path.join(target, name), { recursive: true }); await walk(name); }
      else if (stat.isFile()) {
        if (++count > 500 || (bytes += stat.size) > MAX_SOURCE) throw new Error('Project snapshot limit exceeded');
        const content = await fs.readFile(source);
        hash.update(name).update('\0').update(content).update('\0');
        await fs.mkdir(path.dirname(path.join(target, name)), { recursive: true });
        await fs.writeFile(path.join(target, name), content);
      }
    }
  }
  await walk();
  return hash.digest('hex');
}
function run(command, args, cwd, timeoutMs, searchPath) {
  return new Promise(resolve => {
    let log = '';
    let timeout = false;
    let settled = false;
    // Do not pass provider keys, shell configuration, or the full host environment to TeX.
    // LuaTeX's font loader reads support files by absolute path, which paranoid mode refuses;
    // restricted mode still refuses dotfiles.
    const env = { PATH: searchPath || process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: cwd, TMPDIR: cwd, PAR_GLOBAL_TMPDIR: BIBER_CACHE, openin_any: command === 'lualatex' ? 'r' : 'p', openout_any: 'p', shell_escape: 'f', TEXMFOUTPUT: path.join(cwd, 'output'), BIBINPUTS: `${cwd}${path.delimiter}${path.join(cwd, 'output')}${path.delimiter}`, BSTINPUTS: `${cwd}${path.delimiter}`, XDG_CACHE_HOME: process.env.DSH_FOLIO_TEX_CACHE || process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache') };
    const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const append = value => { if (log.length < MAX_LOG) log += value.toString().slice(0, MAX_LOG - log.length); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timeout = true;
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    const finish = (ok, extra = '') => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ok, log: `${log}${extra}`.slice(0, MAX_LOG) }); };
    child.on('error', error => finish(false, error.code === 'ENOENT' ? `TeX engine not installed: ${command}` : 'TeX process failed'));
    child.on('close', code => finish(code === 0 && !timeout, timeout ? '\nCompilation timed out' : ''));
  });
}
// `path` is the PATH to find TeX on, from the TeX environment; it defaults to Harness's own.
export function compileProject({ root, mainFile = 'main.tex', engine = 'pdflatex', timeoutMs = 60_000, path: searchPath }) {
  if (waiting >= 4) return Promise.resolve({ ok: false, pdf: null, log: 'Compile queue is full', version: '' });
  waiting += 1;
  const operation = tail.then(async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-folio-'));
    let version = '';
    try {
      await fs.chmod(temp, 0o700);
      await fs.mkdir(BIBER_CACHE, { recursive: true, mode: 0o700 });
      version = await snapshotSources(root, temp);
      await fs.mkdir(path.join(temp, 'output'), { recursive: true });
      const { command, args } = buildCommand(engine, mainFile);
      const deadline = Date.now() + Math.min(60_000, Math.max(1, timeoutMs));
      let log = '';
      let bibliographyLog = '';
      // `diagnostics` holds only the latest TeX pass (plus the bibliography tool), so warnings
      // already resolved by a rerun do not resurface; `log` keeps every pass for the raw view.
      async function pass(executable, parameters) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { ok: false, log: `${log}\nCompilation timed out`, diagnostics: 'Compilation timed out' };
        const result = await run(executable, parameters, temp, remaining, searchPath);
        log = `${log}${result.log}\n`.slice(0, MAX_LOG);
        if (executable === 'bibtex' || executable === 'biber') bibliographyLog = result.log;
        return { ok: result.ok, log, diagnostics: `${bibliographyLog}\n${result.log}` };
      }
      let result = await pass(command, args);
      if (!result.ok) return { ...result, pdf: null, version };
      if (engine !== 'tectonic') {
        const job = path.basename(mainFile, '.tex');
        const bcf = path.join(temp, 'output', `${job}.bcf`);
        let bibliography = false;
        try { bibliography = (await fs.stat(bcf)).isFile(); } catch {}
        // A bibliography tool complaint (e.g. no \\cite yet) is reported in the log, not a failed build.
        if (bibliography) await pass('biber', ['--input-directory', 'output', '--output-directory', 'output', job]);
        else {
          let aux = '';
          try { aux = await fs.readFile(path.join(temp, 'output', `${job}.aux`), 'utf8'); } catch {}
          if (aux.includes('\\bibdata{')) await pass('bibtex', [`output/${job}`]);
        }
        // Resolve bibliography, citations, cross-references and table-of-contents page numbers.
        for (let iteration = 0; iteration < 2; iteration += 1) {
          result = await pass(command, args);
          if (!result.ok) return { ...result, pdf: null, version };
        }
      }
      const pdfPath = path.join(temp, 'output', `${path.basename(mainFile, '.tex')}.pdf`);
      const stat = await fs.lstat(pdfPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PDF) throw new Error('PDF output size or type limit');
      // SyncTeX maps PDF positions to source lines; it records paths inside this temporary snapshot.
      const synctex = await fs.readFile(path.join(temp, 'output', `${path.basename(mainFile, '.tex')}.synctex.gz`)).catch(() => null);
      return { ok: true, pdf: await fs.readFile(pdfPath), synctex, synctexRoot: synctex ? await fs.realpath(temp) : '', log: result.log, diagnostics: result.diagnostics, version };
    } catch (error) { return { ok: false, pdf: null, log: error.message, version }; }
    finally { await fs.rm(temp, { recursive: true, force: true }); }
  });
  tail = operation.catch(() => {}).finally(() => { waiting -= 1; });
  return operation;
}

// Turn a -file-line-error TeX log into jumpable problems; the raw log stays available.
export function parseLog(log = '') {
  const problems = [];
  const seen = new Set();
  const push = item => { const key = `${item.level}|${item.file}|${item.line}|${item.message}`; if (!seen.has(key) && problems.length < 100) { seen.add(key); problems.push(item); } };
  const lines = log.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const error = lines[i].match(/^(?:\.\/)?([^:\s][^:]*\.(?:tex|sty|cls|bib|bbl)):(\d+): (.+)$/);
    if (error) { push({ level: 'error', file: error[1], line: Number(error[2]), message: error[3].trim() }); continue; }
    const missing = lines[i].match(/^TeX engine not installed: (.+)$/);
    if (missing) { push({ level: 'error', file: '', line: 0, message: `${missing[1]} was not found. Open TeX environment to locate your TeX installation.`, setup: true }); continue; }
    if (/^! /.test(lines[i])) { push({ level: 'error', file: '', line: 0, message: lines[i].slice(2).trim() }); continue; }
    const warning = lines[i].match(/^(?:LaTeX|Package [\w-]+) Warning: (.+)$/);
    if (warning) {
      let text = warning[1];
      if (/^Shell escape feature is not enabled/.test(text)) continue; // expected: TeX runs without shell escape
      while (!/\.$/.test(text) && i + 1 < lines.length && lines[i + 1].trim() && !/Warning:/.test(lines[i + 1])) text += ' ' + lines[++i].replace(/^\([\w-]+\)\s*/, '').trim();
      const line = text.match(/on input line (\d+)/);
      push({ level: 'warning', file: '', line: line ? Number(line[1]) : 0, message: text.trim() });
      continue;
    }
    const bib = lines[i].match(/^(I found no .+|I couldn't open .+|Warning--.+|ERROR - .+|WARN - .+)$/);
    if (bib) { push({ level: 'warning', file: '', line: 0, message: bib[1].replace(/---while reading file .*/, '').trim() }); continue; }
    const box = lines[i].match(/^(Overfull|Underfull) \\[hv]box .* at lines? (\d+)/);
    if (box) push({ level: 'typesetting', file: '', line: Number(box[2]), message: lines[i].trim() });
  }
  return problems;
}
