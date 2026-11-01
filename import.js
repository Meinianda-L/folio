// Reads .zip archives and folders into a Folio project plan. Shared by the browser client and tests.

const MAX_FILES = 500;
const MAX_BYTES = 40 * 1024 * 1024;
const MAX_FILE = 10 * 1024 * 1024;
// Build products and editor droppings that a fresh compile recreates.
const SKIP_EXTENSIONS = /\.(aux|log|out|toc|lof|lot|fls|fdb_latexmk|synctex|synctex\.gz|synctex\(busy\)|blg|bcf|run\.xml|xdv|nav|snm|vrb|bbl-SAVE-ERROR|dvi)$/i;
const RESERVED = new Set(['project.json', 'node_modules', 'output', '__MACOSX']);

// Whether a path inside an archive or folder is left out of the project.
export function isSkipped(file) {
  const clean = String(file).replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '');
  const parts = clean.replace(/\/$/, '').split('/');
  return !clean || parts.some(part => !part || part.startsWith('.') || RESERVED.has(part)) || SKIP_EXTENSIONS.test(clean);
}
function fail(message) { return Object.assign(new Error(message), { code: 'IMPORT_ERROR' }); }
const u16 = (view, at) => view.getUint16(at, true);
const u32 = (view, at) => view.getUint32(at, true);

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Minimal ZIP reader: stored and deflated entries, no encryption or ZIP64.
export async function readZip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at -= 1) if (u32(view, at) === 0x06054b50) { end = at; break; }
  if (end < 0) throw fail('Not a .zip archive');
  const count = u16(view, end + 10), offset = u32(view, end + 16);
  if (count === 0xffff || offset === 0xffffffff) throw fail('ZIP64 archives are not supported');
  const decoder = new TextDecoder();
  const entries = [];
  let total = 0;
  for (let at = offset, i = 0; i < count; i += 1) {
    if (u32(view, at) !== 0x02014b50) throw fail('The .zip archive is damaged');
    const flags = u16(view, at + 8), method = u16(view, at + 10), packed = u32(view, at + 20), size = u32(view, at + 24);
    const nameLength = u16(view, at + 28), extraLength = u16(view, at + 30), commentLength = u16(view, at + 32), local = u32(view, at + 42);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw fail('Encrypted .zip archives are not supported');
    if ((total += size) > MAX_BYTES * 1.5) throw fail('The archive is larger than 40 MiB when unpacked');
    const start = local + 30 + u16(view, local + 26) + u16(view, local + 28);
    const raw = bytes.subarray(start, start + packed);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = await inflate(raw);
    else throw fail(`Unsupported compression in ${name}`);
    if (data.length !== size) throw fail(`The .zip archive is damaged (${name})`);
    entries.push({ path: name, data });
  }
  return entries;
}

const texText = data => new TextDecoder().decode(data);
const depth = file => file.split('/').length;

// Decide which files to keep, the main file and the engine for a set of {path, data} entries.
export function planImport(entries) {
  const kept = [], skipped = [];
  for (const entry of entries) {
    const clean = String(entry.path).replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '');
    if (isSkipped(clean) || !entry.data) { skipped.push(clean || entry.path); continue; }
    kept.push({ path: clean, data: entry.data });
  }
  // Archives usually wrap everything in one folder; the project starts inside it.
  const first = kept[0]?.path.split('/')[0];
  if (kept.length && kept.every(item => depth(item.path) > 1 && item.path.split('/')[0] === first)) for (const item of kept) item.path = item.path.slice(first.length + 1);
  if (!kept.length) throw fail('No project files found to import');
  if (kept.length > MAX_FILES) throw fail(`Projects are limited to ${MAX_FILES} files`);
  const bytes = kept.reduce((sum, item) => sum + item.data.length, 0);
  if (bytes > MAX_BYTES) throw fail('Projects are limited to 40 MiB');
  const tooLarge = kept.find(item => item.data.length > MAX_FILE);
  if (tooLarge) throw fail(`${tooLarge.path} is larger than 10 MiB`);

  const sources = kept.filter(item => item.path.toLowerCase().endsWith('.tex')).map(item => ({ path: item.path, text: texText(item.data) }));
  const roots = sources.filter(item => /^[^%\n]*\\documentclass/m.test(item.text));
  const rank = item => [item.path.split('/').pop() === 'main.tex' ? 0 : 1, depth(item.path), item.path];
  const compare = (a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; };
  const main = [...roots].sort(compare)[0] || [...sources].sort(compare)[0];
  const all = sources.map(item => item.text.replace(/(^|[^\\])%.*$/gm, '$1')).join('\n');
  const magic = main?.text.match(/^\s*%\s*!\s*TeX\s+(?:TS-)?program\s*=\s*(pdflatex|xelatex|lualatex)/im)?.[1]?.toLowerCase();
  const engine = magic
    || (/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]*\b(?:luacode|luatexja|lua-ul)\b|\\directlua/.test(all) ? 'lualatex'
      : /\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]*\b(?:fontspec|xeCJK|unicode-math|ctex|polyglossia)\b|\\documentclass(?:\[[^\]]*\])?\{ctex/.test(all) ? 'xelatex' : 'pdflatex');
  return { files: kept, skipped, mainFile: main?.path || '', engine, bytes };
}

export function toBase64(data) {
  let binary = '';
  for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
  return btoa(binary);
}
