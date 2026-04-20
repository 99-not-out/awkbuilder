import { LitElement, html, css, unsafeCSS } from './vendor/lit-all.min.js';

const STARTER_MODEL = () => ({
  flags: { fs: '', ofs: '', rs: '', ors: '' },
  blocks: [
    { kind: 'pattern', pattern: '', action: 'print FILENAME, FNR, NR, $0' },
  ],
});

// Common starter programs. Each template is a list of blocks that get
// appended to the current model respecting BEGIN/pattern/END order.
const TEMPLATES = [
  { id: 'count',    name: 'Count per key ($1)', blocks: [
      { kind: 'pattern', pattern: '',     action: 'count[$1]++' },
      { kind: 'end',     action: 'for (k in count) print count[k], k' }] },
  { id: 'sum',      name: 'Sum last field', blocks: [
      { kind: 'pattern', pattern: '',     action: 'sum += $NF' },
      { kind: 'end',     action: 'print sum' }] },
  { id: 'dedupe',   name: 'Dedupe lines', blocks: [
      { kind: 'pattern', pattern: '!seen[$0]++', action: '' }] },
  { id: 'skiphdr',  name: 'Skip header (NR>1)', blocks: [
      { kind: 'pattern', pattern: 'NR>1', action: 'print' }] },
  { id: 'firstrow', name: 'First line of each file', blocks: [
      { kind: 'pattern', pattern: 'FNR==1', action: 'print FILENAME, $0' }] },
  { id: 'cols',     name: 'Print fields $1, $2', blocks: [
      { kind: 'pattern', pattern: '',     action: 'print $1, $2' }] },
  { id: 'max',      name: 'Max by last field', blocks: [
      { kind: 'pattern', pattern: '$NF > max', action: 'max = $NF; line = $0' },
      { kind: 'end',     action: 'print max, line' }] },
];

const FS_PRESETS = [
  { label: 'ws',  value: '' },
  { label: ':',   value: ':' },
  { label: ',',   value: ',' },
  { label: 'tab', value: '\t' },
  { label: '|',   value: '|' },
  { label: '=',   value: '=' },
];

const PATTERN_MODES = [
  { id: 'always', label: 'Always',     hint: 'fires on every record' },
  { id: 'expr',   label: 'Expression', hint: 'any awk boolean expr, e.g. NR>1 && $3>100' },
  { id: 'regex',  label: 'Regex',      hint: 'matches /…/ against $0' },
  { id: 'field',  label: 'Field ~',    hint: '$N ~ /…/ against a single field' },
  { id: 'range',  label: 'Range',      hint: '/start/, /end/ — inclusive span' },
];

function inferMode(pattern) {
  if (!pattern || !pattern.trim()) return 'always';
  if (/^\/(.*)\/\s*,\s*\/(.*)\/$/.test(pattern)) return 'range';
  if (/^\$\w+\s*!?~\s*\/.*\/$/.test(pattern))     return 'field';
  if (/^\/(.*)\/$/.test(pattern))                 return 'regex';
  return 'expr';
}
function parsePattern(mode, pattern) {
  switch (mode) {
    case 'always': return {};
    case 'regex': {
      const m = pattern.match(/^\/(.*)\/$/);
      return { regex: m ? m[1] : '' };
    }
    case 'field': {
      const m = pattern.match(/^\$(\w+)\s*(!?~)\s*\/(.*)\/$/);
      return m ? { field: m[1], op: m[2], regex: m[3] }
               : { field: '1', op: '~', regex: '' };
    }
    case 'range': {
      const m = pattern.match(/^\/(.*)\/\s*,\s*\/(.*)\/$/);
      return m ? { startRegex: m[1], endRegex: m[2] }
               : { startRegex: '', endRegex: '' };
    }
    case 'expr':
    default:
      return { expr: pattern };
  }
}
function serializePattern(mode, parts) {
  switch (mode) {
    case 'always': return '';
    case 'regex':  return parts.regex ? `/${parts.regex}/` : '';
    case 'field': {
      const r = parts.regex ?? '';
      if (!r) return '';
      return `$${parts.field || '1'} ${parts.op || '~'} /${r}/`;
    }
    case 'range': {
      const a = parts.startRegex ?? '';
      const b = parts.endRegex   ?? '';
      if (!a && !b) return '';
      return `/${a}/, /${b}/`;
    }
    case 'expr':
    default:
      return parts.expr ?? '';
  }
}
function previewMatches(mode, parts, samples, fs) {
  if (mode === 'always') return samples.map(() => 'yes');
  if (mode === 'expr')   return samples.map(() => '?');
  if (mode === 'range') {
    if (!parts.startRegex && !parts.endRegex) return samples.map(() => 'no');
    try {
      const start = new RegExp(parts.startRegex ?? '');
      const end   = new RegExp(parts.endRegex   ?? '');
      let inRange = false;
      return samples.map((line) => {
        if (!inRange && start.test(line)) { inRange = true;  return 'yes'; }
        if (inRange) { const r = 'yes'; if (end.test(line)) inRange = false; return r; }
        return 'no';
      });
    } catch { return samples.map(() => '?'); }
  }
  if (mode === 'regex') {
    if (!parts.regex) return samples.map(() => 'no');
    try {
      const re = new RegExp(parts.regex);
      return samples.map(line => re.test(line) ? 'yes' : 'no');
    } catch { return samples.map(() => '?'); }
  }
  if (mode === 'field') {
    if (!parts.regex) return samples.map(() => 'no');
    try {
      const re = new RegExp(parts.regex);
      const op = parts.op || '~';
      const n2 = Number(parts.field);
      return samples.map(line => {
        const fields = splitFields(line, fs);
        const f = Number.isFinite(n2) && n2 >= 1 ? (fields[n2 - 1] ?? '') : '';
        const hit = re.test(f);
        return (op === '!~' ? !hit : hit) ? 'yes' : 'no';
      });
    } catch { return samples.map(() => '?'); }
  }
  return samples.map(() => '?');
}

function splitFields(line, fs) {
  if (line == null) return [];
  if (!fs) return line.trim().split(/\s+/).filter(Boolean);
  if (fs.length === 1) return line.split(fs);
  try {
    return line.split(new RegExp(fs));
  } catch {
    return line.split(fs);
  }
}

// Rainbow palette for pattern blocks #0..#N. BEGIN/END always phosphor green.
const BLOCK_PALETTE = ['#ff7ac6', '#ffcc66', '#6aaef0', '#c88aff', '#7affe6', '#ff9a6a'];
const GREEN = '#8aff80';
// Lit's `css` tagged template rejects raw-string interpolation as an
// anti-injection measure; wrap colours we want to reuse inside styles.
const GREEN_CSS = unsafeCSS(GREEN);

function nowHMS() {
  return new Date().toTimeString().slice(0, 8);
}

class AwApp extends LitElement {
  static properties = {
    status:        { state: true },
    inputs:        { state: true },
    limit:         { state: true },
    samples:       { state: true },
    sampleFile:    { state: true },
    sampleLineIx: { state: true },
    engines:       { state: true },
    engine:        { state: true },
    verifying:     { state: true },
    verifyRes:     { state: true },
    tab:           { state: true },
    viz:           { state: true },
    model:         { state: true },
    compiled:      { state: true },
    argv:          { state: true },
    issues:        { state: true },
    stdout:        { state: true },
    records:       { state: true },
    selected:      { state: true },
    running:       { state: true },
    exitCode:      { state: true },
    errMsg:        { state: true },
    openBlock:      { state: true },
    collapsed:      { state: true },
    showStems:      { state: true },
    syncAt:         { state: true },
    fsExpanded:     { state: true },
    otherExpanded:  { state: true },
    stdoutFull:     { state: true },
  };

  static styles = css`
    :host {
      display: block;
      position: relative;
      z-index: 3;
      color: ${GREEN_CSS};
      font-family: 'VT323', 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 18px;
      line-height: 1.3;
    }
    .frame {
      position: relative; z-index: 3;
      max-width: 1440px; margin: 0 auto;
      padding: 24px 32px 80px;
    }
    .glow { text-shadow: 0 0 2px rgba(138,255,128,0.9), 0 0 6px rgba(138,255,128,0.5); }
    .dim  { color: rgba(138,255,128,0.55); }
    .amber { color: #ffcc66; }
    .amber-glow { color: #ffcc66; text-shadow: 0 0 4px rgba(255,204,102,0.6); }
    .red   { color: #ff7a70; }
    .blue  { color: #6aaef0; }

    /* ======= head ======= */
    .head {
      display: flex; align-items: baseline; gap: 20px;
      border-bottom: 1px dashed rgba(138,255,128,0.4);
      padding-bottom: 10px; margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .brand { font-size: 30px; letter-spacing: 0.04em; }
    .brand .caret {
      display: inline-block; animation: blink 1.04s steps(1) infinite;
    }
    @keyframes blink { 50% { opacity: 0; } }
    .status-line { flex: 1 1 auto; min-width: 12rem; }
    .inputs-list { font-size: 16px; color: rgba(138,255,128,0.85); }

    /* ======= control bar ======= */
    .control-bar {
      display: flex; gap: 14px; align-items: center;
      flex-wrap: wrap; margin-bottom: 18px;
      text-shadow: 0 0 2px rgba(138,255,128,0.9), 0 0 6px rgba(138,255,128,0.5);
    }
    .control-bar .sep { color: rgba(138,255,128,0.35); }
    .stepper { min-width: 90px; text-align: center; color: rgba(138,255,128,0.55); }

    /* ======= buttons ======= */
    button.tb, button.tb-solid {
      background: transparent;
      border: 1px solid ${GREEN_CSS};
      color: ${GREEN_CSS};
      padding: 2px 12px;
      font-family: inherit; font-size: 18px; cursor: pointer;
      letter-spacing: 0.04em;
    }
    button.tb:hover { background: rgba(138,255,128,0.1); }
    button.tb:disabled { opacity: 0.4; cursor: not-allowed; }
    button.tb-solid {
      background: ${GREEN_CSS}; color: #050a05; font-weight: 700;
    }
    button.tb-solid:disabled { opacity: 0.5; cursor: not-allowed; }
    button.tb-small {
      background: transparent; border: 1px solid ${GREEN_CSS}; color: ${GREEN_CSS};
      padding: 1px 8px; font-family: inherit; font-size: 13px;
      cursor: pointer; letter-spacing: 0.04em;
    }
    button.tb-small:hover { background: rgba(138,255,128,0.1); }
    button.tb-red { border-color: #ff7a70; color: #ff7a70; }
    button.tb-amber { border-color: #ffcc66; color: #ffcc66; }

    select.tb {
      background: transparent;
      border: 1px solid rgba(138,255,128,0.45);
      color: ${GREEN_CSS}; font-family: inherit; font-size: 18px;
      padding: 1px 6px; cursor: pointer;
    }
    select.tb option { background: #050a05; }
    input.tb {
      background: rgba(0,0,0,0.5);
      border: 1px solid rgba(138,255,128,0.35);
      color: ${GREEN_CSS}; font-family: 'IBM Plex Mono', monospace;
      padding: 4px 6px; font-size: 13px; outline: none;
    }
    input.tb:focus { border-color: ${GREEN_CSS}; }

    /* ======= layout ======= */
    .grid {
      display: grid;
      grid-template-columns: 460px 1fr;
      gap: 28px; align-items: start;
    }
    @media (max-width: 1080px) { .grid { grid-template-columns: 1fr; } }
    .col { display: flex; flex-direction: column; gap: 14px; min-width: 0; }

    /* ======= boxes (ASCII bordered) ======= */
    .box {
      border: 1px solid rgba(138,255,128,0.45);
      padding: 10px 14px;
      background: rgba(0,0,0,0.15);
    }
    .box-title {
      display: flex; justify-content: space-between;
      border-bottom: 1px dashed rgba(138,255,128,0.3);
      padding-bottom: 4px; margin-bottom: 8px;
      color: rgba(138,255,128,0.8);
    }

    /* ======= FS helper ======= */
    .fs-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; align-items: center; }
    .fs-ruler {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 14px; line-height: 1.35;
      overflow-x: auto; max-width: 100%;
    }
    .fs-ruler > .row {
      display: flex; flex-wrap: nowrap; white-space: nowrap;
    }
    .fs-ruler .cell {
      display: inline-block;
      width: 1ch; text-align: center;
      font-family: 'IBM Plex Mono', monospace;
      font-size: 14px; line-height: 1.35;
      padding: 0; flex: 0 0 auto;
    }
    .fs-ruler .row.index .cell { color: rgba(138,255,128,0.45); }
    .fs-ruler .row.chars .cell { cursor: pointer; }
    .fs-ruler .row.chars .cell:hover { background: rgba(138,255,128,0.2); }
    .fs-ruler .row.chars .cell.fs { background: rgba(138,255,128,0.3); color: #050a05; }
    .chips { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px;
             font-family: 'IBM Plex Mono', monospace; font-size: 13px;
             min-width: 0; }
    .chip {
      border: 1px solid rgba(138,255,128,0.4); padding: 1px 6px;
      max-width: 100%;
      box-sizing: border-box;
      word-break: break-all;
      overflow-wrap: anywhere;
      line-height: 1.4;
    }
    .chip .n { color: rgba(138,255,128,0.6); }
    .chip.nf { border-color: #ffcc66; color: #ffcc66; white-space: nowrap; }

    /* ======= program editor ======= */
    .block {
      padding-left: 10px;
      margin-bottom: 8px; font-size: 14px;
      transition: opacity 150ms, filter 150ms;
    }
    .block.dimmed { opacity: 0.35; filter: saturate(0.4); }
    .block.open { background: rgba(138,255,128,0.04); }
    .block-head {
      display: flex; gap: 10px; align-items: baseline;
      color: rgba(138,255,128,0.8);
      cursor: pointer; user-select: none;
    }
    .block-head .tri { color: rgba(138,255,128,0.4); width: 10px; }
    .block-head .badge {
      text-transform: uppercase; letter-spacing: 0.1em;
      min-width: 60px; font-weight: 600;
    }
    .block-preview {
      color: #cfc; margin-top: 2px; padding-left: 20px;
      white-space: pre-wrap;
      font-family: 'IBM Plex Mono', monospace; font-size: 13px;
    }
    .block-editor {
      margin-top: 8px; padding-left: 20px;
      display: flex; flex-direction: column; gap: 8px;
    }
    .block-editor textarea {
      width: 100%; background: rgba(0,0,0,0.5);
      border: 1px solid rgba(138,255,128,0.35); color: #cfc;
      font-family: 'IBM Plex Mono', monospace; font-size: 13px;
      padding: 6px 8px; outline: none; resize: vertical; line-height: 1.5;
      box-sizing: border-box;
    }
    .block-editor input.pat {
      width: 100%; background: rgba(0,0,0,0.5);
      border: 1px solid rgba(138,255,128,0.35);
      font-family: 'IBM Plex Mono', monospace; font-size: 13px;
      padding: 6px 8px; outline: none; box-sizing: border-box;
    }
    .block-editor label {
      font-size: 11px; color: rgba(138,255,128,0.6); letter-spacing: 0.06em;
    }
    .mode-tabs {
      display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 6px;
    }
    .mode-tabs .mode-label {
      font-size: 11px; color: rgba(138,255,128,0.6);
      padding: 3px 8px; border: 1px solid rgba(138,255,128,0.25);
      letter-spacing: 0.1em;
    }
    .mode-btn {
      padding: 4px 10px; font-size: 12px;
      font-family: 'IBM Plex Mono', monospace;
      background: transparent; cursor: pointer;
    }
    .hint-row {
      display: flex; gap: 12px; align-items: center; margin-top: 6px;
      font-size: 12px; color: rgba(138,255,128,0.55); flex-wrap: wrap;
    }
    .match-strip { display: flex; gap: 2px; }
    .match-cell {
      width: 18px; height: 18px; display: inline-flex;
      align-items: center; justify-content: center;
      font-size: 11px; border: 1px solid rgba(138,255,128,0.25);
    }
    .block-actions-row {
      display: flex; gap: 6px; font-size: 12px; margin-top: 4px; align-items: center;
    }
    .add-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; position: relative; }
    .stem-menu {
      position: absolute; right: 0; top: 100%; margin-top: 4px; z-index: 10;
      background: #0a120a; border: 1px solid rgba(138,255,128,0.6);
      padding: 6px; min-width: 260px; font-size: 13px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.7);
    }
    .stem-menu .hdr {
      color: #ffcc66; font-size: 11px; padding: 4px 6px;
      border-bottom: 1px dashed rgba(138,255,128,0.25); margin-bottom: 4px;
    }
    .stem-menu .item {
      padding: 5px 8px; cursor: pointer; color: #cfc;
      font-family: 'IBM Plex Mono', monospace;
    }
    .stem-menu .item:hover { background: rgba(138,255,128,0.12); }

    /* ======= compiled ======= */
    .compiled-pre {
      margin: 0; font-family: 'IBM Plex Mono', monospace; font-size: 12px;
      color: #cfc; white-space: pre-wrap;
    }
    .argv-row {
      display: flex; gap: 10px; align-items: center; margin-top: 10px;
      font-size: 12px; font-family: 'IBM Plex Mono', monospace;
    }

    /* ======= lint ======= */
    .lint-item { font-size: 13px; margin-bottom: 4px; font-family: 'IBM Plex Mono', monospace; }
    .lint-item .sev { margin-right: 8px; }
    .lint-item .sev.warn { color: #ffcc66; }
    .lint-item .sev.info { color: #6aaef0; }
    .lint-item .snippet {
      color: rgba(138,255,128,0.45); padding-left: 16px;
      white-space: pre; font-size: 12px;
    }

    /* ======= tabs ======= */
    .tabs {
      display: flex; gap: 14px; align-items: center;
      border-bottom: 1px dashed rgba(138,255,128,0.35);
      padding-bottom: 4px; margin-bottom: 12px; flex-wrap: wrap;
    }
    .tab-btn {
      background: transparent; border: 0; cursor: pointer;
      font-family: inherit; font-size: 16px; letter-spacing: 0.12em;
      color: rgba(138,255,128,0.5);
      border-bottom: 2px solid transparent;
      padding: 2px 0; margin-bottom: -5px;
    }
    .tab-btn.active { color: ${GREEN_CSS}; border-bottom-color: ${GREEN_CSS}; }
    .tab-btn .count { margin-left: 6px; font-size: 13px;
                      color: rgba(138,255,128,0.45); }
    .tab-btn.active .count { color: #ffcc66; }
    .viz-toggle {
      display: flex; border: 1px solid rgba(138,255,128,0.45);
      margin-left: auto;
    }
    .viz-toggle button {
      background: transparent; color: ${GREEN_CSS}; border: 0;
      font-family: inherit; font-size: 14px; letter-spacing: 0.08em;
      padding: 2px 10px; cursor: pointer;
    }
    .viz-toggle button + button { border-left: 1px solid rgba(138,255,128,0.45); }
    .viz-toggle button.on { background: ${GREEN_CSS}; color: #050a05; font-weight: 700; }

    /* ======= trace teletype ======= */
    .teletype {
      border: 1px solid rgba(138,255,128,0.45);
      height: 360px; overflow-y: auto; padding: 6px 4px;
      font-family: 'IBM Plex Mono', monospace; font-size: 13px;
      background: rgba(0,0,0,0.3);
    }
    .file-hdr {
      position: sticky; top: 0; background: #050a05;
      border-top: 1px dashed rgba(138,255,128,0.35);
      border-bottom: 1px dashed rgba(138,255,128,0.35);
      padding: 4px 6px; color: #ffcc66; z-index: 2;
      cursor: pointer; user-select: none;
      display: flex; justify-content: space-between;
    }
    .file-hdr .count { color: rgba(255,204,102,0.6); font-size: 12px; }
    .rec {
      display: grid; grid-template-columns: 46px 46px 90px 1fr;
      gap: 10px; cursor: pointer; padding: 0 6px;
      white-space: nowrap; overflow: hidden;
    }
    .rec:hover { background: rgba(138,255,128,0.06); }
    .rec.sel  { background: rgba(138,255,128,0.12); }
    .rec .num { color: rgba(138,255,128,0.55); text-align: right; }
    .rec .dots { color: #ffcc66; letter-spacing: 0.3em; }
    .rec .dot { letter-spacing: 0.3em; }
    .rec .line { overflow: hidden; text-overflow: ellipsis; }

    /* ======= trace heatmap ======= */
    .heatmap {
      border: 1px solid rgba(138,255,128,0.45); padding: 12px;
      font-family: 'IBM Plex Mono', monospace; font-size: 12px;
      background: rgba(0,0,0,0.3);
    }
    .hm-file { margin-bottom: 14px; }
    .hm-lane { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
    .hm-lane .name { width: 140px; }
    .hm-cells { display: flex; gap: 1px; flex-wrap: wrap; }
    .hm-cell { width: 14px; height: 18px; cursor: pointer; }
    .hm-cell.sel { outline: 1px solid #ffcc66; }
    .hm-legend {
      color: rgba(138,255,128,0.5); margin-top: 8px; font-size: 11px;
    }

    /* ======= inspect ======= */
    .inspect-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px;
                    font-size: 14px; }
    .inspect-sub { color: rgba(138,255,128,0.55); margin-bottom: 4px; }
    .kv { font-family: 'IBM Plex Mono', monospace; font-size: 13px; line-height: 1.5; }
    .kv .k { color: rgba(138,255,128,0.55); display: inline-block; min-width: 7em; }

    /* ======= stdout / verify ======= */
    .out-wrap {
      border: 1px solid rgba(138,255,128,0.45);
      background: rgba(0,0,0,0.3);
      display: flex; flex-direction: column;
      max-height: 28rem;
    }
    .out-wrap.full {
      position: fixed; inset: 12px; z-index: 100;
      max-height: none; height: calc(100vh - 24px);
      background: #050a05;
      box-shadow: 0 0 40px rgba(138,255,128,0.25);
    }
    .out-toolbar {
      display: flex; align-items: center; gap: 10px;
      padding: 4px 10px;
      border-bottom: 1px dashed rgba(138,255,128,0.3);
      font-size: 13px; color: rgba(138,255,128,0.75);
      font-family: 'IBM Plex Mono', monospace;
      flex: 0 0 auto;
    }
    .out-toolbar .spacer { flex: 1; }
    .out-box {
      flex: 1 1 auto; overflow-y: auto; overflow-x: auto;
      padding: 10px 12px; min-height: 12rem;
      font-family: 'IBM Plex Mono', monospace; font-size: 13px;
      white-space: pre-wrap;
    }
    .out-wrap.full .out-box { min-height: 0; font-size: 14px; }
    .out-box .stderr { color: #ff7a70; }
    .out-box .stdout { color: #cfc; }
    .out-box .note   { color: rgba(138,255,128,0.5); font-style: italic; }

    .vr { border: 1px solid rgba(138,255,128,0.45); padding: 14px;
          font-family: 'IBM Plex Mono', monospace; font-size: 14px; }
    .vr.match   { border-left: 3px solid #8aff80; }
    .vr.nomatch { border-left: 3px solid #ff7a70; }
    .vr .badge {
      display: inline-block; padding: 0 10px; margin-right: 10px;
      font-weight: 700; color: #050a05;
    }
    .vr .badge.ok  { background: #8aff80; }
    .vr .badge.bad { background: #ff7a70; }
    .vr .diff {
      margin-top: 10px; background: rgba(0,0,0,0.4); padding: 8px;
      border: 1px solid rgba(138,255,128,0.3);
      max-height: 16rem; overflow: auto;
    }
    .vr .diff .minus { color: #ff7a70; }
    .vr .diff .plus  { color: #8aff80; }

    /* empty-state cards */
    .empty-card {
      border: 1px dashed rgba(138,255,128,0.35);
      padding: 40px; text-align: center;
      color: rgba(138,255,128,0.55);
    }

    .error-banner {
      border: 1px solid #ff7a70; color: #ff7a70;
      padding: 6px 10px; margin-bottom: 10px;
      font-family: 'IBM Plex Mono', monospace;
    }
  `;

  constructor() {
    super();
    this.status = 'connecting';
    this.inputs = [];
    this.limit = 0;
    this.samples = [];
    this.sampleFile = '';
    this.sampleLineIx = 0;
    this.engines = [];
    this.engine = '';
    this.verifying = false;
    this.verifyRes = null;
    this.tab = 'stdout';
    this.viz = 'teletype';
    this.model = STARTER_MODEL();
    this.compiled = '';
    this.argv = '';
    this.issues = [];
    this.stdout = [];
    this.records = [];
    this.selected = null;
    this.running = false;
    this.exitCode = null;
    this.errMsg = '';
    this.openBlock = null;
    this.collapsed = new Set();
    this.showStems = false;
    this.syncAt = '';
    this.fsExpanded = true;
    this.otherExpanded = false;
    this.stdoutFull = false;
    this._onKeyDown = (e) => {
      if (e.key === 'Escape' && this.stdoutFull) {
        this.stdoutFull = false;
      }
    };
    this._connect();
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('keydown', this._onKeyDown);
  }
  disconnectedCallback() {
    window.removeEventListener('keydown', this._onKeyDown);
    super.disconnectedCallback();
  }

  _connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this._ws = new WebSocket(`${proto}://${location.host}/ws`);
    this._ws.addEventListener('open',  () => { this.status = 'open'; this._compile(); });
    this._ws.addEventListener('close', () => { this.status = 'closed'; this.running = false; });
    this._ws.addEventListener('error', () => { this.status = 'error'; });
    this._ws.addEventListener('message', (e) => this._onMsg(JSON.parse(e.data)));
  }

  _onMsg(m) {
    switch (m.type) {
      case 'hello':
        this.inputs = m.inputs || [];
        this.limit = m.limit || 0;
        this.samples = m.samples || [];
        if (this.samples.length && !this.sampleFile) this.sampleFile = this.samples[0].filename;
        this.engines = m.engines || [];
        if (this.engines.length && !this.engine) this.engine = this.engines[0];
        break;
      case 'compiled':
        this.compiled = m.source ?? '';
        this.argv = m.argv ?? '';
        this.issues = m.issues ?? [];
        this.syncAt = nowHMS();
        break;
      case 'verify-result':
        this.verifying = false;
        this.verifyRes = m.verify ?? null;
        this.tab = 'verify';
        break;
      case 'stdout':
      case 'stderr':
        this.stdout = [...this.stdout, { kind: m.type, text: m.data ?? '' }];
        break;
      case 'record': {
        this.records = [...this.records, {
          filename: m.filename, fnr: m.fnr, nr: m.nr,
          line: m.line ?? '', patterns: [],
        }];
        if (this.selected == null) this.selected = 0;
        break;
      }
      case 'pattern': {
        const r = this.records[this.records.length - 1];
        if (r) r.patterns.push({ block: m.block, matched: !!m.matched, fired: false });
        this.requestUpdate();
        break;
      }
      case 'action-start': {
        const r = this.records[this.records.length - 1];
        const p = r?.patterns.find(p => p.block === m.block);
        if (p) p.fired = true;
        this.requestUpdate();
        break;
      }
      case 'action-end': break;
      case 'done':
        this.exitCode = m.code ?? 0;
        this.running = false;
        this.stdout = [...this.stdout, { kind: 'note', text: `-- exit ${this.exitCode} --` }];
        break;
      case 'error':
        this.errMsg = m.message ?? '';
        this.running = false;
        break;
    }
  }

  _sendModel(type) {
    if (this._ws?.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify({ type, model: this.model }));
  }
  _compile() { this._sendModel('compile'); }
  _run() {
    if (this.status !== 'open' || this.running) return;
    this.stdout = []; this.records = []; this.selected = null;
    this.exitCode = null; this.errMsg = '';
    this.running = true;
    this.tab = 'stdout';
    this._sendModel('run');
  }
  _verify() {
    if (this.status !== 'open' || this.verifying || !this.engine) return;
    this.verifying = true;
    this.verifyRes = null;
    this._ws.send(JSON.stringify({ type: 'verify', model: this.model, engine: this.engine }));
  }

  _updateModel(fn) {
    const next = structuredClone(this.model);
    fn(next);
    this.model = next;
    this._compile();
  }
  _setFlag(k, v) { this._updateModel(m => { m.flags[k] = v; }); }
  _setBlock(i, patch) { this._updateModel(m => { Object.assign(m.blocks[i], patch); }); }
  _removeBlock(i) {
    this._updateModel(m => { m.blocks.splice(i, 1); });
    if (this.openBlock === i) this.openBlock = null;
  }
  _moveBlock(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= this.model.blocks.length) return;
    this._updateModel(m => { [m.blocks[i], m.blocks[j]] = [m.blocks[j], m.blocks[i]]; });
    if (this.openBlock === i) this.openBlock = j;
    else if (this.openBlock === j) this.openBlock = i;
  }
  _addBlock(kind, extra = {}) {
    let insertAt = -1;
    this._updateModel(m => {
      const block = { kind, action: '', ...extra };
      if (kind === 'pattern' && !('pattern' in block)) block.pattern = '';
      if (kind === 'begin') {
        const ix = m.blocks.findIndex(b => b.kind !== 'begin');
        insertAt = ix < 0 ? m.blocks.length : ix;
        m.blocks.splice(insertAt, 0, block);
      } else if (kind === 'end') {
        insertAt = m.blocks.length;
        m.blocks.push(block);
      } else {
        const ix = m.blocks.findIndex(b => b.kind === 'end');
        insertAt = ix < 0 ? m.blocks.length : ix;
        m.blocks.splice(insertAt, 0, block);
      }
    });
    this.openBlock = insertAt;
  }

  _patternBlocks() {
    return this.model.blocks
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.kind === 'pattern');
  }
  _patternRank(i) {
    let rank = 0;
    for (let j = 0; j < i; j++) if (this.model.blocks[j].kind === 'pattern') rank++;
    return rank;
  }
  _blockColor(i) {
    const b = this.model.blocks[i];
    if (!b || b.kind !== 'pattern') return GREEN;
    return BLOCK_PALETTE[this._patternRank(i) % BLOCK_PALETTE.length];
  }

  _currentSample() {
    const s = this.samples.find(s => s.filename === this.sampleFile) ?? this.samples[0];
    if (!s || !s.lines?.length) return '';
    const ix = Math.max(0, Math.min(s.lines.length - 1, this.sampleLineIx || 0));
    return s.lines[ix] ?? '';
  }
  _previewSamples() {
    const f = this.samples.find(s => s.filename === this.sampleFile) ?? this.samples[0];
    return (f?.lines ?? []).slice(0, 5);
  }

  _applyTemplate(id) {
    if (!id) return;
    const t = TEMPLATES.find(x => x.id === id);
    if (!t) return;
    this._updateModel(m => {
      for (const b of t.blocks) {
        const block = structuredClone(b);
        if (block.kind === 'begin') {
          const ix = m.blocks.findIndex(bb => bb.kind !== 'begin');
          m.blocks.splice(ix < 0 ? m.blocks.length : ix, 0, block);
        } else if (block.kind === 'end') {
          m.blocks.push(block);
        } else {
          const ix = m.blocks.findIndex(bb => bb.kind === 'end');
          m.blocks.splice(ix < 0 ? m.blocks.length : ix, 0, block);
        }
      }
    });
  }

  _stepRecord(d) {
    if (!this.records.length) return;
    const next = (this.selected ?? -1) + d;
    this.selected = Math.max(0, Math.min(this.records.length - 1, next));
    this.updateComplete.then(() => this._scrollToSelected());
  }
  _scrollToSelected() {
    const root = this.renderRoot;
    const el = root?.querySelector(`.rec[data-idx="${this.selected}"]`);
    const scroll = root?.querySelector('.teletype');
    if (el && scroll) {
      const top = el.offsetTop - 60;
      scroll.scrollTop = top;
    }
  }
  _toggleFile(f) {
    const n = new Set(this.collapsed);
    n.has(f) ? n.delete(f) : n.add(f);
    this.collapsed = n;
  }

  // ------- render ---------------------------------------------------------

  render() {
    return html`
      <div class="frame">
        ${this.renderHead()}
        ${this.renderControlBar()}
        ${this.inputs.length
          ? html`
              <div class="grid">
                <div class="col">
                  ${this.renderFSHelper()}
                  ${this.renderOtherFlags()}
                  ${this.renderProgram()}
                  ${this.renderCompiled()}
                  ${this.renderLint()}
                </div>
                <div class="col">
                  ${this.renderTabs()}
                  ${this.renderTabContent()}
                </div>
              </div>`
          : this.renderNoInputs()}
      </div>
    `;
  }

  renderHead() {
    const dot =
      this.status === 'open' ? GREEN :
      this.status === 'error' ? '#ff7a70' : '#ffcc66';
    return html`
      <div class="head glow">
        <div class="brand">awkbuilder<span class="caret">_</span></div>
        <div class="status-line dim">
          v0.1 · POSIX awk builder ·
          <span style="color:${dot}">●</span> ws://${location.host}
          ${this.syncAt ? html` · <span class="dim">synced ${this.syncAt}</span>` : ''}
        </div>
        <div class="inputs-list">${this.inputs.join(' · ') || '(no inputs)'}</div>
        <div class="dim">limit ${this.limit > 0 ? this.limit : '∞'}/file</div>
      </div>
    `;
  }

  renderControlBar() {
    const hasRecs = this.records.length > 0;
    return html`
      <div class="control-bar">
        <span class="dim">status</span>
        <span>
          <span style="color:${GREEN};margin-right:4px">●</span>
          ${this.running ? 'RUNNING…'
            : this.errMsg ? html`<span class="red">ERROR</span>`
            : this.exitCode !== null ? `DONE · exit ${this.exitCode}`
            : 'READY'}
        </span>
        <span class="sep">│</span>
        <button class="tb" ?disabled=${!hasRecs} @click=${() => this._stepRecord(-1)}>◂ prev</button>
        <span class="stepper">
          ${hasRecs ? `${(this.selected ?? 0) + 1} / ${this.records.length}` : '– / –'}
        </span>
        <button class="tb" ?disabled=${!hasRecs} @click=${() => this._stepRecord(1)}>next ▸</button>
        <span class="sep">│</span>
        <button class="tb-solid"
          ?disabled=${this.status !== 'open' || this.running || !this.inputs.length}
          @click=${this._run}>
          ${this.running ? '… running' : '▶ run'}
        </button>
        ${this.engines.length ? html`
          <button class="tb"
            ?disabled=${this.status !== 'open' || this.verifying || !this.inputs.length}
            @click=${this._verify}>
            ${this.verifying ? 'verifying…' : '✓ verify'}
          </button>
          <select class="tb" .value=${this.engine}
            @change=${(e) => this.engine = e.target.value}>
            ${this.engines.map(e => html`<option value=${e} ?selected=${e === this.engine}>${e}</option>`)}
          </select>
        ` : ''}
      </div>
      ${this.errMsg ? html`<div class="error-banner">${this.errMsg}</div>` : ''}
    `;
  }

  renderNoInputs() {
    return html`
      <div class="empty-card" style="margin-top:40px">
        <div style="font-size:24px;margin-bottom:8px" class="glow">no inputs</div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:14px;color:rgba(138,255,128,0.7)">
          $ awkbuilder <span class="amber">samples/access.log</span> <span class="amber">samples/users.csv</span>
        </div>
      </div>
    `;
  }

  // ===== FS HELPER ========================================================
  renderFSHelper() {
    const sample = this._currentSample();
    const fs = this.model.flags.fs ?? '';
    const fields = splitFields(sample, fs);
    const currentSample = this.samples.find(s => s.filename === this.sampleFile) ?? this.samples[0];
    const lineOptions = currentSample?.lines ?? [];
    const exp = this.fsExpanded;
    return html`
      <div class="box">
        <div class="box-title" style="cursor:pointer;user-select:none"
          @click=${() => this.fsExpanded = !exp}>
          <span>
            <span class="dim" style="margin-right:6px">${exp ? '▾' : '▸'}</span>
            ╔═ FS HELPER ═╗
          </span>
          <span class="amber">FS = ${fs === '' ? '(ws)' : JSON.stringify(fs)}</span>
        </div>
        <div class="fs-row" @click=${(e) => e.stopPropagation()}>
          ${FS_PRESETS.map(p => html`
            <button class="tb-small"
              style=${fs === p.value ? 'background:rgba(138,255,128,0.25)' : ''}
              @click=${() => this._setFlag('fs', p.value)}>
              ${p.label}
            </button>
          `)}
          <input class="tb" style="width:110px" placeholder="custom/regex"
            .value=${fs} @input=${(e) => this._setFlag('fs', e.target.value)}>
        </div>
        ${exp && this.samples.length ? html`
          <div class="fs-row" style="font-size:14px">
            <span class="dim">sample:</span>
            <select class="tb" style="font-size:14px"
              @change=${(e) => { this.sampleFile = e.target.value; this.sampleLineIx = 0; }}>
              ${this.samples.map(s => html`
                <option value=${s.filename} ?selected=${s.filename === this.sampleFile}>${s.filename}</option>
              `)}
            </select>
            <select class="tb" style="font-size:14px"
              @change=${(e) => { this.sampleLineIx = Number(e.target.value); }}>
              ${lineOptions.map((_, i) => html`
                <option value=${i} ?selected=${i === this.sampleLineIx}>line ${i + 1}</option>
              `)}
            </select>
            <span class="dim">— click a char →</span>
          </div>
          ${this.renderRuler(sample, fs)}
          <div class="chips">
            ${fields.map((v, i) => html`
              <span class="chip">
                <span class="n">$${i + 1} </span>${v === '' ? '∅' : v}
              </span>
            `)}
            <span class="chip nf">NF=${fields.length}</span>
          </div>
        ` : ''}
      </div>
    `;
  }
  renderRuler(line, fs) {
    const chars = [...line];
    if (!chars.length) return html`<div class="dim" style="font-size:14px">(no sample)</div>`;
    // Keep the content of each <span> whitespace-tight; any newline in the
    // Lit template between ">" and the char becomes a rendered newline in
    // the DOM (which was blowing out the row vertically).
    return html`
      <div class="fs-ruler">
        <div class="row index">${chars.map((_, i) => html`<span class="cell">${(i + 1) % 10}</span>`)}</div>
        <div class="row chars">${chars.map(ch => html`<span class="cell ${ch === fs ? 'fs' : ''}" title=${'FS = ' + JSON.stringify(ch)} @click=${() => this._setFlag('fs', ch)}>${ch === ' ' ? '·' : ch}</span>`)}</div>
      </div>
    `;
  }

  // ===== OTHER FLAGS (OFS / RS / ORS) ====================================
  renderOtherFlags() {
    const f = this.model.flags;
    const summary = [];
    if (f.ofs) summary.push(`OFS=${JSON.stringify(f.ofs)}`);
    if (f.rs)  summary.push(`RS=${JSON.stringify(f.rs)}`);
    if (f.ors) summary.push(`ORS=${JSON.stringify(f.ors)}`);
    const exp = this.otherExpanded;
    return html`
      <div class="box">
        <div class="box-title" style="cursor:pointer;user-select:none"
          @click=${() => this.otherExpanded = !exp}>
          <span>
            <span class="dim" style="margin-right:6px">${exp ? '▾' : '▸'}</span>
            ╔═ OFS · RS · ORS ═╗
          </span>
          <span class=${summary.length ? 'amber' : 'dim'}>
            ${summary.length ? summary.join(' · ') : 'defaults'}
          </span>
        </div>
        ${exp ? html`
          <div class="fs-row" style="font-size:14px"
            @click=${(e) => e.stopPropagation()}>
            ${[
              ['OFS', 'ofs', 'output field sep (default " ")'],
              ['RS',  'rs',  'input record sep (default "\\n")'],
              ['ORS', 'ors', 'output record sep (default "\\n")'],
            ].map(([label, key, hint]) => html`
              <label style="display:flex;flex-direction:column;gap:2px;font-size:12px">
                <span class="dim">${label} <span style="font-style:italic;color:rgba(138,255,128,0.4)">— ${hint}</span></span>
                <input class="tb" style="width:6rem"
                  .value=${f[key] ?? ''}
                  @input=${(e) => this._setFlag(key, e.target.value)}>
              </label>
            `)}
          </div>
        ` : ''}
      </div>
    `;
  }

  // ===== PROGRAM ==========================================================
  renderProgram() {
    return html`
      <div class="box">
        <div class="box-title">
          <span>╔═ PROGRAM ═╗</span>
          <span class="dim">${this.model.blocks.length} blocks · click row to edit</span>
        </div>
        ${this.model.blocks.map((b, i) => this.renderBlockRow(b, i))}
        ${this.renderAddRow()}
      </div>
    `;
  }

  renderBlockRow(b, i) {
    const isOpen = this.openBlock === i;
    const anyOpen = this.openBlock !== null;
    const dimmed = anyOpen && !isOpen;
    const col = this._blockColor(i);
    const isPat = b.kind === 'pattern';
    const rank = isPat ? this._patternRank(i) : -1;
    return html`
      <div class="block ${isOpen ? 'open' : ''} ${dimmed ? 'dimmed' : ''}"
        style="border-left:3px solid ${col}">
        <div class="block-head"
          @click=${() => this.openBlock = isOpen ? null : i}>
          <span class="tri">${isOpen ? '▾' : '▸'}</span>
          <span class="badge"
            style="color:${col};text-shadow:0 0 4px ${col}60">
            ${isPat ? `#${rank}` : b.kind}
          </span>
          <span class="dim" style="font-family:'IBM Plex Mono',monospace">
            ${b.kind === 'pattern' ? (b.pattern || '(always)') : '—'}
          </span>
          ${b.label ? html`<span class="amber" style="font-size:12px">· ${b.label}</span>` : ''}
        </div>
        ${isOpen
          ? this.renderBlockEditor(b, i, col)
          : html`<div class="block-preview">{ ${b.action || '(default print)'} }</div>`}
      </div>
    `;
  }

  renderBlockEditor(b, i, col) {
    const isPat = b.kind === 'pattern';
    const mode = b.patternMode || inferMode(b.pattern ?? '');
    const parts = parsePattern(mode, b.pattern ?? '');
    const modeMeta = PATTERN_MODES.find(m => m.id === mode) ?? PATTERN_MODES[0];
    const setPart = (key, value) => {
      const next = { ...parts, [key]: value };
      this._setBlock(i, { patternMode: mode, pattern: serializePattern(mode, next) });
    };
    const setMode = (newMode) => {
      const rep = parsePattern(newMode, b.pattern ?? '');
      this._setBlock(i, { patternMode: newMode, pattern: serializePattern(newMode, rep) });
    };
    return html`
      <div class="block-editor">
        ${isPat ? this.renderPatternEditor(b, i, col, mode, parts, modeMeta, setPart, setMode) : ''}
        <label>
          ACTION { ... }
          <textarea spellcheck="false"
            rows=${Math.max(5, (b.action || '').split('\n').length + 1)}
            .value=${b.action || ''}
            @input=${(e) => this._setBlock(i, { action: e.target.value })}></textarea>
        </label>
        <label>
          LABEL (optional)
          <input type="text" class="pat"
            style="color:#ffcc66"
            .value=${b.label || ''}
            @input=${(e) => this._setBlock(i, { label: e.target.value })}>
        </label>
        <div class="block-actions-row">
          <button class="tb-small" @click=${() => this._moveBlock(i, -1)}>↑ up</button>
          <button class="tb-small" @click=${() => this._moveBlock(i, 1)}>↓ down</button>
          <button class="tb-small tb-red" @click=${() => this._removeBlock(i)}>✕ delete</button>
          <span style="flex:1"></span>
          <span class="dim" style="font-size:11px">click row again to collapse</span>
        </div>
      </div>
    `;
  }

  renderPatternEditor(_b, _i, col, mode, parts, modeMeta, setPart, setMode) {
    const samples = this._previewSamples();
    const verdict = previewMatches(mode, parts, samples, this.model.flags.fs ?? '');
    return html`
      <div>
        <div class="mode-tabs">
          <span class="mode-label">PATTERN</span>
          ${PATTERN_MODES.map(m => {
            const active = m.id === mode;
            return html`
              <button class="mode-btn"
                style="${active
                  ? `background:${col};color:#050a05;border:1px solid ${col};font-weight:700`
                  : `background:transparent;color:${col};border:1px solid ${col}60`}"
                @click=${() => setMode(m.id)}>${m.label}</button>
            `;
          })}
          <span style="flex:1"></span>
          <button class="tb-small" @click=${() => this.openBlock = null}>✕</button>
        </div>
        ${this.renderPatternInputs(mode, parts, setPart, col)}
        <div class="hint-row">
          <span style="font-style:italic">${modeMeta.hint}</span>
          <span style="flex:1"></span>
          ${samples.length ? html`
            <span>sample matches:</span>
            <span class="match-strip">
              ${samples.map((s, idx) => {
                const v = verdict[idx];
                const hit = v === 'yes';
                return html`
                  <span class="match-cell" title=${s}
                    style="border-color:${hit ? col : 'rgba(138,255,128,0.25)'};
                           background:${hit ? col + '30' : 'transparent'};
                           color:${hit ? col : 'rgba(138,255,128,0.3)'}">
                    ${v === 'yes' ? '✓' : v === 'no' ? '·' : '?'}
                  </span>
                `;
              })}
            </span>
          ` : ''}
        </div>
      </div>
    `;
  }

  renderPatternInputs(mode, parts, setPart, col) {
    const baseStyle = `border-color:${col}60;color:${col}`;
    switch (mode) {
      case 'always':
        return html`<div class="dim" style="padding:4px 0;font-style:italic">matches every record</div>`;
      case 'expr':
        return html`<input type="text" class="pat" spellcheck="false"
          style="${baseStyle}" placeholder="e.g. NR==1 && $3 > 100"
          .value=${parts.expr ?? ''}
          @input=${(e) => setPart('expr', e.target.value)}>`;
      case 'regex':
        return html`
          <div style="display:flex;gap:4px;align-items:center">
            <span style="color:${col}">/</span>
            <input type="text" class="pat" style="${baseStyle}"
              placeholder="regex matched against $0" spellcheck="false"
              .value=${parts.regex ?? ''}
              @input=${(e) => setPart('regex', e.target.value)}>
            <span style="color:${col}">/</span>
          </div>`;
      case 'field':
        return html`
          <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">
            <span style="color:${col}">$</span>
            <input type="text" class="pat" style="${baseStyle};width:3rem;flex:0 0 auto"
              placeholder="1" .value=${parts.field ?? ''}
              @input=${(e) => setPart('field', e.target.value)}>
            <select class="tb" style="font-size:13px"
              @change=${(e) => setPart('op', e.target.value)}>
              <option value="~"  ?selected=${(parts.op ?? '~') === '~'}>~ matches</option>
              <option value="!~" ?selected=${parts.op === '!~'}>!~ doesn't</option>
            </select>
            <span style="color:${col}">/</span>
            <input type="text" class="pat" style="${baseStyle};flex:1;min-width:6rem"
              placeholder="regex" spellcheck="false"
              .value=${parts.regex ?? ''}
              @input=${(e) => setPart('regex', e.target.value)}>
            <span style="color:${col}">/</span>
          </div>`;
      case 'range':
        return html`
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <span class="dim" style="font-size:12px">from</span>
            <span style="color:${col}">/</span>
            <input type="text" class="pat" style="${baseStyle};flex:1;min-width:6rem"
              placeholder="start regex" spellcheck="false"
              .value=${parts.startRegex ?? ''}
              @input=${(e) => setPart('startRegex', e.target.value)}>
            <span style="color:${col}">/</span>
            <span class="dim" style="font-size:12px">to</span>
            <span style="color:${col}">/</span>
            <input type="text" class="pat" style="${baseStyle};flex:1;min-width:6rem"
              placeholder="end regex" spellcheck="false"
              .value=${parts.endRegex ?? ''}
              @input=${(e) => setPart('endRegex', e.target.value)}>
            <span style="color:${col}">/</span>
          </div>`;
      default:
        return html``;
    }
  }

  renderAddRow() {
    return html`
      <div class="add-row">
        <button class="tb-small"
          style="color:${GREEN};border-color:${GREEN}60"
          @click=${() => this._addBlock('begin', { action: '# setup\n' })}>+ BEGIN</button>
        <button class="tb-small"
          @click=${() => this._addBlock('pattern', { patternMode: 'always', pattern: '', action: 'print $0', label: 'new rule' })}>+ /pattern/</button>
        <button class="tb-small tb-red"
          @click=${() => this._addBlock('end', { action: '# summary\n' })}>+ END</button>
        <button class="tb-small" @click=${() => this.showStems = !this.showStems}>+ stem ▾</button>
        <span style="flex:1"></span>
        <select class="tb" style="font-size:13px"
          @change=${(e) => { this._applyTemplate(e.target.value); e.target.value = ''; }}>
          <option value="">+ template…</option>
          ${TEMPLATES.map(t => html`<option value=${t.id}>${t.name}</option>`)}
        </select>
        ${this.showStems ? html`
          <div class="stem-menu">
            <div class="hdr">COMMON STEMS</div>
            <div class="item" @click=${() => {
              this._addBlock('pattern', { patternMode: 'range', pattern: '/BEGIN/, /END/', action: 'print', label: 'range' });
              this.showStems = false;
            }}>/BEGIN/, /END/ range</div>
            <div class="item" @click=${() => {
              this._addBlock('pattern', { patternMode: 'field', pattern: '$3 ~ /value/', action: 'print $1, $2', label: 'field match' });
              this.showStems = false;
            }}>$3 ~ /value/ match</div>
            <div class="item" @click=${() => {
              this._addBlock('pattern', { patternMode: 'expr', pattern: 'NR > 1', action: 'print', label: 'skip header' });
              this.showStems = false;
            }}>NR > 1 (skip header)</div>
          </div>
        ` : ''}
      </div>
    `;
  }

  // ===== COMPILED =========================================================
  renderCompiled() {
    return html`
      <div class="box">
        <div class="box-title">
          <span>╔═ COMPILED ═╗</span>
          <span class="dim">program.awk</span>
        </div>
        <pre class="compiled-pre">${this.compiled || '(empty)'}</pre>
        <div class="argv-row">
          <span class="amber">$ ${this.argv} ${this.inputs.join(' ')}</span>
          <span style="flex:1"></span>
          ${this.syncAt
            ? html`<span class="dim">✓ on CLI · ${this.syncAt}</span>`
            : html`<span class="dim">—</span>`}
        </div>
      </div>
    `;
  }

  // ===== LINT =============================================================
  renderLint() {
    const warnCount = this.issues.filter(i => i.severity === 'warn').length;
    return html`
      <div class="box">
        <div class="box-title">
          <span>╔═ POSIX LINT ═╗</span>
          <span style="color:${warnCount > 0 ? '#ffcc66' : GREEN}">
            ${this.issues.length ? `${warnCount} warn · ${this.issues.length - warnCount} info` : 'clean'}
          </span>
        </div>
        ${this.issues.length
          ? this.issues.map(it => html`
              <div class="lint-item">
                <span class="sev ${it.severity}">[${it.severity}]</span>
                <span class="dim">${it.line}:${it.col}</span>
                <span class="blue">${it.rule}</span>
                <span>${it.message}</span>
                ${it.snippet ? html`<div class="snippet">${it.snippet}</div>` : ''}
              </div>
            `)
          : html`<div class="dim" style="font-style:italic">no non-POSIX constructs detected</div>`}
      </div>
    `;
  }

  // ===== TABS + TRACE =====================================================
  renderTabs() {
    const tabs = [
      { id: 'stdout', l: 'STDOUT', c: this.stdout.length ? this.stdout.length : null },
      { id: 'trace',  l: 'TRACE',  c: this.records.length ? this.records.length : null },
      { id: 'verify', l: 'VERIFY', c: this.verifyRes ? (this.verifyRes.match ? 'ok' : 'differs') : null },
    ];
    return html`
      <div class="tabs">
        ${tabs.map(t => html`
          <button class="tab-btn ${this.tab === t.id ? 'active' : ''}"
            @click=${() => this.tab = t.id}>
            ${t.l}${t.c != null ? html`<span class="count">[${t.c}]</span>` : ''}
          </button>
        `)}
        ${this.tab === 'trace' ? html`
          <div class="viz-toggle">
            <button class=${this.viz === 'teletype' ? 'on' : ''}
              @click=${() => this.viz = 'teletype'}>TELETYPE</button>
            <button class=${this.viz === 'heatmap' ? 'on' : ''}
              @click=${() => this.viz = 'heatmap'}>HEATMAP</button>
          </div>
        ` : ''}
      </div>
    `;
  }

  renderTabContent() {
    if (this.tab === 'trace')  return this.renderTraceTab();
    if (this.tab === 'stdout') return this.renderStdoutTab();
    if (this.tab === 'verify') return this.renderVerifyTab();
    return '';
  }

  renderTraceTab() {
    if (!this.records.length) {
      return html`
        <div class="empty-card">
          no records. hit <span class="glow">▶ run</span> to stream.
        </div>`;
    }
    return html`
      ${this.viz === 'teletype' ? this.renderTraceTeletype() : this.renderTraceHeatmap()}
      ${this.records[this.selected] ? this.renderInspect() : ''}
    `;
  }

  renderTraceTeletype() {
    const patternBlocks = this._patternBlocks();
    const fileCounts = {};
    for (const r of this.records) fileCounts[r.filename] = (fileCounts[r.filename] || 0) + 1;
    const out = [];
    let lastFile = null;
    this.records.forEach((r, idx) => {
      if (r.filename !== lastFile) {
        lastFile = r.filename;
        const isCollapsed = this.collapsed.has(r.filename);
        out.push(html`
          <div class="file-hdr" @click=${(e) => { e.stopPropagation(); this._toggleFile(r.filename); }}>
            <span>${isCollapsed ? '[+]' : '[−]'} FILE ${r.filename}</span>
            <span class="count">${fileCounts[r.filename]} rec</span>
          </div>
        `);
        if (isCollapsed) return;
      } else if (this.collapsed.has(r.filename)) {
        return;
      }
      const cells = patternBlocks.map((_, pi) => {
        const hit = r.patterns.find(p => p.block === pi);
        const col = BLOCK_PALETTE[pi % BLOCK_PALETTE.length];
        if (hit?.fired)    return html`<span class="dot" style="color:${col};text-shadow:0 0 4px ${col}">*</span>`;
        if (hit?.matched) return html`<span class="dot" style="color:${col};opacity:0.55">~</span>`;
        return html`<span class="dot" style="color:rgba(138,255,128,0.25)">.</span>`;
      });
      out.push(html`
        <div class="rec ${this.selected === idx ? 'sel' : ''}" data-idx=${idx}
          @click=${() => this.selected = idx}>
          <span class="num">${String(r.nr).padStart(3,'0')}</span>
          <span class="num">${String(r.fnr).padStart(3,'0')}</span>
          <span class="dots">[${cells}]</span>
          <span class="line">${r.line}</span>
        </div>
      `);
    });
    return html`<div class="teletype">${out}</div>`;
  }

  renderTraceHeatmap() {
    const patternBlocks = this._patternBlocks();
    const files = [...new Set(this.records.map(r => r.filename))];
    return html`
      <div class="heatmap">
        ${files.map(f => {
          const rs = this.records.map((r, i) => ({ r, i })).filter(({ r }) => r.filename === f);
          const isCollapsed = this.collapsed.has(f);
          return html`
            <div class="hm-file">
              <div class="file-hdr" style="margin-bottom:4px"
                @click=${() => this._toggleFile(f)}>
                <span>${isCollapsed ? '[+]' : '[−]'} ── ${f} · ${rs.length} rec</span>
              </div>
              ${!isCollapsed ? patternBlocks.map(({ b }, pi) => {
                const col = BLOCK_PALETTE[pi % BLOCK_PALETTE.length];
                const label = b.label || 'block';
                return html`
                  <div class="hm-lane">
                    <span class="name" style="color:${col};text-shadow:0 0 4px ${col}60">
                      #${pi} ${label}
                    </span>
                    <div class="hm-cells">
                      ${rs.map(({ r, i: idx }) => {
                        const hit = r.patterns.find(p => p.block === pi);
                        const bg = hit?.fired ? col : hit?.matched ? `${col}40` : '#1a2a18';
                        const sel = this.selected === idx;
                        return html`
                          <div class="hm-cell ${sel ? 'sel' : ''}"
                            style="background:${bg};box-shadow:${hit?.fired ? `0 0 4px ${col}80` : 'none'}"
                            title=${`NR=${r.nr} ${hit?.fired ? 'fired' : hit?.matched ? 'matched' : 'miss'}`}
                            @click=${() => this.selected = idx}></div>
                        `;
                      })}
                    </div>
                  </div>
                `;
              }) : ''}
            </div>
          `;
        })}
        <div class="hm-legend">■ fired  ■ matched but suppressed  ■ miss  ·  click a cell → inspect</div>
      </div>
    `;
  }

  renderInspect() {
    const r = this.records[this.selected];
    const fs = this.model.flags.fs ?? '';
    const fields = splitFields(r.line, fs);
    const patternBlocks = this._patternBlocks();
    return html`
      <div class="box" style="margin-top:14px">
        <div class="box-title">
          <span>╔═ INSPECT ═╗</span>
          <span class="amber">${r.filename} · NR=${r.nr} · FNR=${r.fnr}</span>
        </div>
        <div class="inspect-grid">
          <div>
            <div class="inspect-sub">── VARIABLES ──</div>
            <div class="kv">
              <div><span class="k">FILENAME</span>${r.filename}</div>
              <div><span class="k">NR</span>${r.nr}</div>
              <div><span class="k">FNR</span>${r.fnr}</div>
              <div><span class="k">NF</span>${fields.length}</div>
              <div><span class="k">FS</span>${JSON.stringify(fs)}</div>
              <div><span class="k">$0</span>${r.line}</div>
            </div>
            <div class="inspect-sub" style="margin-top:10px">── FIELDS ──</div>
            <div class="kv">
              ${fields.map((v, i) => html`
                <div><span style="color:#6aaef0">$${i + 1} </span>${v === '' ? html`<span class="dim">∅</span>` : v}</div>
              `)}
            </div>
          </div>
          <div>
            <div class="inspect-sub">── PATTERNS ──</div>
            <div class="kv">
              ${patternBlocks.map(({ b }, pi) => {
                const hit = r.patterns.find(p => p.block === pi);
                const status = hit?.fired ? 'FIRED' : hit?.matched ? 'MATCHED' : 'miss';
                const col = hit?.fired ? GREEN : hit?.matched ? '#ffcc66' : 'rgba(138,255,128,0.35)';
                const blockCol = BLOCK_PALETTE[pi % BLOCK_PALETTE.length];
                return html`
                  <div>
                    <span style="color:${blockCol}">#${pi} </span>
                    <span style="color:${col};display:inline-block;min-width:5em">${status}</span>
                    <span class="dim">${b.pattern || '(always)'} { ${b.action} }</span>
                  </div>
                `;
              })}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ===== STDOUT / VERIFY ==================================================
  renderStdoutTab() {
    const full = this.stdoutFull;
    const lineCount = this.stdout.filter(l => l.kind !== 'note').length;
    const errCount  = this.stdout.filter(l => l.kind === 'stderr').length;
    return html`
      <div class="out-wrap ${full ? 'full' : ''}">
        <div class="out-toolbar">
          <span class="dim">STDOUT / STDERR</span>
          <span class="dim">·</span>
          <span>${lineCount} lines${errCount ? html` · <span class="red">${errCount} stderr</span>` : ''}</span>
          <span class="spacer"></span>
          ${full ? html`<span class="dim" style="font-size:11px">esc to close</span>` : ''}
          <button class="tb-small"
            @click=${() => this.stdoutFull = !full}
            title=${full ? 'exit fullscreen' : 'fullscreen'}>
            ${full ? '⛌ close' : '⛶ expand'}
          </button>
        </div>
        <div class="out-box">
          ${this.stdout.length
            ? this.stdout.map(l => html`<div class=${l.kind}>${l.text}</div>`)
            : html`<span class="note">no output yet — hit ▶ run</span>`}
        </div>
      </div>
    `;
  }

  renderVerifyTab() {
    const r = this.verifyRes;
    if (!r) {
      return html`
        <div class="vr" style="border-left:3px solid rgba(138,255,128,0.35)">
          <span class="dim">click <b>✓ verify</b> in the top bar to run the program under system awk
            and diff its stdout against goawk.</span>
        </div>`;
    }
    if (r.error) {
      return html`
        <div class="vr nomatch">
          <div><span class="badge bad">error</span>engine: ${r.engine}</div>
          <div style="margin-top:6px">${r.error}</div>
        </div>`;
    }
    return html`
      <div class="vr ${r.match ? 'match' : 'nomatch'}">
        <div>
          <span class="badge ${r.match ? 'ok' : 'bad'}">${r.match ? 'MATCH' : 'DIFFERS'}</span>
          engine: <b>${r.engine}</b>
          <span class="dim"> · exit ${r.exitCode}${r.diffSummary ? ' · ' + r.diffSummary : ''}</span>
        </div>
        ${r.systemStderr ? html`<div class="red" style="margin-top:6px">stderr: ${r.systemStderr}</div>` : ''}
        ${(!r.match && r.diff?.length) ? html`
          <div class="diff">
            ${r.diff.map(line => html`<div class=${line.startsWith('-') ? 'minus' : 'plus'}>${line}</div>`)}
          </div>
        ` : html`<div class="dim" style="margin-top:6px">goawk trace stdout ≡ system awk stdout. safe to ship.</div>`}
      </div>
    `;
  }
}

customElements.define('aw-app', AwApp);
