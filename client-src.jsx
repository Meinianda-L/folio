import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { basicSetup } from 'codemirror';
import { EditorState, EditorSelection, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { snippetCompletion } from '@codemirror/autocomplete';
import { diffLines } from 'diff';
import english from './locale/en.json';
import chinese from './locale/zh.json';

const NS = 'folio';
const PROJECT_KEY = 'folio-project-v1';
const LAYOUT_KEY = 'folio-layout-v1';
const AUTO_KEY = 'folio-autocompile-v1';
const ARCHIVED_KEY = 'folio-archived-chats-v1';
const ENGINES = [['pdflatex', 'pdfLaTeX'], ['xelatex', 'XeLaTeX'], ['tectonic', 'Tectonic']];
const TOPBAR = 48;
const FLOAT_MIN = { w: 280, h: 200 };
const FLOAT_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const DEFAULT_LAYOUT = { files: 220, chat: 400, split: 0.5, show: { files: true, editor: true, pdf: true, chat: true } };

/* ───────────── small utilities ───────────── */

const messageOf = error => error?.message || String(error);
function readStored(key, fallback) { try { const value = localStorage.getItem(key); return value == null ? fallback : JSON.parse(value); } catch { return fallback; } }
function store(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
const endpoint = file => new URL(file, document.baseURI).toString();
async function rpc(action, args = {}) {
  const response = await fetch(endpoint('api/folio'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, args }) });
  let body;
  try { body = await response.json(); } catch { throw new Error(`Folio service unavailable (HTTP ${response.status}). Restart DSH after installing the plugin.`); }
  if (!body.ok) throw Object.assign(new Error(body.error || 'Request failed'), { code: body.code });
  return body.value;
}
function unwrap(result) { if (!result?.ok) throw new Error(result?.error?.message || result?.error?.code || 'Harness request failed'); return result.value; }
function countWords(text) {
  const plain = text.replace(/%.*$/gm, ' ').replace(/\\(begin|end)\{[^}]*\}/g, ' ').replace(/\\[a-zA-Z@]+\*?/g, ' ').replace(/[{}[\]$&#^_~\\]/g, ' ');
  const cjk = (plain.match(/[㐀-鿿豈-﫿]/g) || []).length;
  const latin = plain.replace(/[㐀-鿿豈-﫿]/g, ' ').split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word)).length;
  return cjk + latin;
}
function relativeTime(iso, locale) {
  const time = Date.parse(iso);
  if (!time) return '';
  const seconds = Math.round((time - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  return format.format(0, 'second');
}
const fileToBase64 = file => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
const isTextPath = file => /\.(tex|bib|sty|cls|bst|bbx|cbx|def|cfg|clo|dtx|ins|txt|md|csv|tsv|dat|json|ya?ml|lua|py|r|m|gp|tikz|pgf)$/i.test(file);

// In-flight session bindings per project, shared across remounts of the workspace.
const bindings = new Map();
// Resolve 'found' once the Session list knows `id`, 'missing' when the loaded list still lacks it
// after a grace period (deleted chat), or 'timeout'.
function waitForSession(sessions, id, timeoutMs = 10000) {
  return new Promise(resolve => {
    const started = Date.now();
    let loadedAt = 0, done = false, unsubscribe = () => {}, timer = 0;
    const finish = value => { if (done) return; done = true; clearInterval(timer); unsubscribe(); resolve(value); };
    const check = () => {
      const snapshot = sessions.list.getSnapshot();
      if (snapshot.byId?.[id]) return finish('found');
      if (snapshot.phase && snapshot.phase !== 'pending' && !loadedAt) loadedAt = Date.now();
      if (loadedAt && Date.now() - loadedAt > 2500) return finish('missing');
      if (Date.now() - started > timeoutMs) finish('timeout');
    };
    timer = setInterval(check, 250);
    try { const stop = sessions.list.subscribe(check); if (typeof stop === 'function') { if (done) stop(); else unsubscribe = stop; } } catch {}
    check();
  });
}

/* ───────────── icons ───────────── */

const ICONS = {
  files: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h9A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z',
  source: 'M8.5 7 4 12l4.5 5M15.5 7 20 12l-4.5 5M13.5 5l-3 14',
  pdf: 'M6 3h9l4 4v14H6zM15 3v4h4M9 12h6M9 15.5h6M9 9h3',
  chat: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z',
  play: 'M8 5.5v13l10.5-6.5z',
  chevron: 'm7 10 5 5 5-5',
  right: 'm10 7 5 5-5 5',
  plus: 'M12 5v14M5 12h14',
  upload: 'M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15',
  download: 'M12 4v12m0 0-4.5-4.5M12 16l4.5-4.5M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15',
  more: 'M5.5 12h.01M12 12h.01M18.5 12h.01',
  close: 'M6 6l12 12M18 6 6 18',
  star: 'm12 4 2.4 5 5.4.6-4 3.7 1.1 5.3L12 16l-4.9 2.6 1.1-5.3-4-3.7 5.4-.6z',
  tex: 'M7 4h7l4 4v12H7zM14 4v4h4',
  image: 'M4 5h16v14H4zM4 15.5l4.5-4.5 4 4 2.5-2.5 5 5M15 9.5h.01',
  folder: 'M3.5 7A1.5 1.5 0 0 1 5 5.5h4l1.8 2H19A1.5 1.5 0 0 1 20.5 9v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z',
  spark: 'M12 3.5c.6 3.9 2.2 5.6 6 6.3-3.8.7-5.4 2.4-6 6.2-.6-3.8-2.2-5.5-6-6.2 3.8-.7 5.4-2.4 6-6.3zM18.5 15c.3 1.6.9 2.3 2.5 2.6-1.6.3-2.2 1-2.5 2.5-.3-1.5-.9-2.2-2.5-2.5 1.6-.3 2.2-1 2.5-2.6z',
  alert: 'M12 4 21 19.5H3zM12 10v4.5M12 17h.01',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  back: 'm14 7-5 5 5 5',
  refresh: 'M19 8a7.5 7.5 0 1 0 1 6M19 4v4h-4',
  archive: 'M4 5h16v4H4zM5.5 9v10h13V9M10 13h4',
  'dock-right': 'M4 5h16v14H4zM14 5v14',
  'dock-left': 'M4 5h16v14H4zM10 5v14',
  'dock-bottom': 'M4 5h16v14H4zM4 14h16',
  'dock-float': 'M4 5h16v14H4zM11 11h7v6h-7z'
};
function Icon({ name, size = 16, fill = false }) {
  return <svg className="fo-icon" width={size} height={size} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[name]} /></svg>;
}
function FolioMark({ size = 22 }) {
  return <svg className="fo-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="16" fill="var(--fo-accent)" /><path d="M19 13h19l9 9v29H19z" fill="#fff" /><path d="M38 13v9h9z" fill="#fff" opacity=".55" /><path d="M36.5 27c-.9-1.2-2.1-1.7-3.4-1.4-1.9.5-2.6 2.3-3 4.8l-3 15c-.5 2.3-1.5 3.4-3.1 3.4M27.2 32.6h7.6" fill="none" stroke="var(--fo-accent)" strokeWidth="3" strokeLinecap="round" /></svg>;
}


/* ───────────── \ command completion ───────────── */

// [name, snippet body after the command (${} = tab stops), detail]
const COMMANDS = [
  ['section', '{${title}}', 'heading'], ['section*', '{${title}}', 'unnumbered'], ['subsection', '{${title}}', 'heading'], ['subsubsection', '{${title}}', 'heading'], ['paragraph', '{${title}}', 'heading'], ['chapter', '{${title}}', 'heading'], ['part', '{${title}}', 'heading'],
  ['title', '{${}}', 'preamble'], ['author', '{${}}', 'preamble'], ['date', '{${\\today}}', 'preamble'], ['maketitle', '', 'title block'], ['tableofcontents', '', 'contents'], ['appendix', '', ''], ['bibliography', '{${references}}', 'BibTeX file'], ['bibliographystyle', '{${plain}}', 'style'], ['printbibliography', '', 'biblatex'], ['addbibresource', '{${references.bib}}', 'biblatex'],
  ['textbf', '{${}}', 'bold'], ['textit', '{${}}', 'italic'], ['emph', '{${}}', 'emphasis'], ['underline', '{${}}', ''], ['texttt', '{${}}', 'monospace'], ['textsc', '{${}}', 'small caps'], ['textsf', '{${}}', 'sans'], ['textrm', '{${}}', 'roman'], ['textcolor', '{${red}}{${}}', 'xcolor'], ['footnote', '{${}}', ''], ['url', '{${}}', 'hyperref'], ['href', '{${url}}{${text}}', 'hyperref'],
  ['cite', '{${}}', 'citation'], ['citep', '{${}}', 'natbib'], ['citet', '{${}}', 'natbib'], ['parencite', '{${}}', 'biblatex'], ['textcite', '{${}}', 'biblatex'], ['nocite', '{${*}}', ''],
  ['label', '{${}}', ''], ['ref', '{${}}', 'reference'], ['eqref', '{${}}', 'equation ref'], ['cref', '{${}}', 'cleveref'], ['Cref', '{${}}', 'cleveref'], ['autoref', '{${}}', 'hyperref'], ['pageref', '{${}}', ''],
  ['input', '{${}}', 'file'], ['include', '{${}}', 'file'], ['includegraphics', '[width=${\\linewidth}]{${}}', 'graphicx'], ['caption', '{${}}', ''], ['centering', '', ''],
  ['usepackage', '{${}}', 'package'], ['documentclass', '{${article}}', 'class'], ['newcommand', '{\\${name}}[${1}]{${}}', 'macro'], ['renewcommand', '{\\${name}}{${}}', 'macro'], ['DeclareMathOperator', '{\\${name}}{${}}', 'amsmath'],
  ['item', ' ', 'list item'], ['newpage', '', ''], ['clearpage', '', ''], ['noindent', '', ''], ['vspace', '{${1em}}', ''], ['hspace', '{${1em}}', ''], ['linewidth', '', 'length'], ['textwidth', '', 'length'], ['today', '', ''],
  ['hline', '', 'table rule'], ['toprule', '', 'booktabs'], ['midrule', '', 'booktabs'], ['bottomrule', '', 'booktabs'], ['multicolumn', '{${2}}{${c}}{${}}', 'table'],
  ['frac', '{${num}}{${den}}', 'math'], ['dfrac', '{${num}}{${den}}', 'math'], ['sqrt', '{${}}', 'math'], ['sum', '_{${i=1}}^{${n}}', 'math'], ['prod', '_{${i=1}}^{${n}}', 'math'], ['int', '_{${a}}^{${b}}', 'math'], ['lim', '_{${n \\to \\infty}}', 'math'], ['partial', '', 'math'], ['nabla', '', 'math'], ['infty', '', 'math'],
  ['mathbb', '{${R}}', 'math font'], ['mathcal', '{${}}', 'math font'], ['mathbf', '{${}}', 'math font'], ['mathrm', '{${}}', 'math font'], ['boldsymbol', '{${}}', 'math font'], ['operatorname', '{${}}', 'math'], ['text', '{${}}', 'text in math'],
  ['left(', '${} \\right)', 'delimiters'], ['left[', '${} \\right]', 'delimiters'], ['hat', '{${}}', 'accent'], ['bar', '{${}}', 'accent'], ['tilde', '{${}}', 'accent'], ['vec', '{${}}', 'accent'], ['dot', '{${}}', 'accent'], ['overline', '{${}}', ''], ['underbrace', '{${}}_{${}}', ''],
  ...['alpha', 'beta', 'gamma', 'Gamma', 'delta', 'Delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'Theta', 'kappa', 'lambda', 'Lambda', 'mu', 'nu', 'xi', 'pi', 'Pi', 'rho', 'sigma', 'Sigma', 'tau', 'phi', 'varphi', 'Phi', 'chi', 'psi', 'Psi', 'omega', 'Omega'].map(name => [name, '', 'greek']),
  ...['cdot', 'cdots', 'ldots', 'times', 'div', 'pm', 'leq', 'geq', 'neq', 'approx', 'equiv', 'sim', 'propto', 'in', 'notin', 'subset', 'subseteq', 'cup', 'cap', 'forall', 'exists', 'to', 'rightarrow', 'Rightarrow', 'leftrightarrow', 'iff', 'mapsto', 'langle', 'rangle', 'top', 'quad', 'qquad'].map(name => [name, '', 'symbol'])
];
const ENVIRONMENTS = ['equation', 'equation*', 'align', 'align*', 'gather', 'multline', 'cases', 'matrix', 'pmatrix', 'bmatrix', 'figure', 'figure*', 'table', 'table*', 'tabular', 'itemize', 'enumerate', 'description', 'abstract', 'theorem', 'lemma', 'proposition', 'corollary', 'definition', 'remark', 'proof', 'center', 'minipage', 'quote', 'verbatim', 'lstlisting', 'tikzpicture', 'frame', 'thebibliography'];
const ENV_BODY = { figure: '\\centering\n\t\\includegraphics[width=\\linewidth]{${}}\n\t\\caption{${}}\n\t\\label{fig:${}}', table: '\\centering\n\t\\caption{${}}\n\t\\label{tab:${}}\n\t\\begin{tabular}{${lc}}\n\t\t${}\n\t\\end{tabular}', tabular: '${}', itemize: '\\item ${}', enumerate: '\\item ${}', description: '\\item[${}] ${}', frame: '\\frametitle{${}}\n\t${}' };
const ENV_ARGS = { tabular: '{${lc}}', minipage: '{${0.5\\linewidth}}', frame: '', figure: '[${htbp}]', table: '[${htbp}]' };
const PACKAGES = ['amsmath', 'amssymb', 'amsthm', 'mathtools', 'graphicx', 'hyperref', 'cleveref', 'geometry', 'booktabs', 'tabularx', 'xcolor', 'tikz', 'pgfplots', 'natbib', 'biblatex', 'listings', 'algorithm2e', 'algorithmicx', 'subcaption', 'caption', 'float', 'enumitem', 'microtype', 'siunitx', 'multirow', 'url', 'fontspec', 'ctex', 'xeCJK', 'babel', 'csquotes', 'fancyhdr', 'setspace', 'lipsum'];
const CLASSES = ['article', 'report', 'book', 'beamer', 'ctexart', 'ctexrep', 'ctexbook', 'IEEEtran', 'acmart', 'llncs', 'revtex4-2', 'elsarticle', 'memoir'];

const commandOptions = [
  ...COMMANDS.map(([name, body, detail]) => body ? snippetCompletion(`\\${name}${body}` + '${}', { label: `\\${name}`, detail, type: detail === 'math' || detail === 'greek' || detail === 'symbol' ? 'constant' : 'keyword', boost: name.startsWith('sub') || name === 'section' ? 2 : 0 }) : { label: `\\${name}`, detail, type: detail === 'greek' || detail === 'symbol' ? 'constant' : 'keyword' }),
  ...ENVIRONMENTS.map(env => snippetCompletion(`\\begin{${env}}${ENV_ARGS[env] || ''}\n\t${ENV_BODY[env] || '${}'}\n\\end{${env}}` + '${}', { label: `\\begin{${env}}`, detail: 'environment', type: 'type' }))
];
// Labels, bibliography keys and files of the open project, refreshed by the workspace.
const projectIndex = { labels: [], cites: [], files: [] };
function latexCompletions(context) {
  const argument = context.matchBefore(/\\([a-zA-Z]+\*?)(?:\[[^\]\n]*\])?\{[^{}\n]*$/);
  if (argument) {
    const match = argument.text.match(/^\\([a-zA-Z]+\*?)(?:\[[^\]\n]*\])?\{([^{}\n]*)$/);
    const command = match[1], typed = match[2];
    const from = argument.to - (typed.length - typed.lastIndexOf(',') - 1);
    const doc = context.state.doc.toString();
    let options = [];
    if (/^(ref|eqref|cref|Cref|autoref|pageref|vref|nameref)$/.test(command)) options = [...new Set([...projectIndex.labels, ...[...doc.matchAll(/\\label\{([^}]+)\}/g)].map(m => m[1])])].map(label => ({ label, type: 'variable', detail: label.split(':')[0] }));
    else if (/cite|^nocite$/i.test(command)) options = [...new Set([...projectIndex.cites, ...[...doc.matchAll(/\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}/g)].map(m => m[1])])].map(label => ({ label, type: 'text', detail: 'bib' }));
    else if (command === 'includegraphics') options = projectIndex.files.filter(file => /\.(png|jpe?g|pdf|eps|svg)$/i.test(file)).map(label => ({ label, type: 'text' }));
    else if (command === 'input' || command === 'include') options = projectIndex.files.filter(file => file.endsWith('.tex')).map(file => ({ label: command === 'include' ? file.replace(/\.tex$/, '') : file, type: 'text' }));
    else if (command === 'bibliography' || command === 'addbibresource') options = projectIndex.files.filter(file => file.endsWith('.bib')).map(file => ({ label: command === 'bibliography' ? file.replace(/\.bib$/, '') : file, type: 'text' }));
    else if (command === 'begin' || command === 'end') options = ENVIRONMENTS.map(label => ({ label, type: 'type' }));
    else if (command === 'usepackage') options = PACKAGES.map(label => ({ label, type: 'namespace' }));
    else if (command === 'documentclass') options = CLASSES.map(label => ({ label, type: 'class' }));
    else return null;
    return options.length ? { from, options, validFor: /^[^,{}\s]*$/ } : null;
  }
  const word = context.matchBefore(/\\[a-zA-Z@]*\*?/);
  if (!word) return null;
  return { from: word.from, options: commandOptions, validFor: /^\\[a-zA-Z@]*\*?$/ };
}

/* ───────────── LaTeX language ───────────── */

const MATH_ENVS = /^(equation|align|alignat|gather|multline|flalign|eqnarray|math|displaymath)\*?$/;
const latexLanguage = StreamLanguage.define({
  name: 'latex',
  startState: () => ({ math: null, arg: null, env: null }),
  copyState: state => ({ ...state }),
  token(stream, state) {
    if (state.arg) {
      if (stream.eat('}')) { const kind = state.arg; state.arg = null; if (kind === 'begin' && MATH_ENVS.test(state.env || '')) state.math = 'env'; return 'bracket'; }
      if (stream.match(/^[^}%\n]+/)) { if (state.arg === 'begin' || state.arg === 'end') { state.env = stream.current().trim(); return 'typeName'; } return state.arg === 'ref' ? 'labelName' : 'string'; }
      stream.next(); return null;
    }
    if (stream.match(/^%.*/)) return 'comment';
    if (state.math) {
      if ((state.math === '$$' && stream.match('$$')) || (state.math === '$' && stream.eat('$')) || (state.math === '\\]' && stream.match('\\]')) || (state.math === '\\)' && stream.match('\\)'))) { state.math = null; return 'meta'; }
      if (state.math === 'env' && stream.match(/^\\end(?=\{)/)) { state.math = null; stream.eat('{'); state.arg = 'end'; return 'keyword'; }
      if (stream.match(/^\\[a-zA-Z@]+/)) return 'variableName';
      if (stream.match(/^[0-9.]+/)) return 'number';
      if (stream.match(/^[{}[\]]/)) return 'bracket';
      stream.next(); return 'atom';
    }
    if (stream.match('$$')) { state.math = '$$'; return 'meta'; }
    if (stream.eat('$')) { state.math = '$'; return 'meta'; }
    if (stream.match('\\[')) { state.math = '\\]'; return 'meta'; }
    if (stream.match('\\(')) { state.math = '\\)'; return 'meta'; }
    const command = stream.match(/^\\([a-zA-Z@]+\*?|.)/);
    if (command) {
      const name = command[1];
      if ((name === 'begin' || name === 'end') && stream.eat('{')) { state.arg = name; return 'keyword'; }
      if (/^(cite[a-z]*|ref|eqref|autoref|cref|Cref|label|pageref|input|include|includegraphics|bibliography|usepackage|documentclass)$/.test(name)) {
        const before = stream.pos;
        stream.match(/^\s*\[[^\]]*\]/);
        if (stream.eat('{')) { state.arg = /ref|label/.test(name) ? 'ref' : 'path'; return name.startsWith('use') || name === 'documentclass' ? 'meta' : 'keyword'; }
        stream.pos = before;
      }
      if (/^(part|chapter|section|subsection|subsubsection|paragraph|title|caption)\*?$/.test(name)) return 'heading';
      return 'keyword';
    }
    if (stream.match(/^[{}]/)) return 'bracket';
    if (stream.match(/^[&~]/)) return 'operator';
    if (stream.match(/^[^\\%${}&~]+/)) return null;
    stream.next(); return null;
  },
  languageData: {
    commentTokens: { line: '%' },
    autocomplete: latexCompletions
  }
});
const latexHighlight = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--fo-syn-comment)', fontStyle: 'italic' },
  { tag: tags.keyword, color: 'var(--fo-syn-command)' },
  { tag: tags.heading, color: 'var(--fo-syn-heading)', fontWeight: '600' },
  { tag: tags.typeName, color: 'var(--fo-syn-env)', fontWeight: '500' },
  { tag: [tags.meta, tags.operator], color: 'var(--fo-syn-meta)' },
  { tag: [tags.variableName, tags.atom, tags.number], color: 'var(--fo-syn-math)' },
  { tag: tags.labelName, color: 'var(--fo-syn-ref)' },
  { tag: tags.string, color: 'var(--fo-syn-arg)' },
  { tag: tags.bracket, color: 'var(--fo-syn-bracket)' }
]);
const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13.5px', color: 'var(--fo-ink)', backgroundColor: 'var(--fo-surface)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--fo-mono)', lineHeight: '1.75' },
  '.cm-content': { padding: '18px 0 40vh', caretColor: 'var(--fo-accent)' },
  '.cm-line': { padding: '0 22px 0 14px' },
  '.cm-gutters': { backgroundColor: 'var(--fo-surface)', border: 'none', color: 'var(--fo-faint)', paddingLeft: '8px' },
  '.cm-activeLine': { backgroundColor: 'var(--fo-active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fo-ink)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--fo-selection) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--fo-accent)', borderLeftWidth: '2px' },
  '.cm-matchingBracket': { backgroundColor: 'var(--fo-accent-soft)', outline: 'none' },
  '.cm-searchMatch': { backgroundColor: 'var(--fo-accent-soft)' },
  '.cm-tooltip': { border: '1px solid var(--fo-line)', backgroundColor: 'var(--fo-raised)', borderRadius: '8px', overflow: 'hidden', boxShadow: 'var(--fo-shadow)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--fo-accent)', color: '#fff' },
  '.cm-panels': { backgroundColor: 'var(--fo-raised)', color: 'var(--fo-ink)', borderColor: 'var(--fo-line)' },
  '.cm-flash-line': { backgroundColor: 'var(--fo-accent-soft)', transition: 'background-color 1.2s ease' },
  '&.cm-focused': { outline: 'none' }
});

function SourceEditor({ docKey, content, onChange, onCursor, onSave, onCompile, apiRef }) {
  const host = useRef(null);
  const handlers = useRef({}); handlers.current = { onChange, onCursor, onSave, onCompile };
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({ parent: host.current, state: EditorState.create({ doc: content, extensions: [
      Prec.high(keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { handlers.current.onSave(); return true; } },
        { key: 'Mod-Enter', preventDefault: true, run: () => { handlers.current.onCompile(); return true; } }
      ])),
      basicSetup, latexLanguage, syntaxHighlighting(latexHighlight), editorTheme, EditorView.lineWrapping,
      EditorView.updateListener.of(update => {
        if (update.docChanged) handlers.current.onChange(update.state.doc.toString());
        if (update.docChanged || update.selectionSet) {
          const { main } = update.state.selection;
          const doc = update.state.doc;
          handlers.current.onCursor({ line: doc.lineAt(main.head).number, from: doc.lineAt(main.from).number, to: doc.lineAt(main.to).number, text: main.empty ? '' : doc.sliceString(main.from, main.to) });
        }
      })
    ] }) });
    apiRef.current = {
      jumpTo(line) {
        const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
        view.dispatch({ selection: EditorSelection.cursor(target.from), effects: EditorView.scrollIntoView(target.from, { y: 'center' }) });
        view.focus();
      },
      focus: () => view.focus()
    };
    return () => { apiRef.current = null; view.destroy(); };
  }, [docKey]);
  return <div className="fo-editor" data-testid="folio-editor" ref={host} />;
}

/* ───────────── diff review ───────────── */

function DiffView({ proposal }) {
  const rows = useMemo(() => {
    const parts = diffLines(proposal.original || '', proposal.content || '');
    const output = [];
    let oldLine = 1, newLine = 1;
    parts.forEach((part, index) => {
      const lines = part.value.replace(/\n$/, '').split('\n');
      if (!part.added && !part.removed) {
        const keepHead = index === 0 ? 0 : 3, keepTail = index === parts.length - 1 ? 0 : 3;
        if (lines.length > keepHead + keepTail + 2) {
          lines.slice(0, keepHead).forEach(text => output.push({ type: 'same', text, a: oldLine++, b: newLine++ }));
          const hidden = lines.length - keepHead - keepTail;
          output.push({ type: 'gap', count: hidden });
          oldLine += hidden; newLine += hidden;
          lines.slice(lines.length - keepTail).forEach(text => output.push({ type: 'same', text, a: oldLine++, b: newLine++ }));
        } else lines.forEach(text => output.push({ type: 'same', text, a: oldLine++, b: newLine++ }));
      } else if (part.removed) lines.forEach(text => output.push({ type: 'del', text, a: oldLine++ }));
      else lines.forEach(text => output.push({ type: 'add', text, b: newLine++ }));
    });
    return output;
  }, [proposal.id]);
  return <div className="fo-diff" role="table">{rows.map((row, i) => row.type === 'gap'
    ? <div key={i} className="fo-diff-gap">⋯ {row.count}</div>
    : <div key={i} className={`fo-diff-row is-${row.type}`}><span className="fo-diff-n">{row.a ?? ''}</span><span className="fo-diff-n">{row.b ?? ''}</span><span className="fo-diff-sign">{row.type === 'add' ? '+' : row.type === 'del' ? '−' : ''}</span><code>{row.text || ' '}</code></div>)}</div>;
}

/* ───────────── chrome pieces ───────────── */

function Dialog({ title, children, onClose, busy }) {
  useEffect(() => { const listener = event => { if (event.key === 'Escape' && !busy) onClose(); }; window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener); }, [busy, onClose]);
  return <div className="fo-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="fo-dialog" role="dialog" aria-modal="true" aria-label={title}><h2>{title}</h2>{children}</section>
  </div>;
}
function PromptForm({ t, label, initial = '', placeholder, submitLabel, onSubmit, onCancel, danger, message }) {
  const [value, setValue] = useState(initial); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  return <form onSubmit={async event => { event.preventDefault(); if (!message && !value.trim()) { setError(t('required')); return; } setBusy(true); setError(''); try { await onSubmit(value.trim()); } catch (failure) { setError(messageOf(failure)); setBusy(false); } }}>
    {message ? <p className="fo-dialog-copy">{message}</p> : <label className="fo-field"><span>{label}</span><input autoFocus value={value} placeholder={placeholder} disabled={busy} onChange={event => { setValue(event.target.value); setError(''); }} onFocus={event => { const dot = event.target.value.lastIndexOf('.'); if (dot > 0) event.target.setSelectionRange(event.target.value.lastIndexOf('/') + 1, dot); }} /></label>}
    {error && <p className="fo-form-error" role="alert">{error}</p>}
    <footer><button type="button" className="fo-btn" onClick={onCancel} disabled={busy}>{t('cancel')}</button><button className={danger ? 'fo-btn is-danger' : 'fo-btn is-primary'} disabled={busy}>{submitLabel}</button></footer>
  </form>;
}
function Menu({ items, onClose, anchor }) {
  const ref = useRef(null);
  useEffect(() => { const listener = event => { if (!ref.current?.contains(event.target)) onClose(); }; const key = event => { if (event.key === 'Escape') onClose(); }; setTimeout(() => window.addEventListener('pointerdown', listener)); window.addEventListener('keydown', key); return () => { window.removeEventListener('pointerdown', listener); window.removeEventListener('keydown', key); }; }, []);
  return <div className="fo-menu" ref={ref} role="menu" style={anchor}>{items.filter(Boolean).map(item => <button key={item.label} role="menuitem" className={item.danger ? 'is-danger' : ''} onClick={() => { onClose(); item.run(); }}>{item.label}</button>)}</div>;
}
function useToasts() {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((text, tone = 'info') => { const id = Math.random(); setToasts(list => [...list.slice(-2), { id, text, tone }]); setTimeout(() => setToasts(list => list.filter(item => item.id !== id)), tone === 'error' ? 7000 : 3200); }, []);
  const view = <div className="fo-toasts" aria-live="polite">{toasts.map(item => <div key={item.id} className={`fo-toast is-${item.tone}`} role={item.tone === 'error' ? 'alert' : 'status'}><span>{item.text}</span><button aria-label="×" onClick={() => setToasts(list => list.filter(other => other.id !== item.id))}><Icon name="close" size={13} /></button></div>)}</div>;
  return [push, view];
}

/* ───────────── library ───────────── */

function Library({ t, locale, projects, loading, onOpen, onCreate, onRename, onDelete }) {
  const [name, setName] = useState(''); const [template, setTemplate] = useState(locale.startsWith('zh') ? 'ctex' : 'article');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [dialog, setDialog] = useState(null); const [menu, setMenu] = useState(null);
  const templates = [['article', t('tplArticle'), t('tplArticleHint')], ['ctex', t('tplCtex'), t('tplCtexHint')], ['blank', t('tplBlank'), t('tplBlankHint')]];
  return <div className="fo-library"><div className="fo-library-inner">
    <header className="fo-library-head"><div className="fo-wordmark"><FolioMark size={36} /><div><h1>Folio</h1><p className="fo-lead">{t('libraryLead')}</p></div></div></header>
    <form className="fo-create" onSubmit={async event => { event.preventDefault(); if (!name.trim()) { setError(t('required')); return; } setBusy(true); setError(''); try { await onCreate(name.trim(), template); setName(''); } catch (failure) { setError(messageOf(failure)); } finally { setBusy(false); } }}>
      <label className="fo-field"><span>{t('newProject')}</span><input data-testid="folio-name-input" value={name} disabled={busy} placeholder={t('projectPlaceholder')} onChange={event => { setName(event.target.value); setError(''); }} /></label>
      <button className="fo-btn is-primary fo-create-submit" disabled={busy}>{busy ? t('creating') : t('create')}</button>
      <fieldset className="fo-templates"><legend>{t('template')}</legend>{templates.map(([id, label, hint]) => <label key={id} className={template === id ? 'is-selected' : ''}><input type="radio" name="template" value={id} checked={template === id} onChange={() => setTemplate(id)} /><strong>{label}</strong><small>{hint}</small></label>)}</fieldset>
      {error && <p className="fo-form-error" role="alert">{error}</p>}
    </form>
    <section className="fo-shelf">
      <header><h2>{t('library')}</h2><span className="fo-count">{projects.length}</span></header>
      {!projects.length && !loading ? <p className="fo-shelf-empty">{t('noProjects')}</p> : <div className="fo-pages">{projects.map((project, index) => <article key={project.id} className="fo-page" style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}>
        <button className="fo-page-open" onClick={() => onOpen(project.id)} aria-label={`${t('open')} ${project.name}`}>
          <span className="fo-page-icon" aria-hidden="true"><Icon name="tex" size={18} /></span>
          <strong>{project.name}</strong>
          <small>{project.engine === 'xelatex' ? 'XeLaTeX' : project.engine === 'tectonic' ? 'Tectonic' : 'pdfLaTeX'} · {t('edited')} {relativeTime(project.updatedAt, locale)}</small>
        </button>
        <button className="fo-page-more" aria-label="…" onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setMenu({ project, anchor: { position: 'fixed', top: box.bottom + 4, left: Math.max(8, box.right - 160) } }); }}><Icon name="more" /></button>
      </article>)}</div>}
    </section>
  </div>
    {menu && <Menu anchor={menu.anchor} onClose={() => setMenu(null)} items={[{ label: t('open'), run: () => onOpen(menu.project.id) }, { label: t('rename'), run: () => setDialog({ kind: 'rename', project: menu.project }) }, { label: t('delete'), danger: true, run: () => setDialog({ kind: 'delete', project: menu.project }) }]} />}
    {dialog && <Dialog title={dialog.kind === 'rename' ? t('rename') : t('delete')} onClose={() => setDialog(null)}>
      <PromptForm t={t} label={t('projectName')} initial={dialog.project.name} danger={dialog.kind === 'delete'} message={dialog.kind === 'delete' ? `${t('deleteProjectConfirm')} — ${dialog.project.name}` : ''} submitLabel={dialog.kind === 'delete' ? t('delete') : t('save')} onCancel={() => setDialog(null)} onSubmit={async value => { if (dialog.kind === 'delete') await onDelete(dialog.project.id); else await onRename(dialog.project.id, value); setDialog(null); }} />
    </Dialog>}
  </div>;
}

/* ───────────── file tree ───────────── */

function FileTree({ t, files, activePath, mainFile, onOpen, onAction, onUpload }) {
  const [collapsed, setCollapsed] = useState(() => new Set()); const [dragging, setDragging] = useState(false); const [menu, setMenu] = useState(null);
  const rows = useMemo(() => {
    const entries = new Map();
    for (const file of files) {
      const parts = file.path.split('/');
      parts.slice(0, -1).forEach((_, i) => { const path = parts.slice(0, i + 1).join('/'); if (!entries.has(path)) entries.set(path, { path, name: parts[i], depth: i, directory: true }); });
      entries.set(file.path, { ...file, name: parts[parts.length - 1], depth: parts.length - 1 });
    }
    return [...entries.values()].sort((a, b) => {
      const pa = a.path.split('/'), pb = b.path.split('/');
      for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
        if (pa[i] !== pb[i]) { const aDir = i < pa.length - 1 || a.directory, bDir = i < pb.length - 1 || b.directory; if (aDir !== bDir) return aDir ? -1 : 1; return pa[i].localeCompare(pb[i]); }
      }
      return pa.length - pb.length;
    });
  }, [files]);
  const hidden = path => { const parts = path.split('/'); return parts.slice(0, -1).some((_, i) => collapsed.has(parts.slice(0, i + 1).join('/'))); };
  return <div className={`fo-tree ${dragging ? 'is-drop' : ''}`} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }} onDrop={event => { event.preventDefault(); setDragging(false); if (event.dataTransfer.files.length) onUpload([...event.dataTransfer.files]); }}>
    <nav aria-label={t('files')}>{rows.map(row => hidden(row.path) ? null : <div key={row.path} className={`fo-tree-row ${row.path === activePath ? 'is-active' : ''}`} style={{ '--depth': row.depth }}>
      <button className="fo-tree-item" title={row.path} onClick={() => row.directory ? setCollapsed(previous => { const next = new Set(previous); next.has(row.path) ? next.delete(row.path) : next.add(row.path); return next; }) : onOpen(row.path)}>
        {row.directory ? <span className={`fo-tree-caret ${collapsed.has(row.path) ? '' : 'is-open'}`}><Icon name="right" size={12} /></span> : <span className="fo-tree-caret" />}
        <span className={`fo-tree-icon kind-${row.directory ? 'folder' : row.kind}`}><Icon name={row.directory ? 'folder' : row.kind === 'image' ? 'image' : 'tex'} size={14} /></span>
        <span className="fo-tree-name">{row.name}</span>
        {row.path === mainFile && <span className="fo-tree-main" title={t('mainFile')}><Icon name="star" size={11} fill /></span>}
      </button>
      {!row.directory && <button className="fo-tree-more" aria-label="…" onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setMenu({ row, anchor: { position: 'fixed', top: box.bottom + 2, left: box.left - 120 } }); }}><Icon name="more" size={14} /></button>}
    </div>)}</nav>
    {dragging && <div className="fo-drop-hint">{t('dropHere')}</div>}
    {menu && <Menu anchor={menu.anchor} onClose={() => setMenu(null)} items={[menu.row.path.endsWith('.tex') && menu.row.path !== mainFile && { label: t('setMain'), run: () => onAction('main', menu.row.path) }, { label: t('rename'), run: () => onAction('rename', menu.row.path) }, { label: t('delete'), danger: true, run: () => onAction('delete', menu.row.path) }]} />}
  </div>;
}

/* ───────────── the embedded Harness conversation ───────────── */

function FixedChatView(props) { return <>{props.renderSlot('conversation.session', { view: 'chat' })}</>; }
// Mirrors DSH's own embedded Conversation (subagent tab): native composer, model picker,
// Markdown, reasoning and tool rows all come from the Harness chat itself.
function FolioChat({ sessionId, onRunning, useSession, useConversation, useSessions, renderFactorySlot }) {
  const session = useSession(value => value);
  const shellPhase = useConversation(value => value).activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running ? 'active' : session.promptAttempted ? 'engaging' : 'blank';
  const summaryBlank = useSessions(state => state.byId[sessionId]?.blank);
  const settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true;
  const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true);
  const running = Boolean(session.running);
  useEffect(() => { onRunning?.(running); }, [running]);
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase: settling ? 'settling' : hero ? 'hero' : 'active', hero }, { slots: { views: FixedChatView } });
}

/* ───────────── resizable workbench ───────────── */

function useElementSize(ref) {
  const [size, setSize] = useState({ width: 1200, height: 800 });
  useEffect(() => { if (!ref.current) return; const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height })); observer.observe(ref.current); return () => observer.disconnect(); }, []);
  return size;
}
function Handle({ onDrag, onDone, label, axis = 'x' }) {
  return <div className={`fo-handle is-${axis}`} role="separator" aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'} aria-label={label} onPointerDown={event => {
    event.preventDefault();
    const handle = event.currentTarget; handle.setPointerCapture(event.pointerId);
    const root = handle.closest('.fo-root'); root?.classList.add('is-resizing');
    let lastX = event.clientX, lastY = event.clientY;
    const move = moveEvent => { onDrag(moveEvent.clientX - lastX, moveEvent.clientY - lastY); lastX = moveEvent.clientX; lastY = moveEvent.clientY; };
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); root?.classList.remove('is-resizing'); onDone?.(); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  }}><span /></div>;
}

/* ───────────── chats of this manuscript ───────────── */

const EMPTY_LIST = { ids: [], byId: {} };
function useSessionList(sessions) {
  return useSyncExternalStore(
    useCallback(listener => sessions?.list?.subscribe?.(listener) || (() => {}), [sessions]),
    () => sessions?.list?.getSnapshot?.() || EMPTY_LIST
  );
}
// Chats are the Harness Sessions whose directory is this manuscript's folder.
function ChatSwitcher({ t, locale, services, directory, currentId, running, onSwitch, onNew, onArchive, archived }) {
  const list = useSessionList(services.sessions);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const listener = event => { if (!ref.current?.contains(event.target)) setOpen(false); };
    const key = event => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', listener); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', listener); window.removeEventListener('keydown', key); };
  }, [open]);
  // Session list rows are keyed by `id`; DSH titles a chat after its first exchange.
  // The Session list still carries archived chats; hide the ones archived here.
  const rows = Object.values(list.byId || {}).filter(item => item && directory && item.cwd === directory && !item.parentSessionId && (!archived.has(item.id) || item.id === currentId));
  const chats = rows.filter(item => !item.blank || item.id === currentId).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const empty = rows.filter(item => item.blank && item.id !== currentId && !item.running).map(item => item.id);
  const titleOf = item => item?.title?.trim() || (item?.blank ? '' : item?.displayTitle?.trim()) || t('untitledChat');
  return <div className="fo-chat-switch" ref={ref}>
    <button className="fo-chat-switch-btn" aria-expanded={open} onClick={() => setOpen(!open)} title={t('chats')}>
      <Icon name="spark" size={13} /><span>{currentId ? titleOf(list.byId?.[currentId]) : t('assistant')}</span><Icon name="chevron" size={13} />
    </button>
    {open && <div className="fo-popover fo-chat-list" role="menu">
      <header><span className="fo-caps">{t('chats')}</span><button className="fo-btn is-small" disabled={running} onClick={() => { setOpen(false); onNew(); }}><Icon name="plus" size={13} /> {t('newChat')}</button></header>
      {chats.length ? <ul>{chats.map(item => <li key={item.id} className={item.id === currentId ? 'is-current' : ''}>
        <button className="fo-chat-row" role="menuitem" disabled={running && item.id !== currentId} onClick={() => { setOpen(false); if (item.id !== currentId) onSwitch(item.id); }}>
          <span className="fo-chat-title">{item.running && <i className="fo-live-dot" />}{titleOf(item)}</span>
          <small>{relativeTime(new Date(item.updatedAt || Date.now()).toISOString(), locale)}</small>
        </button>
        {!item.running && <button className="fo-icon-btn" title={t('archive')} aria-label={`${t('archive')} ${titleOf(item)}`} onClick={() => onArchive([item.id])}><Icon name="archive" size={14} /></button>}
      </li>)}</ul> : <p className="fo-muted fo-chat-none">{t('noChats')}</p>}
      {empty.length > 0 && <footer><button className="fo-btn is-small" onClick={() => onArchive(empty)}><Icon name="archive" size={13} /> {t('archiveEmpty')} ({empty.length})</button></footer>}
    </div>}
  </div>;
}
function DockMenu({ t, dock, onDock }) {
  const [anchor, setAnchor] = useState(null);
  const options = [['right', t('dockRight')], ['left', t('dockLeft')], ['bottom', t('dockBottom')], ['float', t('dockFloat')]];
  return <>
    <button className="fo-icon-btn" title={t('dock')} aria-label={t('dock')} onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setAnchor({ position: 'fixed', top: box.bottom + 4, left: Math.max(8, box.right - 180) }); }}><Icon name={`dock-${dock}`} /></button>
    {anchor && <Menu anchor={anchor} onClose={() => setAnchor(null)} items={options.map(([value, label]) => ({ label: `${value === dock ? '✓ ' : '\u2003'}${label}`, run: () => onDock(value) }))} />}
  </>;
}

/* ───────────── workspace ───────────── */

function Workspace({ t, locale, services, projectId, onExit, renderSlot, SessionProvider, toast }) {
  const [project, setProject] = useState(null);
  const [files, setFiles] = useState([]);
  const [file, setFile] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState('saved');
  const [conflict, setConflict] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, from: 1, to: 1, text: '' });
  const [build, setBuild] = useState(null);
  const [compiling, setCompiling] = useState(false);
  const [showIssues, setShowIssues] = useState(false);
  const [proposals, setProposals] = useState([]);
  const [reviewing, setReviewing] = useState(null);
  const [session, setSession] = useState({ id: '', reference: null, error: '' });
  const [running, setRunning] = useState(false);
  const [layout, setLayout] = useState(() => ({ ...DEFAULT_LAYOUT, ...readStored(LAYOUT_KEY, {}), show: { ...DEFAULT_LAYOUT.show, ...(readStored(LAYOUT_KEY, {}).show || {}) } }));
  const [mobilePane, setMobilePane] = useState('editor');
  const [autoCompile, setAutoCompile] = useState(() => readStored(AUTO_KEY, false));
  const [archived, setArchived] = useState(() => new Set(readStored(ARCHIVED_KEY, [])));
  const [dialog, setDialog] = useState(null);
  const [compileMenu, setCompileMenu] = useState(false);
  const [drop, setDrop] = useState(null);
  const rootRef = useRef(null); const editorApi = useRef(null); const uploadRef = useRef(null); const mounted = useRef(true);
  const live = useRef({}); live.current = { project, file, dirty, autoCompile, session, cursor };
  const saving = useRef(null); const saveTimer = useRef(0); const generation = useRef(0);
  const { width, height } = useElementSize(rootRef);
  const narrow = width < 860;

  const updateLayout = patch => setLayout(previous => { const next = typeof patch === 'function' ? patch(previous) : { ...previous, ...patch }; return next; });
  useEffect(() => { store(LAYOUT_KEY, layout); }, [layout]);
  useEffect(() => { store(AUTO_KEY, autoCompile); }, [autoCompile]);

  const loadFiles = useCallback(async () => { const { files: list } = await rpc('listFiles', { projectId }); setFiles(list); return list; }, [projectId]);
  const loadProposals = useCallback(async () => { const { proposals: list } = await rpc('listProposals', { projectId }); setProposals(list); setReviewing(current => current && !list.some(item => item.id === current) ? null : current); return list; }, [projectId]);
  const replaceFile = value => { generation.current += 1; const next = { ...value, key: `${value.path}#${generation.current}` }; live.current = { ...live.current, file: next, dirty: false }; setFile(next); setDirty(false); setSaveState('saved'); setConflict(false); };

  async function save() {
    clearTimeout(saveTimer.current);
    if (saving.current) { await saving.current; if (!live.current.dirty) return; }
    const run = (async () => {
      while (live.current.file && live.current.dirty && live.current.file.kind === 'text') {
        const current = live.current.file;
        setSaveState('saving');
        try {
          const result = await rpc('writeFile', { projectId, path: current.path, content: current.content, expectedHash: current.hash });
          const latest = live.current.file;
          if (!latest || latest.key !== current.key) return;
          const stillDirty = latest.content !== current.content;
          const nextFile = { ...latest, hash: result.hash };
          live.current = { ...live.current, file: nextFile, dirty: stillDirty };
          setFile(nextFile); setDirty(stillDirty); setSaveState(stillDirty ? 'dirty' : 'saved');
        } catch (error) {
          if (error.code === 'CONFLICT') { setConflict(true); setSaveState('dirty'); return; }
          setSaveState('dirty'); throw error;
        }
      }
    })();
    saving.current = run;
    try { await run; } finally { if (saving.current === run) saving.current = null; }
  }
  const saveQuietly = () => save().catch(error => toast(messageOf(error), 'error'));

  async function openFile(path) {
    try {
      await save();
      const entry = files.find(item => item.path === path) || { path, kind: isTextPath(path) ? 'text' : 'binary' };
      setReviewing(null);
      if (entry.kind !== 'text') { replaceFile({ path, kind: entry.kind, content: '', hash: null }); return; }
      const result = await rpc('readFile', { projectId, path });
      replaceFile({ ...result, kind: 'text' });
      if (narrow) setMobilePane('editor');
    } catch (error) { toast(messageOf(error), 'error'); }
  }

  async function compile() {
    if (compiling) return;
    setCompiling(true);
    try {
      await save();
      const result = await rpc('compile', { projectId });
      setBuild(result);
      if (!result.ok) setShowIssues(true);
      else setShowIssues(false);
    } catch (error) { toast(messageOf(error), 'error'); }
    finally { setCompiling(false); }
  }
  const compileRef = useRef(compile); compileRef.current = compile;
  const saveAndMaybeCompile = async () => { try { await save(); compileRef.current(); } catch (error) { toast(messageOf(error), 'error'); } };

  // Initial load: project, files, last build, proposals and the project's writing session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await rpc('getProject', { projectId });
        if (cancelled) return;
        setProject(info);
        const list = await loadFiles();
        const first = list.find(item => item.path === info.mainFile) || list.find(item => item.path.endsWith('.tex')) || list.find(item => item.kind === 'text');
        if (first && !cancelled) { const result = await rpc('readFile', { projectId, path: first.path }); if (!cancelled) replaceFile({ ...result, kind: 'text' }); }
        const { build: last } = await rpc('lastBuild', { projectId });
        if (!cancelled) setBuild(last ? { ...last, log: '' } : null);
        await loadProposals();
      } catch (error) { if (!cancelled) toast(messageOf(error), 'error'); }
    })();
    return () => { cancelled = true; clearTimeout(saveTimer.current); };
  }, [projectId]);

  async function workspaceOf(info) {
    // Each manuscript folder is its own Harness Workspace, so its chats group under the title in DSH.
    const { workspace, created } = unwrap(await services.remote.workspace.create({ path: info.directory }));
    if (created || workspace.title !== info.name) await services.remote.workspace.rename({ workspaceId: workspace.workspaceId, title: info.name }).catch(() => {});
    return workspace;
  }
  async function createSession(info) {
    const workspace = await workspaceOf(info);
    const created = unwrap(await services.remote.session.create({ workspaceId: workspace.workspaceId }));
    const updated = await rpc('updateProject', { projectId, sessionId: created.sessionId });
    setProject(updated);
    return created.sessionId;
  }
  async function bindSession(info, { fresh = false, target = '' } = {}) {
    // One binding at a time per project: a remount or repeated click must never mint extra chats.
    if (bindings.has(projectId)) return bindings.get(projectId);
    const run = (async () => {
      setSession(previous => { previous.reference?.release(); return { id: '', reference: null, error: '' }; });
      try {
        let id = fresh ? '' : target || info.sessionId;
        if (target && target !== info.sessionId) setProject(await rpc('updateProject', { projectId, sessionId: target }));
        // The browser's Session list loads asynchronously; retain() rejects ids it has not seen yet.
        if (id && await waitForSession(services.sessions, id) === 'missing') id = '';
        if (!id) {
          id = await createSession(info);
          if (await waitForSession(services.sessions, id, 20000) !== 'found') throw new Error(t('chatUnavailable'));
        } else {
          // Chats created before workspaces (or moved in DSH) are adopted into the manuscript's workspace.
          const workspace = await workspaceOf(info).catch(() => null);
          if (workspace && !workspace.sessionIds.includes(id)) await services.remote.workspace.insertSessionBefore({ workspaceId: workspace.workspaceId, sessionId: id }).catch(() => {});
        }
        const reference = services.sessions.retain(id, { source: 'folio' });
        if (!mounted.current) { reference.release(); return; }
        setSession({ id, reference, error: '' });
      } catch (error) { if (mounted.current) setSession({ id: '', reference: null, error: messageOf(error) }); }
    })();
    bindings.set(projectId, run);
    try { await run; } finally { bindings.delete(projectId); }
  }
  async function archiveChats(ids) {
    for (const id of ids) {
      try { unwrap(await services.remote.workspace.archiveSession({ sessionId: id })); }
      catch (error) { toast(messageOf(error), 'error'); return; }
      setArchived(previous => { const next = new Set(previous).add(id); store(ARCHIVED_KEY, [...next].slice(-500)); return next; });
    }
    if (ids.includes(live.current.session?.id)) bindSession(live.current.project, { fresh: true });
  }
  const projectReady = Boolean(project);
  useEffect(() => { if (projectReady) bindSession(live.current.project); }, [projectReady]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; live.current.session?.reference?.release(); }; }, []);

  // Feed \ref, \cite and file-argument completion from the whole project, not just the open file.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      const labels = [], cites = [];
      for (const entry of files.filter(item => item.kind === 'text' && /\.(tex|bib)$/.test(item.path) && item.size < 1024 * 1024).slice(0, 40)) {
        try {
          const { content } = await rpc('readFile', { projectId, path: entry.path });
          if (entry.path.endsWith('.bib')) for (const match of content.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)) cites.push(match[1]);
          else for (const match of content.matchAll(/\\label\{([^}]+)\}/g)) labels.push(match[1]);
        } catch {}
      }
      if (!cancelled) Object.assign(projectIndex, { labels: [...new Set(labels)], cites: [...new Set(cites)], files: files.map(item => item.path) });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [files, saveState === 'saved']);

  // Keep the Host's view of the active file and selection current for the next turn's context.
  useEffect(() => {
    if (!session.id || !file) return;
    const timer = setTimeout(() => { rpc('focus', { projectId, sessionId: session.id, path: file.path, line: cursor.line, selection: cursor.text, selectionFrom: cursor.from, selectionTo: cursor.to }).catch(() => {}); }, 350);
    return () => clearTimeout(timer);
  }, [session.id, file?.path, cursor.line, cursor.text]);

  // While the assistant works, its proposals and builds appear without a manual refresh.
  useEffect(() => {
    if (!running) {
      loadProposals().catch(() => {});
      rpc('lastBuild', { projectId }).then(({ build: last }) => { if (last) setBuild(previous => previous && previous.builtAt === last.builtAt ? previous : { ...last, log: previous?.log || '' }); }).catch(() => {});
      return;
    }
    const timer = setInterval(() => { loadProposals().catch(() => {}); }, 2500);
    return () => clearInterval(timer);
  }, [running]);

  async function settle(proposal, accept) {
    try {
      if (live.current.file?.path === proposal.path) await save();
      await rpc(accept ? 'applyProposal' : 'rejectProposal', { projectId, id: proposal.id });
      const list = await loadProposals();
      const next = list.find(item => item.id !== proposal.id);
      setReviewing(next ? next.id : null);
      if (accept) {
        if (live.current.file?.path === proposal.path || !live.current.file) { const result = await rpc('readFile', { projectId, path: proposal.path }); replaceFile({ ...result, kind: 'text' }); }
        await loadFiles();
        toast(t('applied'), 'success');
        if (live.current.autoCompile) compileRef.current();
      } else toast(t('discarded'));
    } catch (error) { toast(error.code === 'CONFLICT' ? t('conflict') : messageOf(error), 'error'); }
  }

  async function upload(list) {
    for (const item of list) {
      try {
        const base64 = await fileToBase64(item);
        const exists = files.some(entry => entry.path === item.name);
        await rpc('uploadFile', { projectId, path: item.name, base64, overwrite: exists });
      } catch (error) { toast(`${item.name}: ${messageOf(error)}`, 'error'); }
    }
    await loadFiles().catch(() => {});
  }
  async function fileAction(kind, path) {
    if (kind === 'main') { try { setProject(await rpc('updateProject', { projectId, mainFile: path })); } catch (error) { toast(messageOf(error), 'error'); } return; }
    setDialog({ kind, path });
  }
  async function submitDialog(value) {
    const { kind, path } = dialog;
    if (kind === 'new') {
      await save();
      await rpc('writeFile', { projectId, path: value, content: '', expectedHash: null });
      await loadFiles();
      replaceFile({ ...(await rpc('readFile', { projectId, path: value })), kind: 'text' });
    } else if (kind === 'rename') {
      if (live.current.file?.path === path) await save();
      await rpc('renameFile', { projectId, from: path, to: value });
      await loadFiles();
      setProject(await rpc('getProject', { projectId }));
      if (live.current.file?.path === path) setFile(previous => { const next = { ...previous, path: value }; live.current = { ...live.current, file: next }; return next; });
    } else if (kind === 'delete') {
      const entry = files.find(item => item.path === path);
      let hash = null;
      if (entry?.kind === 'text') hash = live.current.file?.path === path ? (await save(), live.current.file.hash) : (await rpc('readFile', { projectId, path })).hash;
      await rpc('deleteFile', { projectId, path, expectedHash: hash });
      const list = await loadFiles();
      if (live.current.file?.path === path) { setFile(null); live.current = { ...live.current, file: null, dirty: false }; const next = list.find(item => item.kind === 'text'); if (next) openFile(next.path); }
    } else if (kind === 'title') {
      setProject(await rpc('updateProject', { projectId, name: value }));
    }
    setDialog(null);
  }
  async function resolveConflict(keepMine) {
    const current = live.current.file;
    const fresh = await rpc('readFile', { projectId, path: current.path });
    if (keepMine) { const next = { ...current, hash: fresh.hash }; live.current = { ...live.current, file: next, dirty: true }; setFile(next); setConflict(false); await save(); }
    else replaceFile({ ...fresh, kind: 'text' });
  }
  async function setEngine(engine) { try { setProject(await rpc('updateProject', { projectId, engine })); } catch (error) { toast(messageOf(error), 'error'); } }
  async function setMain(mainFile) { try { setProject(await rpc('updateProject', { projectId, mainFile })); } catch (error) { toast(messageOf(error), 'error'); } }

  const onChange = value => {
    const next = { ...live.current.file, content: value };
    live.current = { ...live.current, file: next, dirty: true };
    setFile(next); setDirty(true); setSaveState('dirty');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { save().then(() => { if (live.current.autoCompile && !live.current.dirty) compileRef.current(); }).catch(error => toast(messageOf(error), 'error')); }, 900);
  };

  const words = useMemo(() => file?.kind === 'text' ? countWords(file.content) : 0, [file?.content]);
  const problems = build?.problems || [];
  const errorCount = problems.filter(item => item.level === 'error').length;
  const warningCount = problems.length - errorCount;
  const texFiles = files.filter(item => item.path.endsWith('.tex'));
  const reviewProposal = proposals.find(item => item.id === reviewing);
  const pdfUrl = build?.hasPdf ? endpoint(`api/folio/pdf?projectId=${encodeURIComponent(projectId)}&v=${encodeURIComponent(build.builtAt || '')}`) : '';
  const show = layout.show;
  const visible = narrow ? { files: mobilePane === 'files', editor: mobilePane === 'editor', pdf: mobilePane === 'pdf', chat: mobilePane === 'chat' } : show;
  const toggle = pane => updateLayout(previous => { const next = { ...previous.show, [pane]: !previous.show[pane] }; if (!next.editor && !next.pdf && !next.chat) return previous; return { ...previous, show: next }; });
  // Where the assistant lives: a docked column (right/left), a bottom panel, or a floating window.
  const dock = narrow ? 'right' : (['right', 'left', 'bottom', 'float'].includes(layout.dock) ? layout.dock : 'right');
  // With source and PDF both hidden the assistant becomes the main pane and takes the free width.
  const chatFills = !visible.editor && !visible.pdf;
  const chatInRow = visible.chat && !chatFills && (dock === 'left' || dock === 'right');
  const floating = visible.chat && !narrow && !chatFills && dock === 'float';
  const centerWidth = Math.max(0, width - (visible.files ? layout.files : 0) - (chatInRow ? layout.chat : 0));
  const float = { w: 420, h: 560, ...(layout.float || {}) };
  float.w = Math.max(FLOAT_MIN.w, Math.min(float.w, width)); float.h = Math.max(FLOAT_MIN.h, Math.min(float.h, height - TOPBAR));
  float.x = Math.max(0, Math.min(float.x ?? width - float.w - 16, width - float.w)); float.y = Math.max(TOPBAR, Math.min(float.y ?? 64, height - float.h));
  // Follow one pointer gesture on the window, with the given cursor shown everywhere until it ends.
  function track(cursor, onMove, onUp) {
    const root = rootRef.current?.closest('.fo-root');
    root?.classList.add('is-resizing'); if (root) root.style.cursor = cursor;
    const up = upEvent => {
      window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      root?.classList.remove('is-resizing'); if (root) root.style.cursor = '';
      onUp?.(upEvent);
    };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  }
  // Resize the floating window from any edge or corner; `edge` lists the sides that move.
  function resizeFloat(event, edge) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const start = { px: event.clientX, py: event.clientY, ...float };
    const right = start.x + start.w, bottom = start.y + start.h;
    track(getComputedStyle(event.currentTarget).cursor, next => {
      const dx = next.clientX - start.px, dy = next.clientY - start.py;
      let { x, y, w, h } = start;
      if (edge.includes('e')) w = Math.min(width - x, Math.max(FLOAT_MIN.w, start.w + dx));
      if (edge.includes('s')) h = Math.min(height - y, Math.max(FLOAT_MIN.h, start.h + dy));
      if (edge.includes('w')) { x = Math.max(0, Math.min(right - FLOAT_MIN.w, start.x + dx)); w = right - x; }
      if (edge.includes('n')) { y = Math.max(TOPBAR, Math.min(bottom - FLOAT_MIN.h, start.y + dy)); h = bottom - y; }
      updateLayout(previous => ({ ...previous, float: { x, y, w, h } }));
    });
  }
  // The dock an assistant dragged to (clientX, clientY) would land in, with its outline in workspace coordinates.
  function dropAt(clientX, clientY) {
    const root = rootRef.current?.getBoundingClientRect(), bench = rootRef.current?.querySelector('.fo-bench')?.getBoundingClientRect();
    if (!root || !bench) return null;
    const reach = 64, top = bench.top - root.top, left = bench.left - root.left + (show.files ? layout.files + 1 : 0);
    const columnWidth = Math.min(layout.chat, bench.width / 2), panelHeight = Math.min(layout.chatHeight || 320, bench.height - 120);
    if (clientX < bench.left + reach) return { zone: 'left', left, top, width: columnWidth, height: bench.height };
    if (clientX > bench.right - reach) return { zone: 'right', left: bench.right - root.left - columnWidth, top, width: columnWidth, height: bench.height };
    if (clientY > bench.bottom - reach) return { zone: 'bottom', left, top: top + bench.height - panelHeight, width: bench.right - root.left - left, height: panelHeight };
    return null;
  }
  // Drag the assistant by its header. A docked panel tears off into a window after a few pixels;
  // releasing near the left, right or bottom edge docks it there, anywhere else leaves it floating.
  function dragChat(event) {
    if (event.button !== 0 || narrow || chatFills || event.target.closest('button, a, input, select, [role=menu], .fo-popover')) return;
    event.preventDefault();
    const root = rootRef.current.getBoundingClientRect(), pane = event.currentTarget.closest('.fo-pane-chat').getBoundingClientRect();
    const start = { px: event.clientX, py: event.clientY }, before = layout.float, from = dock;
    const grab = { x: Math.min(event.clientX - pane.left, float.w - 48), y: Math.min(event.clientY - pane.top, 32) };
    let torn = floating, target = null;
    track('grabbing', next => {
      if (!torn && Math.hypot(next.clientX - start.px, next.clientY - start.py) < 6) return;
      const x = Math.max(0, Math.min(width - float.w, next.clientX - root.left - grab.x));
      const y = Math.max(TOPBAR, Math.min(height - float.h, next.clientY - root.top - grab.y));
      updateLayout(previous => ({ ...previous, dock: 'float', lastDock: torn ? previous.lastDock : from, float: { ...float, x, y } }));
      torn = true;
      const zone = dropAt(next.clientX, next.clientY);
      if (zone?.zone !== target?.zone) setDrop(zone);
      target = zone;
    }, () => {
      setDrop(null);
      // Docking keeps the window's last free position for the next time it floats.
      if (target) updateLayout(previous => ({ ...previous, dock: target.zone, float: before ?? previous.float }));
    });
  }
  // Double-clicking the header switches between the window and the dock it came from.
  function toggleFloat(event) {
    if (narrow || chatFills || event.target.closest('button, a, input, select, [role=menu], .fo-popover')) return;
    updateLayout(previous => floating
      ? { ...previous, dock: previous.lastDock && previous.lastDock !== 'float' ? previous.lastDock : 'right' }
      : { ...previous, dock: 'float', lastDock: dock });
  }
  const jump = problem => {
    const go = () => { setShowIssues(false); setTimeout(() => editorApi.current?.jumpTo(problem.line), 30); if (narrow) setMobilePane('editor'); };
    if (problem.file && problem.file !== file?.path && files.some(item => item.path === problem.file)) openFile(problem.file).then(go); else if (problem.line) go();
  };

  const filesPane = visible.files && (<section key="files" className="fo-pane fo-pane-files" style={narrow ? undefined : { width: layout.files }}>
    <header className="fo-pane-head"><span className="fo-caps">{t('files')}</span><div className="fo-pane-actions"><button className="fo-icon-btn" title={t('newFile')} aria-label={t('newFile')} onClick={() => setDialog({ kind: 'new' })}><Icon name="plus" /></button><button className="fo-icon-btn" title={t('upload')} aria-label={t('upload')} onClick={() => uploadRef.current?.click()}><Icon name="upload" /></button><input ref={uploadRef} type="file" multiple hidden onChange={event => { upload([...event.target.files]); event.target.value = ''; }} /></div></header>
    <FileTree t={t} files={files} activePath={file?.path} mainFile={project?.mainFile} onOpen={openFile} onAction={fileAction} onUpload={upload} />
  </section>);
  const editorPane = visible.editor && (<section key="editor" className="fo-pane fo-pane-editor" style={narrow ? undefined : { flex: visible.pdf ? `${layout.split} 1 0` : '1 1 0' }}>
    <header className="fo-pane-head">
      <div className="fo-crumbs">{file ? file.path.split('/').map((part, i, all) => <span key={i} className={i === all.length - 1 ? 'is-file' : ''}>{part}</span>) : <span className="fo-caps">{t('editor')}</span>}</div>
      <div className="fo-pane-actions"><span className={`fo-save is-${saveState}`}>{saveState === 'saving' ? t('saving') : saveState === 'dirty' ? t('unsaved') : t('saved')}</span></div>
    </header>
    {proposals.length > 0 && !reviewProposal && <button className="fo-proposal-bar" onClick={() => setReviewing(proposals[0].id)}><Icon name="spark" /><span><strong>{proposals.length > 1 ? `${proposals.length} ${t('proposals')}` : t('proposal')}</strong> · {proposals[0].summary || proposals[0].path}</span><em>{t('review')} →</em></button>}
    {conflict && <div className="fo-conflict" role="alert"><Icon name="alert" /><span>{t('diskChanged')}</span><button className="fo-btn is-small" onClick={() => resolveConflict(false).catch(error => toast(messageOf(error), 'error'))}>{t('reload')}</button><button className="fo-btn is-small" onClick={() => resolveConflict(true).catch(error => toast(messageOf(error), 'error'))}>{t('overwrite')}</button></div>}
    <div className="fo-pane-body">
      {reviewProposal ? <div className="fo-review">
        <header><div><span className="fo-caps"><Icon name="spark" size={13} /> {t('proposal')} · {proposals.findIndex(item => item.id === reviewProposal.id) + 1}/{proposals.length}</span><h3>{reviewProposal.summary || reviewProposal.path}</h3><code>{reviewProposal.path}</code></div>
          <div className="fo-review-actions"><button className="fo-btn" onClick={() => setReviewing(null)}>{t('close')}</button><button className="fo-btn" onClick={() => settle(reviewProposal, false)}>{t('discard')}</button><button className="fo-btn is-primary" onClick={() => settle(reviewProposal, true)}><Icon name="check" /> {t('apply')}</button></div></header>
        <DiffView proposal={reviewProposal} />
      </div>
      : !file ? <div className="fo-empty"><p>{t('selectFile')}</p></div>
      : file.kind === 'image' ? <div className="fo-image-preview"><img alt={file.path} src={endpoint(`api/folio/raw?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(file.path)}`)} /></div>
      : file.kind !== 'text' ? <div className="fo-empty"><p>{t('binaryFile')}</p></div>
      : <SourceEditor docKey={file.key} content={file.content} apiRef={editorApi} onChange={onChange} onCursor={setCursor} onSave={saveAndMaybeCompile} onCompile={() => compileRef.current()} />}
    </div>
    <footer className="fo-status"><span>{file?.kind === 'text' ? 'LaTeX' : ''}</span>{file?.kind === 'text' && <><span>{t('line')} {cursor.line}</span><span>{words.toLocaleString(locale)} {t('words')}</span></>}</footer>
  </section>);
  const pdfPane = visible.pdf && (<section key="pdf" className="fo-pane fo-pane-pdf" style={narrow ? undefined : { flex: visible.editor ? `${1 - layout.split} 1 0` : '1 1 0' }}>
    <header className="fo-pane-head">
      <button className={`fo-build is-${compiling ? 'busy' : !build ? 'none' : build.ok ? 'ok' : 'failed'}`} onClick={() => setShowIssues(!showIssues)} disabled={!build}>
        <i />{compiling ? t('compiling') : !build ? t('noPdf') : build.ok ? t('buildOk') : t('buildFailed')}
        {build && !compiling && <small>{build.durationMs ? `${(build.durationMs / 1000).toFixed(1)}s · ` : ''}{relativeTime(build.builtAt, locale)}</small>}
        {errorCount > 0 && <b className="is-error">{errorCount}</b>}{warningCount > 0 && <b className="is-warning">{warningCount}</b>}
      </button>
      <div className="fo-pane-actions">{showIssues && build && <button className="fo-btn is-small" onClick={() => setShowIssues(false)}>{t('hideIssues')}</button>}{pdfUrl && <a className="fo-icon-btn" href={pdfUrl} download={`${project?.name || 'manuscript'}.pdf`} title={t('download')} aria-label={t('download')}><Icon name="download" /></a>}</div>
    </header>
    <div className="fo-pane-body fo-desk">
      {showIssues && build ? <div className="fo-issues">
        <h3 className="fo-caps">{t('issues')} {errorCount > 0 && <span className="is-error">{errorCount} {t('errors')}</span>} {warningCount > 0 && <span className="is-warning">{warningCount} {t('warnings')}</span>}</h3>
        {problems.length ? <ul>{problems.map((problem, i) => <li key={i} className={`is-${problem.level}`}><button onClick={() => jump(problem)} disabled={!problem.line}><span className="fo-issue-dot" /><span className="fo-issue-text">{problem.message}</span>{problem.line ? <code>{problem.file || file?.path || ''}:{problem.line}</code> : null}</button></li>)}</ul> : <p className="fo-muted">{t('noIssues')}</p>}
        {build.log && <details><summary>{t('rawLog')}</summary><pre>{build.log}</pre></details>}
      </div>
      : pdfUrl ? <iframe className="fo-pdf" title={t('pdf')} src={`${pdfUrl}#view=FitH&toolbar=1`} />
      : <div className="fo-empty fo-empty-pdf"><div className="fo-sheet" aria-hidden="true"><span /><span /><span /><span /></div><h3>{t('noPdf')}</h3><p>{t('noPdfHint')}</p><button className="fo-btn is-primary" onClick={() => compileRef.current()} disabled={compiling}><Icon name="play" fill size={13} /> {t('compile')}</button></div>}
    </div>
  </section>);
  const chatStyle = narrow ? undefined : chatFills ? { flex: '1 1 0' } : dock === 'bottom' ? { height: layout.chatHeight || 320 } : floating ? { left: float.x, top: float.y, width: float.w, height: float.h } : { width: layout.chat };
  const chatPane = visible.chat && (<section key="chat" className={`fo-pane fo-pane-chat is-${chatFills ? 'main' : dock}${drop ? ' is-dropping' : ''}`} style={chatStyle} aria-label={t('assistant')}>
    <header className="fo-pane-head" onPointerDown={dragChat} onDoubleClick={toggleFloat} title={narrow || chatFills ? undefined : t('dragHint')}>
      <ChatSwitcher t={t} locale={locale} services={services} directory={project?.directory} currentId={session.id} running={running} onSwitch={id => project && bindSession(project, { target: id })} onNew={() => project && bindSession(project, { fresh: true })} onArchive={archiveChats} archived={archived} />
      <div className="fo-pane-actions">
        <button className="fo-icon-btn" onClick={() => project && bindSession(project, { fresh: true })} disabled={!project || running} title={t('newChat')} aria-label={t('newChat')}><Icon name="plus" /></button>
        {!narrow && <DockMenu t={t} dock={dock} onDock={value => updateLayout(previous => ({ ...previous, dock: value, show: { ...previous.show, chat: true } }))} />}
        {(floating || dock === 'bottom') && <button className="fo-icon-btn" onClick={() => toggle('chat')} title={t('close')} aria-label={t('close')}><Icon name="close" /></button>}
      </div>
    </header>
    <div className="fo-context-chip" title={t('chatContext')}><Icon name="tex" size={12} /><span>{file?.path || project?.mainFile || '—'}</span>{cursor.text && <em>{cursor.to - cursor.from + 1} {t('selectedLines')}</em>}</div>
    <div className="fo-pane-body fo-chat-body">
      {session.reference ? <SessionProvider session={session.reference}>{renderSlot('folio.chat', { sessionId: session.id, onRunning: setRunning })}</SessionProvider>
        : <div className="fo-empty">{session.error ? <><p className="fo-form-error">{session.error}</p><button className="fo-btn" onClick={() => bindSession(live.current.project)}><Icon name="refresh" /> {t('reload')}</button></> : <p className="fo-muted">{t('chatStarting')}</p>}</div>}
    </div>
    {floating && FLOAT_EDGES.map(edge => <div key={edge} className={`fo-float-edge is-${edge}`} onPointerDown={event => resizeFloat(event, edge)} aria-hidden="true" />)}
  </section>);
  const center = [editorPane, visible.editor && visible.pdf && !narrow && <Handle key="h-split" label={t('pdf')} onDrag={dx => updateLayout(previous => ({ ...previous, split: Math.max(0.2, Math.min(0.8, previous.split + dx / Math.max(1, centerWidth))) }))} />, pdfPane].filter(Boolean);
  const chatHandle = <Handle key="h-chat" label={t('assistant')} onDrag={dx => updateLayout(previous => ({ ...previous, chat: Math.max(FLOAT_MIN.w, Math.min(Math.max(FLOAT_MIN.w, width * 0.7), previous.chat + (dock === 'left' ? dx : -dx))) }))} />;
  const bench = narrow ? [filesPane, editorPane, pdfPane, chatPane].filter(Boolean) : [
    filesPane, filesPane && <Handle key="h-files" label={t('files')} onDrag={dx => updateLayout(previous => ({ ...previous, files: Math.max(150, Math.min(420, previous.files + dx)) }))} />,
    chatInRow && dock === 'left' && chatPane, chatInRow && dock === 'left' && chatHandle,
    ...(visible.chat && !chatFills && dock === 'bottom'
      ? [<div key="center" className="fo-center"><div className="fo-center-row">{center}</div><Handle key="h-bottom" axis="y" label={t('assistant')} onDrag={(_, dy) => updateLayout(previous => ({ ...previous, chatHeight: Math.max(140, Math.min(height - TOPBAR - 120, (previous.chatHeight || 320) - dy)) }))} />{chatPane}</div>]
      : center),
    chatInRow && dock === 'right' && chatHandle, chatInRow && dock === 'right' && chatPane,
    visible.chat && chatFills && chatPane
  ].filter(Boolean);

  return <div className="fo-workspace" ref={rootRef}>
    <header className="fo-topbar">
      <div className="fo-topbar-left">
        <button className="fo-home" onClick={async () => { await save().catch(() => {}); onExit(); }} title={t('back')} aria-label={t('back')}><FolioMark /><span>Folio</span></button>
        <span className="fo-slash">/</span>
        <button className="fo-title" onClick={() => project && setDialog({ kind: 'title' })} title={t('rename')}>{project?.name || '…'}</button>
      </div>
      <div className="fo-topbar-right">
        {narrow ? <nav className="fo-seg" aria-label={t('layout')}>{[['files', 'files'], ['editor', 'source'], ['pdf', 'pdf'], ['chat', 'chat']].map(([pane, icon]) => <button key={pane} aria-pressed={mobilePane === pane} onClick={() => setMobilePane(pane)} title={t(pane === 'chat' ? 'assistant' : pane)}><Icon name={icon} /></button>)}</nav>
          : <nav className="fo-seg" aria-label={t('layout')}>{[['files', 'files'], ['editor', 'source'], ['pdf', 'pdf'], ['chat', 'chat']].map(([pane, icon]) => <button key={pane} aria-pressed={show[pane]} onClick={() => toggle(pane)} title={t(pane === 'chat' ? 'assistant' : pane)}><Icon name={icon} /><span>{t(pane === 'chat' ? 'assistant' : pane)}</span></button>)}</nav>}
        <div className="fo-compile">
          <button className="fo-btn is-primary fo-compile-main" onClick={() => compileRef.current()} disabled={compiling || !project} title="⌘/Ctrl + Enter">{compiling ? <span className="fo-spinner" /> : <Icon name="play" fill size={13} />}{compiling ? t('compiling') : t('compile')}</button>
          <button className="fo-btn is-primary fo-compile-more" aria-label={t('engine')} aria-expanded={compileMenu} onClick={() => setCompileMenu(!compileMenu)}><Icon name="chevron" size={14} /></button>
          {compileMenu && <CompileMenu t={t} project={project} texFiles={texFiles} autoCompile={autoCompile} setAutoCompile={setAutoCompile} setEngine={setEngine} setMain={setMain} onClose={() => setCompileMenu(false)} />}
        </div>
      </div>
    </header>
    <div className={`fo-bench ${narrow ? 'is-narrow' : ''}`}>{bench}</div>
    {floating && chatPane}
    {drop && <div className={`fo-drop is-${drop.zone}`} style={{ left: drop.left, top: drop.top, width: drop.width, height: drop.height }} aria-hidden="true" />}
    {dialog && <Dialog title={{ new: t('newFile'), rename: t('renameFile'), delete: t('deleteFile'), title: t('rename') }[dialog.kind]} onClose={() => setDialog(null)}>
      <PromptForm t={t} label={dialog.kind === 'title' ? t('projectName') : t('filePath')} placeholder={t('filePlaceholder')} initial={dialog.kind === 'title' ? project?.name : dialog.kind === 'new' ? '' : dialog.path} danger={dialog.kind === 'delete'} message={dialog.kind === 'delete' ? `${t('deleteFileConfirm')} — ${dialog.path}` : ''} submitLabel={dialog.kind === 'delete' ? t('delete') : dialog.kind === 'new' ? t('create') : t('save')} onCancel={() => setDialog(null)} onSubmit={submitDialog} />
    </Dialog>}
  </div>;
}

function CompileMenu({ t, project, texFiles, autoCompile, setAutoCompile, setEngine, setMain, onClose }) {
  const ref = useRef(null);
  useEffect(() => { const listener = event => { if (!ref.current?.contains(event.target) && !event.target.closest?.('.fo-compile-more')) onClose(); }; window.addEventListener('pointerdown', listener); return () => window.removeEventListener('pointerdown', listener); }, []);
  return <div className="fo-popover" ref={ref}>
    <label className="fo-field"><span>{t('engine')}</span><select value={project?.engine || 'pdflatex'} onChange={event => setEngine(event.target.value)}>{ENGINES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    <label className="fo-field"><span>{t('mainFile')}</span><select value={project?.mainFile || 'main.tex'} onChange={event => setMain(event.target.value)}>{texFiles.map(item => <option key={item.path} value={item.path}>{item.path}</option>)}</select></label>
    <label className="fo-switch"><input type="checkbox" checked={autoCompile} onChange={event => setAutoCompile(event.target.checked)} /><span />{t('autoCompile')}</label>
  </div>;
}

/* ───────────── root ───────────── */

function FolioApp({ services, t, renderSlot, SessionProvider }) {
  const locale = (typeof navigator !== 'undefined' && document.documentElement.lang) || navigator.language || 'en';
  const [projects, setProjects] = useState([]); const [loading, setLoading] = useState(true);
  const [projectId, setProjectId] = useState(() => readStored(PROJECT_KEY, ''));
  const [toast, toasts] = useToasts();
  const loadProjects = useCallback(async () => { try { const { projects: list } = await rpc('listProjects'); setProjects(list); return list; } catch (error) { toast(messageOf(error), 'error'); return []; } finally { setLoading(false); } }, []);
  useEffect(() => { loadProjects().then(list => { if (projectId && !list.some(item => item.id === projectId)) open(''); }); }, []);
  const open = id => { setProjectId(id); store(PROJECT_KEY, id); if (!id) loadProjects(); };
  return <div className="fo-root">
    <style>{__FOLIO_CSS__}</style>
    {projectId ? <Workspace key={projectId} t={t} locale={locale} services={services} projectId={projectId} onExit={() => open('')} renderSlot={renderSlot} SessionProvider={SessionProvider} toast={toast} />
      : <Library t={t} locale={locale} projects={projects} loading={loading} onOpen={open}
        onCreate={async (name, template) => { const project = await rpc('createProject', { name, template }); await loadProjects(); open(project.id); }}
        onRename={async (id, name) => { await rpc('updateProject', { projectId: id, name }); await loadProjects(); }}
        onDelete={async id => { await rpc('deleteProject', { projectId: id }); await loadProjects(); }} />}
    {toasts}
  </div>;
}

export const inject = ['slots', 'layout', 'remote', 'remote.session', 'remote.workspace', 'sessions', 'locale'];
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, 'en', english.folio));
  ctx.effect(() => ctx.locale.register(NS, 'zh', chinese.folio));
  const services = { remote: ctx.remote, sessions: ctx.sessions };
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'folio', locale: NS, children: { 'folio.chat': { kind: 'single', scope: 'session' } }, inject: () => ({ services }) }, FolioApp));
  ctx.slots.inject('folio.chat', () => ctx.slots.register({ name: 'folio.chat' }, FolioChat));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'folio', label: () => ctx.locale.bind(NS)('panel'), locale: NS, order: 5 }, function FolioIcon({ size = 20 }) {
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true"><path d="M5.5 3.5h9l4 4v13h-13z" /><path d="M14.5 3.5v4h4" /><path d="M13.6 9.6c-.4-.5-.9-.7-1.5-.6-.8.2-1.1 1-1.3 2.1l-1.3 6.4c-.2 1-.7 1.5-1.4 1.5M10 12h3.4" /></svg>;
  }));
}
