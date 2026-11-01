import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('.', import.meta.url));
const css = await readFile(new URL('./client.css', import.meta.url), 'utf8');
// The PDF.js worker is embedded as text and started from a Blob URL (see ensurePdfWorker).
const pdfWorker = await readFile(new URL('./node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url), 'utf8');
// React, the slot runtime and primitives come from the DSH web shell's shared module table.
const result = await build({ entryPoints: [directory + 'client-src.jsx'], bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2022', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'], minify: true, legalComments: 'none', logOverride: { 'empty-import-meta': 'silent' }, define: { __FOLIO_CSS__: JSON.stringify(css), __PDF_WORKER__: JSON.stringify(pdfWorker) } });
const code = result.outputFiles[0].text;
await writeFile(new URL('./client.js', import.meta.url), `window.__ModuleLoader__.load({id:'dsh-folio',factory(require){const module={exports:{}};const exports=module.exports;${code}\nreturn module.exports;}});\n`);
console.log(`Built DSH Folio client.js (${(code.length / 1024).toFixed(0)} KiB)`);
