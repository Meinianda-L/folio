import { spawn } from 'node:child_process';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { compileProject, parseLog, BIBER_CACHE } from './compiler.js';

export const TOOLS = ['pdflatex', 'xelatex', 'lualatex', 'bibtex', 'biber', 'tectonic', 'kpsewhich'];
const ENGINE_TOOLS = ['pdflatex', 'xelatex', 'lualatex', 'tectonic'];
// Packages most papers and templates load; kpsewhich reports the ones the distribution lacks.
export const PACKAGES = ['amsmath', 'amssymb', 'graphicx', 'hyperref', 'geometry', 'xcolor', 'booktabs', 'tikz', 'natbib', 'biblatex', 'cleveref', 'siunitx', 'listings', 'algorithm2e', 'microtype', 'enumitem', 'subcaption', 'fontspec', 'xeCJK', 'ctex'];
const exe = name => process.platform === 'win32' ? `${name}.exe` : name;

async function executable(file) {
  try { const stat = await fs.stat(file); if (!stat.isFile()) return false; await fs.access(file, constants.X_OK); return true; } catch { return false; }
}
async function children(pattern) {
  // Expand one trailing `*` level at a time, newest names first (e.g. texlive/2025 before 2024).
  const index = pattern.indexOf('*');
  if (index < 0) return [pattern];
  const base = pattern.slice(0, index).replace(/[\\/]$/, ''), rest = pattern.slice(index + 1);
  let names = [];
  try { names = (await fs.readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort().reverse(); } catch { return []; }
  return (await Promise.all(names.map(name => children(path.join(base, name) + rest)))).flat();
}
// Where TeX distributions put their binaries, besides the PATH Harness happened to start with.
async function wellKnownDirs() {
  const home = os.homedir();
  const patterns = process.platform === 'win32'
    ? ['C:\\texlive\\*\\bin\\windows', 'C:\\texlive\\*\\bin\\win64', 'C:\\texlive\\*\\bin\\win32', path.join(process.env.LOCALAPPDATA || '', 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64'), 'C:\\Program Files\\MiKTeX\\miktex\\bin\\x64', path.join(process.env.APPDATA || '', 'TinyTeX', 'bin', 'windows')]
    : ['/Library/TeX/texbin', '/usr/local/texlive/*/bin/*', '/opt/texlive/*/bin/*', path.join(home, 'Library', 'TinyTeX', 'bin', '*'), path.join(home, '.TinyTeX', 'bin', '*'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', path.join(home, '.cargo', 'bin'), path.join(home, '.local', 'bin')];
  return (await Promise.all(patterns.map(children))).flat();
}
function firstLine(command, args, timeoutMs = 5000) {
  return new Promise(resolve => {
    let out = '';
    let child;
    try { child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: path.dirname(command) + path.delimiter + (process.env.PATH || ''), HOME: os.tmpdir(), PAR_GLOBAL_TMPDIR: BIBER_CACHE } }); }
    catch { resolve(''); return; }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', chunk => { if (out.length < 64 * 1024) out += chunk; });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

// Finds the TeX distribution, remembers a folder the user picked, and checks that it renders.
export class TexEnvironment {
  constructor({ settingsFile }) { this.settingsFile = settingsFile; this.cached = null; }
  async settings() { try { return JSON.parse(await fs.readFile(this.settingsFile, 'utf8')); } catch { return {}; } }
  async setBin(bin) {
    const value = typeof bin === 'string' ? bin.trim() : '';
    if (value) {
      if (!path.isAbsolute(value)) throw Object.assign(new Error('Use an absolute folder path'), { code: 'INVALID_ARGUMENT' });
      const found = await Promise.all(ENGINE_TOOLS.map(tool => executable(path.join(value, exe(tool)))));
      if (!found.some(Boolean)) throw Object.assign(new Error('No pdflatex, xelatex, lualatex or tectonic in that folder'), { code: 'INVALID_ARGUMENT' });
    }
    const next = { ...(await this.settings()), texBin: value };
    await fs.mkdir(path.dirname(this.settingsFile), { recursive: true });
    await fs.writeFile(this.settingsFile, JSON.stringify(next, null, 2));
    this.cached = null;
    return this.status();
  }
  // Locate every tool: the chosen folder first, then the PATH, then the usual install locations.
  async locate() {
    if (this.cached && Date.now() - this.cached.at < 30_000) return this.cached.value;
    const { texBin = '' } = await this.settings();
    const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const dirs = [...new Set([texBin, ...pathDirs, ...(await wellKnownDirs())].filter(Boolean))];
    const tools = {};
    for (const tool of TOOLS) {
      tools[tool] = null;
      for (const dir of dirs) if (await executable(path.join(dir, exe(tool)))) { tools[tool] = path.join(dir, exe(tool)); break; }
    }
    const toolDirs = [...new Set(Object.values(tools).filter(Boolean).map(file => path.dirname(file)))];
    const searchPath = [...new Set([texBin, ...toolDirs, ...pathDirs, '/usr/bin', '/bin'].filter(Boolean))].join(path.delimiter);
    const value = { texBin, tools, path: searchPath };
    this.cached = { at: Date.now(), value };
    return value;
  }
  async path() { return (await this.locate()).path; }
  async status({ quick = false } = {}) {
    const { texBin, tools } = await this.locate();
    if (quick) return { texBin, platform: process.platform, engines: ENGINE_TOOLS.filter(tool => tools[tool]) };
    await fs.mkdir(BIBER_CACHE, { recursive: true, mode: 0o700 });
    const entries = await Promise.all(TOOLS.map(async tool => {
      if (!tools[tool]) return [tool, null];
      const text = await firstLine(tools[tool], ['--version']);
      return [tool, { path: tools[tool], version: text.split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 120) || '' }];
    }));
    const found = Object.fromEntries(entries);
    let missingPackages = null;
    if (found.kpsewhich) {
      const output = await firstLine(found.kpsewhich.path, PACKAGES.map(name => `${name}.sty`), 10_000);
      const present = new Set(output.split(/\r?\n/).map(line => path.basename(line.trim(), '.sty')).filter(Boolean));
      missingPackages = PACKAGES.filter(name => !present.has(name));
    }
    return {
      texBin, platform: process.platform,
      tools: found,
      engines: ENGINE_TOOLS.filter(tool => found[tool]),
      missingPackages
    };
  }
  // Render small documents that exercise each engine and bibliography tool that is installed.
  async test() {
    const { tools } = await this.locate();
    const searchPath = await this.path();
    const cases = [
      tools.pdflatex && { id: 'pdflatex', engine: 'pdflatex', files: { 'main.tex': '\\documentclass{article}\n\\usepackage{amsmath,graphicx,hyperref}\n\\begin{document}\nFolio test: $\\int_0^1 x^2\\,dx = \\tfrac13$.\n\\end{document}\n' } },
      tools.pdflatex && tools.bibtex && { id: 'bibtex', engine: 'pdflatex', files: { 'main.tex': '\\documentclass{article}\n\\begin{document}\nSee \\cite{folio}.\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n', 'refs.bib': '@book{folio, title={Folio}, author={Test, A.}, year={2026}, publisher={Folio}}\n' } },
      tools.pdflatex && tools.biber && { id: 'biber', engine: 'pdflatex', files: { 'main.tex': '\\documentclass{article}\n\\usepackage[backend=biber]{biblatex}\n\\addbibresource{refs.bib}\n\\begin{document}\nSee \\cite{folio}.\n\\printbibliography\n\\end{document}\n', 'refs.bib': '@book{folio, title={Folio}, author={Test, A.}, year={2026}, publisher={Folio}}\n' } },
      tools.xelatex && { id: 'xelatex', engine: 'xelatex', files: { 'main.tex': '\\documentclass{article}\n\\usepackage{fontspec}\n\\begin{document}\nFolio test: Unicode — café, Ελληνικά.\n\\end{document}\n' } },
      tools.xelatex && { id: 'ctex', engine: 'xelatex', files: { 'main.tex': '\\documentclass[UTF8]{ctexart}\n\\begin{document}\n中文渲染测试：你好，Folio。\n\\end{document}\n' } },
      tools.lualatex && { id: 'lualatex', engine: 'lualatex', files: { 'main.tex': '\\documentclass{article}\n\\begin{document}\nFolio test with Lua\\TeX.\n\\end{document}\n' } },
      tools.tectonic && { id: 'tectonic', engine: 'tectonic', files: { 'main.tex': '\\documentclass{article}\n\\begin{document}\nFolio test with Tectonic.\n\\end{document}\n' } }
    ].filter(Boolean);
    const results = [];
    for (const item of cases) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-textest-'));
      const started = Date.now();
      try {
        for (const [file, content] of Object.entries(item.files)) await fs.writeFile(path.join(root, file), content);
        const result = await compileProject({ root, mainFile: 'main.tex', engine: item.engine, path: searchPath });
        const problems = parseLog(result.diagnostics ?? result.log);
        const ok = result.ok && Boolean(result.pdf) && !(item.id === 'bibtex' || item.id === 'biber' ? /Citation .* undefined|I couldn't open|ERROR - /.test(result.diagnostics || '') : false);
        const error = ok ? '' : (problems.find(problem => problem.level === 'error')?.message || String(result.log || '').trim().split(/\r?\n/).slice(-4).join('\n'));
        results.push({ id: item.id, engine: item.engine, ok, durationMs: Date.now() - started, error: error.slice(0, 600) });
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    }
    return { results };
  }
}
