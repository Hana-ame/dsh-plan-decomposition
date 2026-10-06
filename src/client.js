
// ============================================================================
// Plan Decomposition — Client half.
//
// This file is the content of `code.client` for the cordis_define tool: a plain
// JavaScript function body returning a Cordis Plugin. It is the dual of
// src/host.js. The host owns the graph algebra; this half draws what the host
// says and, above all, gives a person somewhere to intervene.
//
// The organising idea: everything on screen is (a) something the host reported,
// or (b) a control a person can push. Nothing is inferred here that the host
// did not report, and nothing a person typed is silently dropped.
//
//   * every checkpoint is one row in the list, coloured by its review state;
//   * `gate: true` checkpoints are marked loudly, because they are the ones a
//     person must sign off on before work proceeds;
//   * an unestimated checkpoint reads 「未估」 — never 0, never a midpoint. A
//     fabricated number is worse than an admitted gap: a gap tells the reader
//     to go and fix it;
//   * estimates are editable in place; a debounced re-verify redraws the graph;
//   * the SVG draws blocking edges solid, risk edges dashed, and the critical
//     path highlighted — the three things a supervisor reads first.
//
// Plain JavaScript only: no JSX, no imports, no external dependencies, no
// native timers. Timers come from the Cordis `timer` service, host calls from
// `host.call`, styles from `styles.insert`. Layout is computed here; there is no
// graph library.
// ============================================================================

const h = React.createElement
const PANEL_ID = 'plan-decomposition'
const STAMP = 'pd-1'

// --- drawing geometry --------------------------------------------------------
//
// Waves are columns, checkpoints are rows inside a column. The numbers are
// chosen so a four-stage plan fits a laptop panel without zooming.
const NODE_W = 208
const NODE_H = 66
const COL_GAP = 76
const ROW_GAP = 22
const HEAD_H = 26 // room for the wave caption above each column
const PAD = 24

// --- host-call tuning --------------------------------------------------------
const TIMEOUT_INFO = 8000
const TIMEOUT_VERIFY = 20000
const TIMEOUT_OUTLINE = 15000
const TIMEOUT_REVIEW = 12000
const TIMEOUT_PLAN = 10000
const DEBOUNCE_MS = 250 // the contract's estimate-edit debounce

// --- review states -----------------------------------------------------------
//
// These mirror the host's REVIEW_STATES exactly. The colour of a row is the
// state, so it is declared in one place and never recomputed per render.
// `pending` grey / `approved` green / `rejected` red / `edited` orange /
// `skipped` dim — the skipped state is deliberately desaturated: a stage a
// person abandoned should recede, not compete with real work.
const REVIEW_META = {
  pending: { label: '待审', mark: '·', color: 'var(--dsw-alias-label-secondary,#9aa4b2)' },
  approved: { label: '已通过', mark: '✓', color: 'var(--dsw-alias-state-success-primary,#2ea043)' },
  rejected: { label: '已否决', mark: '✗', color: 'var(--dsw-alias-state-error-primary,#ef4444)' },
  edited: { label: '已改写', mark: '✎', color: 'var(--dsw-alias-state-warning-primary,#d29922)' },
  skipped: { label: '已跳过', mark: '–', color: 'var(--dsw-alias-label-tertiary,#6b7280)' },
}

const REVIEW_ORDER = ['pending', 'approved', 'rejected', 'edited', 'skipped']

const RISK_META = {
  low: { label: '低', color: 'var(--dsw-alias-state-success-primary,#2ea043)' },
  medium: { label: '中', color: 'var(--dsw-alias-state-warning-primary,#d29922)' },
  high: { label: '高', color: 'var(--dsw-alias-state-error-primary,#ef4444)' },
  unknown: { label: '未评', color: 'var(--dsw-alias-label-secondary,#9aa4b2)' },
}

const FINDING_META = {
  // awaiting-human is deliberately `info`, not a warning. A plan nobody has
  // reviewed yet is the normal state of a plan that was just written, and
  // colouring it red would train the reader to ignore the panel.
  error: { label: '错误', color: 'var(--dsw-alias-state-error-primary,#ef4444)' },
  warn: { label: '注意', color: 'var(--dsw-alias-state-warning-primary,#d29922)' },
  info: { label: '待人', color: 'var(--dsw-alias-brand-primary,#4d6bfe)' },
}

// The three slot names, declared once: the registration block and the status
// line must agree, and a typo in one of them is silent.
const SLOT_MAIN = 'main'
const SLOT_LIST = 'sidebar.panellist'
const SLOT_TOOL = 'tool.view.cordis'
const TOOL_KEY = 'self'

// ============================================================================
// STYLES
//
// Every colour is a theme alias with a literal fallback, so the panel inherits
// the host's light/dark theme instead of shipping its own palette. The `pd-`
// prefix keeps these rules from colliding with the other panels in the dock.
// ============================================================================

const CSS = [
  '.pd-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;width:100%;overflow:hidden;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit);font-size:13px;line-height:1.45}',

  // -- toolbar
  '.pd-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;row-gap:6px;padding:7px 9px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));flex:none;background:var(--dsw-alias-bg-layer-1,transparent)}',
  '.pd-brand{font-size:12.5px;font-weight:600;white-space:nowrap;flex:none}',
  '.pd-spacer{flex:1 1 auto;min-width:0}',
  '.pd-btn{display:inline-flex;align-items:center;gap:5px;flex:none;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.4));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);border-radius:8px;padding:4px 10px;font:inherit;font-size:12px;line-height:1.5;cursor:pointer;white-space:nowrap}',
  '.pd-btn:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-3,transparent))}',
  '.pd-btn[disabled]{opacity:.45;cursor:default}',
  '.pd-on{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4d6bfe));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}',
  '.pd-danger{color:var(--dsw-alias-state-error-primary,inherit);border-color:var(--dsw-alias-state-error-primary,currentColor)}',
  '.pd-inp,.pd-sel{background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:8px;padding:5px 8px;font:inherit;font-size:12px;box-sizing:border-box}',
  '.pd-inp{flex:1 1 160px;min-width:0}',
  '.pd-note{font-size:11.5px;color:var(--dsw-alias-label-secondary,inherit);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.pd-chip{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:999px;padding:1px 8px;font-size:11px;background:var(--dsw-alias-bg-layer-1,transparent);flex:none;white-space:nowrap}',
  '.pd-mono{font-family:var(--dsw-font-mono,ui-monospace,Menlo,monospace);font-size:10.5px}',

  // -- verdict strip: the one line a supervisor reads before anything else
  '.pd-verdict{display:flex;align-items:center;gap:8px;flex-wrap:wrap;row-gap:4px;padding:7px 9px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));flex:none;font-size:12px}',
  '.pd-verdict-good{color:var(--dsw-alias-state-success-primary,#2ea043)}',
  '.pd-verdict-bad{color:var(--dsw-alias-state-error-primary,#ef4444)}',
  '.pd-verdict-warn{color:var(--dsw-alias-state-warning-primary,#d29922)}',
  '.pd-k{color:var(--dsw-alias-label-secondary,inherit);flex:none}',
  '.pd-v{font-family:var(--dsw-font-mono,ui-monospace,Menlo,monospace)}',
  '.pd-unest{color:var(--dsw-alias-state-warning-primary,#d29922);font-style:italic}',

  // -- body split: list on the left, graph on the right
  '.pd-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:row;align-items:stretch}',
  '.pd-list{flex:0 0 46%;min-width:260px;max-width:640px;overflow:auto;border-right:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));padding:6px;display:flex;flex-direction:column;gap:5px}',

  // -- one checkpoint = one row. The left rule is the review-state colour, so a
  //    supervisor can scan the column of rules and read the whole plan state.
  '.pd-row{position:relative;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-left:4px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:9px;padding:6px 8px;display:flex;flex-direction:column;gap:4px;background:var(--dsw-alias-bg-layer-1,transparent);cursor:pointer}',
  '.pd-row:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2,transparent))}',
  '.pd-row[data-sel="1"]{background:var(--dsw-alias-interactive-bg-selected,var(--dsw-alias-bg-layer-3,transparent));box-shadow:0 0 0 1px var(--dsw-alias-brand-primary,#4d6bfe) inset}',
  '.pd-row[data-gate="1"]{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2,transparent))}',
  '.pd-row[data-critical="1"] .pd-title{text-decoration:underline;text-decoration-color:var(--dsw-alias-state-warning-primary,#d29922);text-underline-offset:2px}',
  '.pd-r1{display:flex;align-items:center;gap:6px;min-width:0}',
  '.pd-mark{font-size:13px;font-weight:700;flex:none;width:14px;text-align:center}',
  '.pd-title{font-size:12.5px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.pd-id{font-family:var(--dsw-font-mono,ui-monospace,Menlo,monospace);font-size:10.5px;color:var(--dsw-alias-label-secondary,inherit);flex:none}',
  '.pd-tags{display:flex;align-items:center;gap:4px;flex:none;margin-left:auto}',
  '.pd-tag{display:inline-flex;align-items:center;gap:3px;border-radius:6px;padding:0 6px;font-size:10.5px;line-height:17px;border:1px solid currentColor;white-space:nowrap;flex:none}',
  '.pd-tag-gate{border-style:solid;border-width:1.5px;font-weight:700}',
  '.pd-tag-ext{border-style:dashed}',
  '.pd-r2{display:flex;align-items:center;gap:6px;flex-wrap:wrap;row-gap:4px;min-width:0}',
  '.pd-plan{font-size:11.5px;color:var(--dsw-alias-label-secondary,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 1 120px}',
  '.pd-miss{font-size:10.5px;color:var(--dsw-alias-state-warning-primary,#d29922);flex:none}',

  // -- the estimate editor. 未估 is styled, never 0: see the file header.
  '.pd-est{display:inline-flex;align-items:center;gap:3px;flex:none;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:7px;padding:1px 5px;background:var(--dsw-alias-bg-base,transparent)}',
  '.pd-est:focus-within{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
  '.pd-est-k{font-size:10px;color:var(--dsw-alias-label-secondary,inherit);flex:none}',
  '.pd-est-in{width:52px;border:0;background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:11px;padding:1px 2px;box-sizing:border-box}',
  '.pd-est-in:focus{outline:none}',
  '.pd-est-unest{font-size:11px;color:var(--dsw-alias-state-warning-primary,#d29922);font-style:italic;padding:1px 2px}',

  // -- review buttons: the primary human gesture
  '.pd-states{display:flex;align-items:center;gap:3px;flex-wrap:wrap;row-gap:3px;flex:none}',
  '.pd-state{font:inherit;font-size:10.5px;line-height:1.4;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.4));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-secondary,inherit);border-radius:6px;padding:1px 6px;cursor:pointer;white-space:nowrap}',
  '.pd-state:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-3,transparent))}',
  '.pd-state[data-on="1"]{color:#fff;border-color:transparent;font-weight:700}',
  '.pd-state[disabled]{opacity:.45;cursor:default}',
  '.pd-notein{width:100%;box-sizing:border-box;resize:vertical;min-height:20px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:6px;padding:3px 5px;font:inherit;font-size:11px}',

  // -- graph pane
  '.pd-graphwrap{flex:1 1 auto;min-width:0;min-height:0;position:relative;overflow:auto;background-color:var(--dsw-alias-bg-base,transparent);background-image:linear-gradient(var(--dsw-alias-border-l1,rgba(127,127,127,.16)) 1px,transparent 1px),linear-gradient(90deg,var(--dsw-alias-border-l1,rgba(127,127,127,.16)) 1px,transparent 1px);background-size:22px 22px}',
  '.pd-svg{display:block;touch-action:none}',
  '.pd-legend{position:absolute;left:9px;bottom:9px;display:flex;flex-direction:column;gap:3px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:9px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2,rgba(20,20,24,.86)));padding:6px 8px;font-size:11px}',
  '.pd-leg{display:flex;align-items:center;gap:6px;white-space:nowrap}',
  '.pd-leg-sw{width:16px;height:0;border-top-width:2px;border-top-style:solid;flex:none}',
  '.pd-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;font-size:12.5px;color:var(--dsw-alias-label-secondary,inherit)}',

  // -- findings
  '.pd-findings{flex:none;max-height:26%;overflow:auto;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));padding:7px 9px;display:flex;flex-direction:column;gap:4px;background:var(--dsw-alias-bg-layer-1,transparent)}',
  '.pd-frow{display:flex;align-items:baseline;gap:6px;font-size:11.5px;line-height:1.4}',
  '.pd-flevel{flex:none;font-weight:700;font-size:10.5px;border-radius:5px;padding:0 5px;line-height:16px;border:1px solid currentColor}',
  '.pd-fcode{font-family:var(--dsw-font-mono,ui-monospace,Menlo,monospace);font-size:10.5px;flex:none;opacity:.85}',
  '.pd-fdetail{min-width:0;word-break:break-word}',
  '.pd-hist{flex:none;max-height:20%;overflow:auto;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));padding:7px 9px;display:flex;flex-direction:column;gap:3px;font-size:11px;background:var(--dsw-alias-bg-layer-1,transparent)}',
  '.pd-hrow{display:flex;gap:6px;align-items:baseline}',
  '.pd-hat{font-family:var(--dsw-font-mono,ui-monospace,Menlo,monospace);font-size:10px;color:var(--dsw-alias-label-secondary,inherit);flex:none}',
]

// ===========================================================================
// PURE HELPERS (module scope: no ctx, no React, no host)
// ===========================================================================

function merge(a, b) {
  const out = {}
  for (const k in a) out[k] = a[k]
  for (const k in b) out[k] = b[k]
  return out
}

function clamp(v, lo, hi) {
  if (typeof v !== 'number' || !isFinite(v)) return lo
  return v < lo ? lo : (v > hi ? hi : v)
}

function num(v) {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return typeof n === 'number' && isFinite(n) && n >= 0 ? n : null
}

function isNum(v) {
  return typeof v === 'number' && isFinite(v) && v >= 0
}

function fmtTime(ms) {
  if (!isNum(ms) || ms <= 0) return ''
  const d = new Date(ms)
  const pad = (n) => (n < 10 ? '0' + String(n) : String(n))
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
}

function estText(n) {
  // Hours. Fractional hours are kept as typed (0.5h is a real answer); anything
  // >= 10 loses the decimal so the column does not jitter as digits change.
  if (!isNum(n)) return '未估'
  const s = n >= 10 ? String(Math.round(n * 10) / 10) : String(n)
  return s + 'h'
}

function durText(n) {
  // A total is not an estimate: it is arithmetic on whatever the person typed.
  // Missing estimates are excluded, and the count is shown next to it so the
  // number is never read as covering the whole plan.
  if (!isNum(n)) return '—'
  if (n >= 10) return String(Math.round(n * 10) / 10) + 'h'
  return String(n) + 'h'
}

function clip(text, max) {
  const s = String(text === undefined || text === null ? '' : text)
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)) + '…'
}

function uniq(list) {
  const seen = {}
  const out = []
  for (let i = 0; i < list.length; i++) {
    const v = list[i]
    if (v === null || v === undefined || seen[v] === true) continue
    seen[v] = true
    out.push(v)
  }
  return out
}

function arr(v) {
  return Array.isArray(v) ? v : []
}

function obj(v) {
  return v !== null && typeof v === 'object' ? v : {}
}

function reviewMeta(state) {
  return REVIEW_META[state] !== undefined ? REVIEW_META[state] : REVIEW_META.pending
}

function riskMeta(risk) {
  return RISK_META[risk] !== undefined ? RISK_META[risk] : RISK_META.unknown
}

function findingMeta(level) {
  return FINDING_META[level] !== undefined ? FINDING_META[level] : FINDING_META.warn
}

// Strip everything the host does not own. Sending the whole local node back
// would smuggle in fields the host would then have to defend against, and the
// host would drop them anyway.
function packNode(n) {
  return {
    id: String(n.id),
    title: typeof n.title === 'string' ? n.title : '',
    plan: typeof n.plan === 'string' ? n.plan : '',
    materials: typeof n.materials === 'string' ? n.materials : '',
    acceptance: typeof n.acceptance === 'string' ? n.acceptance : '',
    estLo: isNum(n.estLo) ? n.estLo : null,
    estHi: isNum(n.estHi) ? n.estHi : null,
    external: n.external === true,
    risk: typeof n.risk === 'string' ? n.risk : 'unknown',
    review: typeof n.review === 'string' ? n.review : 'pending',
    reviewNote: typeof n.reviewNote === 'string' ? n.reviewNote : '',
    gate: n.gate === true,
  }
}

function packEdge(e) {
  return {
    from: String(e.from),
    to: String(e.to),
    kind: e.kind === 'risk' ? 'risk' : 'blocking',
    reason: typeof e.reason === 'string' ? e.reason : '',
  }
}

function packPlan(nodes, edges, goal, purpose) {
  return {
    nodes: nodes.map(packNode),
    edges: edges.map(packEdge),
    goal: typeof goal === 'string' ? goal : '',
    purpose: typeof purpose === 'string' ? purpose : '',
  }
}

// Keep the rows the host sends (it normalises) but retain order, and refuse a
// node with no id: a row without an id cannot be acted on, so it is a UI bug.
function normaliseNodes(list) {
  const out = []
  const seen = {}
  const raw = arr(list)
  for (let i = 0; i < raw.length; i++) {
    const n = raw[i]
    if (n === null || typeof n !== 'object') continue
    if (typeof n.id !== 'string' || n.id.length === 0) continue
    if (seen[n.id] === true) continue
    seen[n.id] = true
    out.push({
      id: n.id,
      title: typeof n.title === 'string' ? n.title : '',
      plan: typeof n.plan === 'string' ? n.plan : '',
      materials: typeof n.materials === 'string' ? n.materials : '',
      acceptance: typeof n.acceptance === 'string' ? n.acceptance : '',
      estLo: isNum(n.estLo) ? n.estLo : null,
      estHi: isNum(n.estHi) ? n.estHi : null,
      external: n.external === true,
      risk: typeof n.risk === 'string' ? n.risk : 'unknown',
      review: typeof n.review === 'string' && REVIEW_ORDER.indexOf(n.review) >= 0 ? n.review : 'pending',
      reviewNote: typeof n.reviewNote === 'string' ? n.reviewNote : '',
      gate: n.gate === true,
      missing: arr(n.missing),
    })
  }
  return out
}

function normaliseEdges(list, ids) {
  const out = []
  const raw = arr(list)
  const known = {}
  for (let i = 0; i < ids.length; i++) known[ids[i]] = true
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i]
    if (e === null || typeof e !== 'object') continue
    if (typeof e.from !== 'string' || typeof e.to !== 'string') continue
    if (known[e.from] !== true || known[e.to] !== true) continue
    out.push({
      from: e.from,
      to: e.to,
      kind: e.kind === 'risk' ? 'risk' : 'blocking',
      reason: typeof e.reason === 'string' ? e.reason : '',
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Layout. Waves become columns, checkpoints stack inside their column.
//
// The column index comes from the host's `analysis.waves` when the graph is
// acyclic — the host derived them from the edges, and re-deriving here would be
// a second source of truth that can disagree with the one being read. When the
// graph is cyclic the host reports no waves at all, and the column falls back to
// the node's own order, which is why the panel draws the cycle warning loudly
// instead of pretending the schedule means something.
//
// Nodes absent from `waves` — the ones inside a cycle — are appended to the last
// column rather than dropped: a person has to be able to see and fix them.
// ---------------------------------------------------------------------------
function layout(nodes, waves, selectedId) {
  const ids = []
  const byId = {}
  for (let i = 0; i < nodes.length; i++) {
    ids.push(nodes[i].id)
    byId[nodes[i].id] = nodes[i]
  }

  const colOf = {}
  let cols = -1
  for (let i = 0; i < waves.length; i++) {
    const w = waves[i]
    if (!w || typeof w.wave !== 'number') continue
    const members = uniq(arr(w.nodes))
    for (let k = 0; k < members.length; k++) {
      if (byId[members[k]] === undefined) continue
      colOf[members[k]] = w.wave
      if (w.wave > cols) cols = w.wave
    }
  }
  // Nodes the host did not place (cycle members, or no waves at all) go last.
  let orphanCol = cols + 1
  for (let i = 0; i < ids.length; i++) {
    if (typeof colOf[ids[i]] !== 'number') colOf[ids[i]] = orphanCol
  }
  if (cols < 0) cols = 0
  if (orphanCol > cols) cols = orphanCol

  const buckets = {}
  for (let i = 0; i < ids.length; i++) {
    const c = String(colOf[ids[i]])
    if (buckets[c] === undefined) buckets[c] = []
    buckets[c].push(ids[i])
  }
  const colKeys = Object.keys(buckets).map(Number).sort(function (a, b) { return a - b })
  const out = []
  let maxX = 0
  let maxY = 0
  for (let ci = 0; ci < colKeys.length; ci++) {
    const members = buckets[String(colKeys[ci])]
    for (let r = 0; r < members.length; r++) {
      const n = byId[members[r]]
      const x = PAD + ci * (NODE_W + COL_GAP)
      const y = PAD + HEAD_H + r * (NODE_H + ROW_GAP)
      out.push({
        id: n.id,
        node: n,
        x: x,
        y: y,
        col: colKeys[ci],
        row: r,
        sel: selectedId === n.id,
      })
      if (x + NODE_W > maxX) maxX = x + NODE_W
      if (y + NODE_H > maxY) maxY = y + NODE_H
    }
  }

  const posOf = {}
  for (let i = 0; i < out.length; i++) posOf[out[i].id] = out[i]

  // Wave captions go above each column, but only where the column is genuinely
  // a wave — a caption reading "波次 5" over a column of cycle members would be
  // a claim the host never made.
  const captions = []
  for (let ci = 0; ci < colKeys.length; ci++) {
    const c = colKeys[ci]
    const members = buckets[String(c)]
    if (members.length === 0) continue
    const fromWaves = waves.some(function (w) { return w && w.wave === c })
    captions.push({
      key: 'cap' + String(c),
      x: PAD + ci * (NODE_W + COL_GAP),
      y: PAD + 12,
      text: fromWaves ? ('波次 ' + String(c + 1)) : '未定位',
      warn: !fromWaves,
    })
  }

  return { nodes: out, byId: posOf, captions: captions, maxX: maxX, maxY: maxY }
}

// Build the edge list with draw coordinates. Routing is orthogonal (out of the
// right side, across, into the left side) because a plan reads left-to-right;
// a back edge, which is how a cycle shows up, loops under its own column.
// `path` is the host's criticalPath array, in order. Object key order cannot
// stand in for it: `Object.keys` reorders, which would make a consecutive pair
// test meaningless.
function routeEdges(layoutInfo, edges, path) {
  const byId = layoutInfo.byId
  const out = []
  const raw = arr(edges)
  const chain = arr(path)
  const onPath = {}
  for (let i = 0; i < chain.length; i++) onPath[chain[i]] = true
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i]
    const a = byId[e.from]
    const b = byId[e.to]
    if (a === undefined || b === undefined) continue
    // Critical iff this edge is a consecutive step of the host's critical path.
    // Membership of both endpoints is necessary but not sufficient — see the
    // note at the call site.
    let critical = false
    if (onPath[e.from] === true && onPath[e.to] === true) {
      for (let k = 0; k + 1 < chain.length; k++) {
        if (chain[k] === e.from && chain[k + 1] === e.to) { critical = true; break }
      }
    }
    const from = { x: a.x, y: a.y }
    const to = { x: b.x, y: b.y }
    const back = to.col < from.col || (to.col === from.col && to.row <= from.row)
    const x1 = from.x + NODE_W
    const y1 = from.y + NODE_H / 2
    const x2 = to.x
    const y2 = to.y + NODE_H / 2
    let d
    if (back) {
      // Loop below the source and come back up into the target's bottom edge,
      // so the shape reads as "this goes backwards" without hiding either node.
      const lane = Math.max(from.y + NODE_H, to.y + NODE_H) + 26
      d = 'M ' + String(x1) + ' ' + String(y1) +
        ' C ' + String(x1 + 46) + ' ' + String(y1) + ', ' + String(x1 + 46) + ' ' + String(lane) + ', ' + String(x1) + ' ' + String(lane) +
        ' L ' + String(x2) + ' ' + String(lane) +
        ' C ' + String(x2 - 46) + ' ' + String(lane) + ', ' + String(x2 - 46) + ' ' + String(to.y + NODE_H) + ', ' + String(x2) + ' ' + String(to.y + NODE_H)
    } else {
      const mx = (x1 + x2) / 2
      d = 'M ' + String(x1) + ' ' + String(y1) +
        ' C ' + String(mx) + ' ' + String(y1) + ', ' + String(mx) + ' ' + String(y2) + ', ' + String(x2) + ' ' + String(y2)
    }
    out.push({
      key: 'e' + String(i),
      kind: e.kind,
      reason: e.reason,
      critical: critical,
      x2: x2,
      y2: y2,
      d: d,
      reverse: back,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Fallback scaffold.
//
// Used only when the host is unreachable at startup (pd-info fails), so the
// panel is never a blank rectangle and the reader can see the four-stage shape
// this method works by. It is explicitly NOT presented as a verified plan:
// `mock: true` keeps the verdict strip from claiming the graph is drawable, and
// every host call still fails loudly in the status line until the host answers.
//
// The stages mirror host.js OUTLINE_STAGES. If they drift apart the harm is
// small and bounded — pd-outline replaces this the moment the host is reachable
// — whereas inventing a stage the host does not know about would be a lie with
// no visible boundary.
// ---------------------------------------------------------------------------
function mockOutline() {
  const stages = [
    { id: 'C1', title: '确立出发点与目的', plan: '写清现在的真实状态、要达成什么、成功的判据是什么', gate: true, risk: 'low' },
    { id: 'C2', title: '倒推所需阶段', plan: '从目的反推必须完成哪些事，以及它们的先后', gate: true, risk: 'medium' },
    { id: 'C3', title: '逐项落实', plan: '每个阶段写清：做什么、用什么、产出是什么', gate: false, risk: 'medium' },
    { id: 'C4', title: '验证与修正', plan: '用什么检查证明真的做完了，不通过怎么回退', gate: true, risk: 'medium' },
  ]
  const nodes = []
  const edges = []
  for (let i = 0; i < stages.length; i++) {
    nodes.push({
      id: stages[i].id,
      title: stages[i].title,
      plan: stages[i].plan,
      materials: '',
      acceptance: '',
      estLo: null,
      estHi: null,
      external: false,
      risk: stages[i].risk,
      review: 'pending',
      reviewNote: '',
      gate: stages[i].gate,
      missing: ['estimate', 'acceptance'],
    })
    if (i > 0) {
      edges.push({ from: stages[i - 1].id, to: stages[i].id, kind: 'blocking', reason: '前一个阶段的产出是后一个的输入' })
    }
  }
  return { ok: true, goal: '', purpose: '', nodes: nodes, edges: edges }
}

// A short plan that demonstrates every visual the panel can draw, used by the
// 「示例」 button. Not a suggestion for the reader's own plan — a way to see
// what an edited, gated, risk-linked, critical-path plan looks like.
function demoPlan() {
  return {
    ok: true,
    goal: '把某个模块重构成可测试的结构',
    purpose: '为后续改动提供落脚点',
    nodes: [
      { id: 'A', title: '盘点现有行为', plan: '读代码、跑一遍，记录真实行为', materials: '源码', acceptance: '有一份行为清单', estLo: 1, estHi: 2, external: false, risk: 'low', review: 'approved', reviewNote: '范围已确认', gate: false },
      { id: 'B', title: '定下目标结构', plan: '写清拆分边界与依赖方向', materials: '行为清单', acceptance: '结构图通过评审', estLo: 1, estHi: 3, external: false, risk: 'medium', review: 'pending', reviewNote: '', gate: true },
      { id: 'C', title: '抽出核心模块', plan: '逐个函数搬移，每步跑测试', materials: '结构图', acceptance: '测试全绿', estLo: 3, estHi: 6, external: false, risk: 'medium', review: 'pending', reviewNote: '', gate: false },
      { id: 'D', title: '补测试覆盖', plan: '为新接口补边界用例', materials: '核心模块', acceptance: '覆盖率达标', estLo: 2, estHi: 4, external: false, risk: 'low', review: 'pending', reviewNote: '', gate: false },
      { id: 'E', title: '接入 CI 门禁', plan: '把门禁接到流水线', materials: '测试', acceptance: '合并被自动拦截', estLo: null, estHi: null, external: true, risk: 'high', review: 'skipped', reviewNote: '先不接', gate: false },
      { id: 'F', title: '收尾核对', plan: '逐条对照验收标准', materials: '全部产出', acceptance: '验收表全绿', estLo: 1, estHi: 2, external: false, risk: 'low', review: 'pending', reviewNote: '', gate: true },
    ],
    edges: [
      { from: 'A', to: 'B', kind: 'blocking', reason: '行为清单是结构设计的输入' },
      { from: 'B', to: 'C', kind: 'blocking', reason: '边界定了才能搬移' },
      { from: 'B', to: 'D', kind: 'blocking', reason: '接口形状决定测试写法' },
      { from: 'C', to: 'D', kind: 'risk', reason: '若核心模块接口再变，测试要重写' },
      { from: 'C', to: 'F', kind: 'blocking', reason: '' },
      { from: 'D', to: 'F', kind: 'blocking', reason: '覆盖率达标才能收尾' },
      { from: 'E', to: 'F', kind: 'risk', reason: 'CI 没接上，收尾等于没门禁' },
    ],
  }
}

// ===========================================================================
// PLUGIN
// ===========================================================================

return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) {
      console.error('[plan-decomposition] slots service unavailable; UI not registered')
      return
    }

    function createStore(initial) {
      let state = initial
      const listeners = []
      return {
        get: function () { return state },
        set: function (patch) {
          state = merge(state, patch)
          for (let i = 0; i < listeners.length; i++) {
            try { listeners[i]() } catch (e) { console.error('[plan-decomposition] listener failed', e) }
          }
        },
        subscribe: function (fn) {
          listeners.push(fn)
          return function () {
            const i = listeners.indexOf(fn)
            if (i >= 0) listeners.splice(i, 1)
          }
        },
      }
    }

    const store = createStore({
      // the working copy the human edits
      goal: '',
      purpose: '',
      nodes: [],
      edges: [],
      // the host's last answer about that working copy
      analysis: null,
      mock: false,
      selected: null,
      // chrome
      info: null,
      busy: false,
      error: null,
      notice: null,
      history: [],
      showFindings: true,
      showHistory: true,
      // estimate editing: local draft + the debounce bookkeeping
      drafts: {},
      draftSeq: 0,
      gen: 0,
      verifying: false,
      verifyAt: 0,
    })

    let stopped = false
    let disposed = false
    let debounceTimer = null

    // -- timers -----------------------------------------------------------------
    // Every delay in this file goes through the Cordis `timer` service. Native
    // setTimeout would survive the panel being disposed and fire into a dead
    // store; the service promise is simply dropped instead.
    function timerService() {
      const t = ctx.get('timer')
      return t !== undefined && t !== null && typeof t.timeout === 'function' ? t : null
    }
    function later(ms, fn) {
      const t = timerService()
      if (t === null) return null
      return t.timeout(ms).then(function () {
        if (stopped || disposed) return
        fn()
      })
    }

    // -- host bridge ------------------------------------------------------------
    //
    // One chokepoint for all five methods. Every call races the timer service
    // against a deadline, and every rejection becomes `{ ok:false, error }` so a
    // dropped host connection degrades the panel into an error line instead of
    // an unhandled rejection.
    const STATS = { calls: 0, byMethod: {}, lastMs: 0, lastMethod: '', failures: 0 }

    function hostCall(method, args, timeoutMs) {
      const t0 = Date.now()
      STATS.calls += 1
      STATS.byMethod[method] = (STATS.byMethod[method] || 0) + 1
      const call = Promise.resolve()
        .then(function () { return host.call(method, args) })
        .then(function (r) {
          if (r === undefined || r === null) return { ok: false, error: method + ' 返回空' }
          return r
        }, function (e) {
          return { ok: false, error: method + ': ' + String((e && e.message) || e) }
        })
        .then(function (r) {
          if (r && r.ok !== true) STATS.failures += 1
          const ms = Date.now() - t0
          if (ms > STATS.lastMs) { STATS.lastMs = ms; STATS.lastMethod = method }
          return r
        })
      const t = timerService()
      if (t === null || !isNum(timeoutMs) || timeoutMs <= 0) return call
      const deadline = t.timeout(timeoutMs).then(function () {
        return { ok: false, error: method + ' 未在 ' + String(timeoutMs) + 'ms 内响应', timeout: true }
      })
      return Promise.race([call, deadline])
    }

    function useStore() {
      const pair = React.useState(store.get())
      const setSnap = pair[1]
      React.useEffect(function () {
        setSnap(store.get())
        return store.subscribe(function () { setSnap(store.get()) })
      }, [])
      return pair[0]
    }

    // -- pd-info ----------------------------------------------------------------
    // Service availability and limits, for the status line. Called once on mount
    // and again from the 「重查」 button, because the host can come up after us.
    async function fetchInfo() {
      const r = await hostCall('pd-info', {}, TIMEOUT_INFO)
      if (r && r.ok === true) store.set({ info: r })
      else store.set({ info: { ok: false, error: (r && r.error) || 'pd-info failed' } })
      return r
    }

    // -- pd-outline -------------------------------------------------------------
    // A scaffold to edit down. The host owns the stages; we only store them and
    // immediately re-verify so the panel shows the host's own judgement of what
    // it just handed us (which is: no estimates, no acceptance, four gates).
    async function loadOutline(goalText) {
      const s = store.get()
      const goal = typeof goalText === 'string' ? goalText : s.goal
      store.set({ busy: true, error: null, notice: null })
      const r = await hostCall('pd-outline', { goal: goal }, TIMEOUT_OUTLINE)
      store.set({ busy: false })
      if (!r || r.ok !== true) {
        store.set({ error: (r && r.error) || 'pd-outline 失败' })
        return false
      }
      const nodes = normaliseNodes(r.nodes)
      const ids = []
      for (let i = 0; i < nodes.length; i++) ids.push(nodes[i])
      const edges = normaliseEdges(r.edges, ids.map(function (n) { return n.id }))
      store.set({
        nodes: nodes,
        edges: edges,
        goal: typeof r.goal === 'string' ? r.goal : goal,
        purpose: typeof r.purpose === 'string' ? r.purpose : '',
        analysis: null,
        mock: false,
        drafts: {},
        notice: '已载入脚手架：估时、验收标准都还没有，请逐项补齐',
      })
      await verifyNow()
      return true
    }

    // -- pd-verify --------------------------------------------------------------
    //
    // The gate. `gen` is the guard the contract asks for: every verify takes a
    // generation number, and a result is discarded unless its generation is
    // still the newest. Without it a slow verify of an old draft would land
    // after a fast verify of the new draft and repaint the graph from stale
    // inputs — the failure mode debouncing alone does not prevent, because the
    // debounce only delays the *send*, not the *answer*.
    async function verifyNow() {
      const s = store.get()
      if (s.nodes.length === 0) {
        store.set({ analysis: null, verifying: false })
        return null
      }
      const myGen = s.gen + 1
      store.set({ gen: myGen, verifying: true })
      const payload = packPlan(s.nodes, s.edges, s.goal, s.purpose)
      const r = await hostCall('pd-verify', payload, TIMEOUT_VERIFY)
      if (store.get().gen !== myGen) {
        // A newer edit has already been sent; this answer is about a state that
        // no longer exists. Drop it silently — it is not an error.
        return null
      }
      if (!r || r.ok !== true) {
        store.set({ verifying: false, error: (r && r.error) || 'pd-verify 失败' })
        return null
      }
      const nodes = normaliseNodes(r.nodes)
      // The host's echo is authoritative: it is what it actually normalised.
      const ids = nodes.map(function (n) { return n.id })
      const edges = normaliseEdges(r.edges, ids)
      const analysis = obj(r.analysis)
      store.set({
        verifying: false,
        analysis: analysis,
        // Only overwrite the working copy when the host kept the same set of
        // checkpoints. If it dropped or renamed one, the human's rows stay put
        // and the finding below explains the mismatch, rather than the list
        // silently reflowing under the cursor.
        nodes: sameIds(nodes, s.nodes) ? nodes : s.nodes,
        edges: sameIds(edges, s.edges) ? edges : s.edges,
        error: null,
        verifyAt: Date.now(),
      })
      if (!sameIds(nodes, s.nodes)) {
        store.set({ notice: 'host 端归一化时丢弃了某些 checkpoint，本地行已保留原样' })
      }
      return r
    }

    function sameIds(a, b) {
      if (a.length !== b.length) return false
      for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id) return false
      return true
    }

    // Debounced re-verify for estimate typing. 250ms, per the contract; the
    // pending timer is replaced rather than stacked, and every keystroke also
    // bumps the generation so an in-flight answer for an earlier keystroke is
    // discarded even if it lands inside the window.
    function scheduleVerify() {
      const s = store.get()
      store.set({ gen: s.gen + 1 })
      const mine = store.get().gen
      if (debounceTimer !== null) debounceTimer = null
      debounceTimer = later(DEBOUNCE_MS, function () {
        debounceTimer = null
        if (stopped || disposed) return
        const cur = store.get()
        if (cur.gen !== mine) return
        verifyNow().then(function () {}, function () {})
      })
    }

    // -- pd-review --------------------------------------------------------------
    // A decision is recorded on the host (it keeps the bounded history) and
    // mirrored into the local row so the list recolours immediately rather than
    // waiting for the round trip. If the host refuses, the local change is
    // rolled back — otherwise the panel would show a decision nobody recorded.
    async function submitReview(id, state, note) {
      const s = store.get()
      const target = s.nodes.filter(function (n) { return n.id === id })[0]
      if (target === undefined) return false
      const before = target.review
      const beforeNote = target.reviewNote
      const next = s.nodes.map(function (n) {
        if (n.id !== id) return n
        return merge(n, { review: state, reviewNote: typeof note === 'string' ? note : n.reviewNote })
      })
      store.set({ nodes: next, busy: true, error: null, notice: null })
      const r = await hostCall('pd-review', { id: id, state: state, note: typeof note === 'string' ? note : (target.reviewNote || '') }, TIMEOUT_REVIEW)
      store.set({ busy: false })
      if (!r || r.ok !== true) {
        const rolled = store.get().nodes.map(function (n) {
          if (n.id !== id) return n
          return merge(n, { review: before, reviewNote: beforeNote })
        })
        store.set({ nodes: rolled, error: '审核未记录：' + String((r && r.error) || 'pd-review 失败') })
        return false
      }
      store.set({ history: arr(r.history) })
      // Review state is not part of the graph algebra, so a re-verify is not
      // required here; the analysis is still valid. Re-verifying would clear
      // `awaiting-human` findings, which is exactly what a fresh review should.
      if (store.get().analysis !== null) {
        verifyNow().then(function () {}, function () {})
      }
      return true
    }

    // -- pd-plan ----------------------------------------------------------------
    // The host keeps only the review log, so this is what survives a reload of
    // the panel. Fetched on mount and after each review refresh.
    async function fetchPlan() {
      const r = await hostCall('pd-plan', {}, TIMEOUT_PLAN)
      if (r && r.ok === true) store.set({ history: arr(r.history) })
      return r
    }

    // -- local edits ------------------------------------------------------------
    function setEstimate(id, key, value) {
      const v = num(value)
      const s = store.get()
      const node = s.nodes.filter(function (n) { return n.id === id })[0]
      if (node === undefined) return
      // An emptied box is stored as null, i.e. 未估. It is never coerced to 0:
      // 0h is a claim (this stage costs nothing) and the panel must not make it.
      if (node[key] === v) return
      store.set({ nodes: s.nodes.map(function (n) { return n.id === id ? merge(n, { [key]: v }) : n }) })
      scheduleVerify()
    }

    function toggleGate(id) {
      const s = store.get()
      store.set({ nodes: s.nodes.map(function (n) { return n.id === id ? merge(n, { gate: !n.gate }) : n }) })
      scheduleVerify()
    }

    function setDraft(id, value) {
      const d = merge(store.get().drafts)
      d[id] = value
      store.set({ drafts: d })
    }

    function draftOf(id, fallback) {
      const d = store.get().drafts
      return typeof d[id] === 'string' ? d[id] : (fallback === null || fallback === undefined ? '' : String(fallback))
    }

    // -- SVG graph --------------------------------------------------------------
    //
    // Inline SVG, coordinates computed here, no layout library. Three edge
    // classes, and they are distinguishable without colour: blocking is a solid
    // arrow, risk is a dashed arrow, critical path is drawn over both in the
    // warning colour with a thicker stroke. A supervisor who cannot see the
    // hues still sees the distinction.
    function GraphSVG(props) {
      const st = props.state
      const nodes = arr(props.nodes)
      const edges = arr(props.edges)
      const analysis = props.analysis
      const criticalSet = obj(analysis && analysis.onCriticalPath)
      const selectedId = st.selected

      if (nodes.length === 0) {
        return h('div', { className: 'pd-empty' },
          h('div', null,
            h('div', { style: { marginBottom: '6px', fontWeight: 600 } }, '还没有计划'),
            h('div', null, '点「拆解脚手架」载入四个阶段，或点「示例」看一份完整计划的画法。'),
          ))
      }

      const info = layout(nodes, arr(analysis && analysis.waves), selectedId)
      const drawn = routeEdges(info, edges, arr(analysis && analysis.criticalPath))
      const w = Math.max(info.maxX + PAD, 320)
      const hgt = Math.max(info.maxY + PAD, 180)

      const defs = h('defs', null,
        h('marker', {
          id: 'pd-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5,
          markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
        }, h('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'var(--dsw-alias-label-secondary,#9aa4b2)' })),
        h('marker', {
          id: 'pd-arrow-crit', viewBox: '0 0 10 10', refX: 9, refY: 5,
          markerWidth: 6.5, markerHeight: 6.5, orient: 'auto-start-reverse',
        }, h('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'var(--dsw-alias-state-warning-primary,#d29922)' })),
      )

      // Non-critical edges first, so the highlight is never painted over.
      // A critical-path edge is a *consecutive* pair on the host's path, not
      // just "both endpoints are on the path": testing both endpoints would
      // light up every shortcut between two critical nodes and drown the one
      // chain the reader is meant to follow.
      const plain = drawn.filter(function (e) { return !e.critical })
      const crit = drawn.filter(function (e) { return e.critical })

      function edgeShape(e) {
        const marker = e.critical ? 'url(#pd-arrow-crit)' : 'url(#pd-arrow)'
        return h('path', {
          key: e.key,
          d: e.d,
          fill: 'none',
          stroke: e.critical ? 'var(--dsw-alias-state-warning-primary,#d29922)' : 'var(--dsw-alias-label-secondary,#9aa4b2)',
          strokeWidth: e.critical ? 2.4 : (e.kind === 'risk' ? 1.1 : 1.4),
          strokeDasharray: e.kind === 'risk' ? '5 4' : null,
          opacity: e.critical ? 0.95 : (e.kind === 'risk' ? 0.5 : 0.6),
          markerEnd: marker,
        })
      }

      // `item` is a layout entry: x/y/col/row plus the checkpoint under `.node`.
      // Graph fields come from the checkpoint, geometry from the entry — mixing
      // the two is how a node ends up drawn with `undefined` for a title.
      function nodeShape(item) {
        const n = item.node
        const x = item.x
        const y = item.y
        const rm = reviewMeta(n.review)
        const onCritical = criticalSet[n.id] === true
        const unest = n.estHi === null
        const fill = st.selected === n.id
          ? 'var(--dsw-alias-interactive-bg-selected,var(--dsw-alias-bg-layer-3,rgba(77,107,254,.14)))'
          : 'var(--dsw-alias-bg-layer-1,rgba(127,127,127,.10))'
        const stroke = onCritical
          ? 'var(--dsw-alias-state-warning-primary,#d29922)'
          : (n.gate ? 'var(--dsw-alias-brand-primary,#4d6bfe)' : 'var(--dsw-alias-border-l2,rgba(127,127,127,.4))')
        const title = n.title.length > 0 ? clip(n.title, 18) : n.id
        return h('g', {
          key: n.id,
          onClick: function () { store.set({ selected: n.id }) },
          style: { cursor: 'pointer' },
        },
          h('rect', {
            x: x, y: y, width: NODE_W, height: NODE_H, rx: 9,
            fill: fill, stroke: stroke,
            strokeWidth: st.selected === n.id || onCritical ? 2 : 1.2,
            // A gate is the thing that must not be passed without a signature;
            // the dashed double edge is how that reads in monochrome.
            strokeDasharray: n.gate ? '6 3' : null,
          }),
          // left rule in the review-state colour: the list and the graph agree
          h('rect', { x: x, y: y + 6, width: 4, height: NODE_H - 12, rx: 2, fill: rm.color }),
          h('text', {
            x: x + 13, y: y + 22, fill: 'var(--dsw-alias-label-primary,inherit)',
            fontSize: 12, fontWeight: 600,
          }, clip(title, 15)),
          h('text', {
            x: x + 13, y: y + 38, fill: 'var(--dsw-alias-label-secondary,inherit)',
            fontSize: 9.5,
          }, n.id + (n.external ? ' · 外部' : '')),
          // 未估 is italic and amber; a filled estimate is plain. Same text
          // position either way so the row height never changes on edit.
          h('text', {
            x: x + NODE_W - 12, y: y + 38,
            textAnchor: 'end',
            fontSize: 10.5,
            fill: unest ? 'var(--dsw-alias-state-warning-primary,#d29922)' : 'var(--dsw-alias-label-secondary,inherit)',
            fontStyle: unest ? 'italic' : null,
          }, unest ? '未估' : estText(n.estHi)),
          // gate badge
          n.gate ? h('text', {
            x: x + NODE_W - 12, y: y + 22,
            textAnchor: 'end', fontSize: 10.5, fontWeight: 700,
            fill: 'var(--dsw-alias-brand-primary,#4d6bfe)',
          }, '关卡') : null,
          // review mark, top-right corner of the left rule
          h('text', {
            x: x + NODE_W - 12, y: y + 55,
            textAnchor: 'end', fontSize: 10, fill: rm.color,
          }, rm.mark),
        )
      }

      const children = [defs]
      for (let i = 0; i < info.captions.length; i++) {
        const c = info.captions[i]
        children.push(h('text', {
          key: c.key,
          x: c.x, y: c.y,
          fontSize: 10.5,
          fill: c.warn ? 'var(--dsw-alias-state-error-primary,#ef4444)' : 'var(--dsw-alias-label-secondary,inherit)',
          fontWeight: c.warn ? 700 : 400,
        }, c.text))
      }
      for (let i = 0; i < plain.length; i++) children.push(edgeShape(plain[i]))
      for (let i = 0; i < crit.length; i++) children.push(edgeShape(crit[i]))
      for (let i = 0; i < info.nodes.length; i++) children.push(nodeShape(info.nodes[i]))

      return h('svg', {
        className: 'pd-svg',
        width: w,
        height: hgt,
        viewBox: '0 0 ' + String(w) + ' ' + String(hgt),
      }, children)
    }

    // -- one checkpoint row ------------------------------------------------------
    //
    // Everything a person needs to judge one stage and act on it, without
    // leaving the row: the review state buttons, the gate toggle, and the two
    // estimate boxes. This is the panel's reason to exist.
    function CheckpointRow(props) {
      const n = props.node
      const st = props.state
      const rm = reviewMeta(n.review)
      const rk = riskMeta(n.risk)
      const critical = props.critical
      const draftLo = draftOf(n.id, n.estLo === null ? '' : String(n.estLo))
      const draftHi = draftOf(n.id, n.estHi === null ? '' : String(n.estHi))

      const missing = uniq(arr(n.missing))
      const missLabel = missing.length === 0 ? '' : ('缺 ' + missing.join('/'))

      const stateBtns = REVIEW_ORDER.map(function (s) {
        const m = REVIEW_META[s]
        const on = n.review === s
        return h('button', {
          key: 'rs-' + s,
          className: 'pd-state',
          'data-on': on ? '1' : '0',
          disabled: st.busy,
          title: '标记为「' + m.label + '」并记录到 host',
          style: on ? { background: m.color, borderColor: 'transparent', color: '#fff' } : null,
          onClick: function (e) {
            if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
            submitReview(n.id, s, n.reviewNote)
          },
        }, m.mark + ' ' + m.label)
      })

      return h('div', {
        className: 'pd-row',
        'data-sel': st.selected === n.id ? '1' : '0',
        'data-gate': n.gate ? '1' : '0',
        'data-critical': critical ? '1' : '0',
        style: { borderLeftColor: rm.color },
        onClick: function () { store.set({ selected: n.id }) },
      },
        h('div', { className: 'pd-r1' },
          h('span', { className: 'pd-mark', style: { color: rm.color } }, rm.mark),
          h('span', { className: 'pd-title' }, n.title.length > 0 ? n.title : '（无标题）'),
          h('span', { className: 'pd-id' }, n.id),
          h('span', { className: 'pd-tags' },
            n.gate ? h('span', {
              className: 'pd-tag pd-tag-gate',
              style: { color: 'var(--dsw-alias-brand-primary,#4d6bfe)' },
              title: '关卡：这道关口要人签字才能往下走',
            }, '关卡') : null,
            critical ? h('span', {
              className: 'pd-tag',
              style: { color: 'var(--dsw-alias-state-warning-primary,#d29922)' },
              title: '在关键路径上',
            }, '关键路径') : null,
            n.external ? h('span', {
              className: 'pd-tag pd-tag-ext',
              style: { color: 'var(--dsw-alias-label-secondary,inherit)' },
              title: '依赖计划外的东西',
            }, '外部') : null,
            h('span', {
              className: 'pd-tag',
              style: { color: rk.color },
              title: '风险（由人或拆解给出，本面板不猜）',
            }, '险 ' + rk.label),
          ),
        ),
        h('div', { className: 'pd-r2' },
          n.plan.length > 0 ? h('span', { className: 'pd-plan', title: n.plan }, n.plan) : null,
          missLabel.length > 0 ? h('span', { className: 'pd-miss', title: 'host 报出的缺失字段' }, missLabel) : null,
          h('span', { className: 'pd-spacer' }),
          h('label', { className: 'pd-est', title: '估时上界可编辑；留空即「未估」，不会被写成 0' },
            h('span', { className: 'pd-est-k' }, '估'),
            h('input', {
              className: 'pd-est-in',
              value: draftHi,
              placeholder: '未估',
              onChange: function (e) { setDraft(n.id, e.target.value); setEstimate(n.id, 'estHi', e.target.value) },
              onClick: function (e) { if (e && typeof e.stopPropagation === 'function') e.stopPropagation() },
            }),
            h('span', { className: 'pd-est-k' }, 'h'),
          ),
          h('button', {
            className: n.gate ? 'pd-btn pd-on' : 'pd-btn',
            style: { padding: '2px 7px', fontSize: '11px' },
            title: n.gate ? '取消关卡标记' : '标为关卡：要人签字才能往下走',
            onClick: function (e) {
              if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
              toggleGate(n.id)
            },
          }, n.gate ? '已设关卡' : '设关卡'),
        ),
        h('div', { className: 'pd-states' }, stateBtns),
        n.reviewNote.length > 0 ? h('div', { className: 'pd-note', title: n.reviewNote }, '批注：' + clip(n.reviewNote, 80)) : null,
      )
    }

    // -- verdict strip -----------------------------------------------------------
    //
    // One line: is it drawable, is it schedulable, what is missing, what is
    // waiting on a person. The counts are drawn straight from the host's
    // analysis so the strip cannot disagree with the list below it.
    function Verdict(props) {
      const st = props.state
      const a = props.analysis
      if (a === null) {
        return h('div', { className: 'pd-verdict' },
          h('span', { className: 'pd-k' }, st.verifying ? '校验中…' : '尚未校验'),
          h('span', { className: 'pd-spacer' }),
          st.mock ? h('span', { className: 'pd-verdict-warn' }, '⚠ host 未响应：当前是内置脚手架，未经校验') : null,
        )
      }
      const unest = arr(a.unestimated)
      const gates = arr(a.gates)
      const waiting = arr(a.awaitingHuman)
      const errors = arr(a.findings).filter(function (f) { return f && f.level === 'error' })
      const cls = errors.length > 0 ? 'pd-verdict-bad' : (unest.length > 0 ? 'pd-verdict-warn' : 'pd-verdict-good')
      return h('div', { className: 'pd-verdict' },
        h('span', { className: cls, style: { fontWeight: 700 } },
          a.acyclic === true ? '✓ 图可画' : '✗ 有环'),
        h('span', { className: 'pd-spacer' }),
        h('span', { className: 'pd-k' }, '关卡'),
        h('span', { className: 'pd-v' }, String(gates.length)),
        h('span', { className: 'pd-k' }, '· 关键路径'),
        h('span', { className: 'pd-v' }, arr(a.criticalPath).length + ' 步 / ' + durText(a.criticalTotalHi)),
        h('span', { className: 'pd-k' }, '· 顺序总计'),
        h('span', { className: 'pd-v' }, durText(a.sequentialTotalHi)),
        unest.length > 0 ? h('span', { className: 'pd-unest' }, '· 未估 ' + String(unest.length) + ' 项') : null,
        waiting.length > 0 ? h('span', { className: 'pd-k' }, '· 待人 ' + String(waiting.length)) : null,
        st.verifying ? h('span', { className: 'pd-k' }, '· 校验中…') : null,
        st.mock ? h('span', { className: 'pd-verdict-warn' }, '⚠ 内置脚手架') : null,
      )
    }

    // -- findings ----------------------------------------------------------------
    //
    // One row per host finding, coloured by level. `awaiting-human` renders as
    // info, in blue, in its natural position (last, after the real problems) —
    // a plan nobody reviewed yet is the normal state of a new plan, and
    // colouring it red would train the reader to ignore this panel.
    function Findings(props) {
      const st = props.state
      if (!st.showFindings) return null
      const a = props.analysis
      const list = a === null ? [] : arr(a.findings)
      const order = { error: 0, warn: 1, info: 2 }
      const sorted = list.slice().sort(function (x, y) {
        const lx = order[x.level] === undefined ? 1 : order[x.level]
        const ly = order[y.level] === undefined ? 1 : order[y.level]
        if (lx !== ly) return lx - ly
        return String(x.code).localeCompare(String(y.code))
      })
      const counts = {
        error: sorted.filter(function (f) { return f.level === 'error' }).length,
        warn: sorted.filter(function (f) { return f.level === 'warn' }).length,
        info: sorted.filter(function (f) { return f.level === 'info' }).length,
      }
      return h('div', { className: 'pd-findings' },
        h('div', { className: 'pd-frow' },
          h('span', { style: { fontWeight: 700, flex: 'none' } }, '发现'),
          h('span', { className: 'pd-verdict-bad' }, '错误 ' + String(counts.error)),
          h('span', { className: 'pd-verdict-warn' }, '注意 ' + String(counts.warn)),
          h('span', { className: 'pd-verdict-good', style: { color: 'var(--dsw-alias-brand-primary,#4d6bfe)' } }, '待人 ' + String(counts.info)),
          h('span', { className: 'pd-spacer' }),
          h('button', {
            className: 'pd-btn',
            onClick: function () { store.set({ showFindings: !st.showFindings }) },
          }, '收起'),
        ),
        sorted.length === 0 ? h('div', { className: 'pd-note' }, '没有待处理的问题。')
          : sorted.map(function (f, i) {
            const m = findingMeta(f.level)
            return h('div', { className: 'pd-frow', key: String(i) },
              h('span', { className: 'pd-flevel', style: { color: m.color } }, m.label),
              h('span', { className: 'pd-fcode' }, String(f.code)),
              h('span', { className: 'pd-fdetail' }, String(f.detail)),
            )
          }),
      )
    }

    function History(props) {
      const st = props.state
      if (!st.showHistory) return null
      const list = arr(st.history)
      return h('div', { className: 'pd-hist' },
        h('div', { className: 'pd-hrow' },
          h('span', { style: { fontWeight: 700 } }, '审核记录'),
          h('span', { className: 'pd-spacer' }),
          h('span', { className: 'pd-note' }, String(list.length) + ' 条'),
          h('button', {
            className: 'pd-btn',
            onClick: function () { store.set({ showHistory: !st.showHistory }) },
          }, '收起'),
        ),
        list.length === 0 ? h('div', { className: 'pd-note' }, '（还没有人做过决定）')
          : list.slice(0, 40).map(function (e, i) {
            const m = reviewMeta(e.state)
            return h('div', { className: 'pd-hrow', key: String(i) },
              h('span', { className: 'pd-hat' }, fmtTime(e.at)),
              h('span', { style: { color: m.color, flex: 'none', fontWeight: 600 } }, m.label),
              h('span', { className: 'pd-mono', style: { flex: 'none' } }, String(e.id)),
              h('span', { className: 'pd-note', style: { whiteSpace: 'normal' } }, String(e.note || '')),
            )
          }),
      )
    }

    // -- root --------------------------------------------------------------------
    function PlanApp() {
      const st = useStore()
      const a = st.analysis
      const criticalSet = obj(a && a.onCriticalPath)
      const criticalPath = arr(a && a.criticalPath)
      const criticalMap = {}
      for (let i = 0; i < criticalPath.length; i++) criticalMap[criticalPath[i]] = true

      // Mount: ask the host what it can do, recover the review log, and load a
      // scaffold only if there is nothing to recover. If the host is down we
      // still draw the scaffold, marked as unverified — an empty panel teaches
      // the reader nothing about what this tool is for.
      React.useEffect(function () {
        stopped = false
        disposed = false
        let live = true
        fetchInfo().then(function (r) {
          if (!live || stopped) return
          if (r && r.ok === true) {
            fetchPlan().then(function () {}, function () {})
            return
          }
          const m = mockOutline()
          store.set({
            mock: true,
            nodes: normaliseNodes(m.nodes),
            edges: normaliseEdges(m.edges, ['C1', 'C2', 'C3', 'C4']),
            error: 'host 不可用：' + String((r && r.error) || '未知'),
          })
        }, function () {})
        return function () {
          live = false
          stopped = true
          disposed = true
          debounceTimer = null
        }
      }, [])

      const info = st.info
      const infoOk = info !== null && info.ok === true
      const rows = []
      for (let i = 0; i < st.nodes.length; i++) {
        rows.push(h(CheckpointRow, {
          key: st.nodes[i].id,
          node: st.nodes[i],
          state: st,
          critical: criticalMap[st.nodes[i].id] === true,
        }))
      }

      const bar = h('div', { className: 'pd-bar' },
        h('span', { className: 'pd-brand' }, '计划拆解'),
        h('button', {
          className: 'pd-btn pd-on',
          disabled: st.busy,
          title: '向 host 请求一份脚手架：确立出发点 → 倒推阶段 → 逐项落实 → 验证',
          onClick: function () { loadOutline(st.goal).then(function () {}, function () {}) },
        }, '拆解脚手架'),
        h('button', {
          className: 'pd-btn',
          disabled: st.busy,
          title: '载入一份示例计划，看看编辑后的计划长什么样',
          onClick: function () {
            const d = demoPlan()
            store.set({
              mock: false,
              nodes: normaliseNodes(d.nodes),
              edges: normaliseEdges(d.edges, ['A', 'B', 'C', 'D', 'E', 'F']),
              goal: d.goal,
              purpose: d.purpose,
              analysis: null,
              drafts: {},
              notice: '示例计划：改任何一格估时试试',
            })
            verifyNow().then(function () {}, function () {})
          },
        }, '示例'),
        h('button', {
          className: 'pd-btn',
          disabled: st.busy || st.nodes.length === 0,
          onClick: function () { verifyNow().then(function () {}, function () {}) },
        }, st.verifying ? '校验中…' : '重新校验'),
        h('span', { className: 'pd-spacer' }),
        h('span', { className: 'pd-note' },
          'build ' + STAMP + (infoOk ? '/host ' + String(info.build) : '/host 未知') +
          ' · ' + String(st.nodes.length) + ' 节点 · ' + String(st.edges.length) + ' 边' +
          ' · host 调用 ' + String(STATS.calls)),
        h('button', {
          className: 'pd-btn',
          onClick: function () { fetchInfo().then(function () {}, function () {}) },
        }, '重查'),
      )

      const graphArea = st.nodes.length === 0
        ? null
        : h('div', { className: 'pd-graphwrap' },
          h(GraphSVG, { state: st, nodes: st.nodes, edges: st.edges, analysis: a }),
          h('div', { className: 'pd-legend' },
            h('div', { className: 'pd-leg' }, h('span', { className: 'pd-leg-sw', style: { borderTopColor: 'var(--dsw-alias-label-secondary,#9aa4b2)' } }), '阻塞边'),
            h('div', { className: 'pd-leg' }, h('span', { className: 'pd-leg-sw', style: { borderTopStyle: 'dashed', borderTopColor: 'var(--dsw-alias-label-secondary,#9aa4b2)' } }), '风险边'),
            h('div', { className: 'pd-leg' }, h('span', { className: 'pd-leg-sw', style: { borderTopWidth: '3px', borderTopColor: 'var(--dsw-alias-state-warning-primary,#d29922)' } }), '关键路径'),
            h('div', { className: 'pd-leg' }, h('span', { className: 'pd-leg-sw', style: { borderTopStyle: 'dashed', borderTopColor: 'var(--dsw-alias-brand-primary,#4d6bfe)' } }), '关卡（需签字）'),
          ),
        )

      return h('div', { className: 'pd-root' },
        bar,
        h(Verdict, { state: st, analysis: a }),
        h('div', { className: 'pd-body' },
          h('div', { className: 'pd-list' },
            rows.length === 0 ? h('div', { className: 'pd-note' }, '还没有 checkpoint。点上方「拆解脚手架」开始。') : rows,
          ),
          graphArea,
        ),
        h(Findings, { state: st, analysis: a }),
        h(History, { state: st }),
        st.error ? h('div', { className: 'pd-findings', style: { borderTop: 0, maxHeight: 'none', color: 'var(--dsw-alias-state-error-primary,#ef4444)' } }, '✗ ' + st.error) : null,
        st.notice ? h('div', { className: 'pd-hist', style: { borderTop: 0, maxHeight: 'none', color: 'var(--dsw-alias-brand-primary,#4d6bfe)' } }, st.notice) : null,
      )
    }

    // -- sidebar icon ------------------------------------------------------------
    // A gate over a chain: three stages and one bar across them.
    function PlanIcon(props) {
      const size = (props && props.size) || 18
      const color = props && props.active ? 'var(--dsw-alias-brand-primary,#4d6bfe)' : 'currentColor'
      return h('svg', { width: size, height: size, viewBox: '0 0 20 20', fill: 'none', stroke: color, strokeWidth: 1.6, strokeLinecap: 'round' },
        h('rect', { x: 2.5, y: 7.5, width: 4.5, height: 4.5, rx: 1 }),
        h('rect', { x: 13, y: 7.5, width: 4.5, height: 4.5, rx: 1 }),
        h('path', { d: 'M7 9.75 L13 9.75' }),
        h('path', { d: 'M10 6 L10 13.5' }),
      )
    }

    // -- tool.view.cordis card ---------------------------------------------------
    // The card is the only place that survives when the panel is closed, so it
    // carries the one number a supervisor wants when they glance at it: how
    // much of the plan is waiting on them.
    function PlanCard() {
      const st = useStore()
      const a = st.analysis
      const waiting = a === null ? 0 : arr(a.awaitingHuman).length
      const gates = a === null ? 0 : arr(a.gates).length
      const unest = a === null ? 0 : arr(a.unestimated).length
      const cyclic = a !== null && a.acyclic === true
      const infoOk = st.info !== null && st.info.ok === true
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px' } },
        h('div', { style: { fontWeight: 600 } }, '计划拆解 · 关口与关键路径'),
        h('div', { className: 'pd-note' },
          'build client ' + STAMP + ' · host ' + (infoOk ? String(st.info.build) : '未知') +
          ' · ' + String(st.nodes.length) + ' 节点'),
        h('div', { className: 'pd-note' },
          a === null ? '尚未校验'
            : (cyclic ? '✓ 图可画' : '✗ 有环') +
              ' · 关卡 ' + String(gates) +
              ' · 待人 ' + String(waiting) +
              (unest > 0 ? ' · 未估 ' + String(unest) : '')),
        h('button', {
          className: 'pd-btn pd-on',
          onClick: function () {
            try {
              const layout = ctx.get('layout')
              if (layout !== undefined && layout !== null && typeof layout.selectPanel === 'function') layout.selectPanel(PANEL_ID)
            } catch (e) {
              console.error('[plan-decomposition] selectPanel failed', e)
            }
          },
        }, '打开面板'),
      )
    }

    // -- registration ------------------------------------------------------------
    ctx.effect(function () { return styles.insert(CSS.join('\n')) })
    slots.inject(SLOT_MAIN, function () {
      return slots.register({ name: SLOT_MAIN, key: PANEL_ID }, function () { return h(PlanApp, null) })
    })
    slots.inject(SLOT_LIST, function () {
      return slots.register({ name: SLOT_LIST, id: PANEL_ID, order: 5, label: '计划拆解' }, function (props) {
        return h(PlanIcon, { size: (props && props.size) || 18, active: !!(props && props.active) })
      })
    })
    slots.inject(SLOT_TOOL, function () {
      return slots.register({ name: SLOT_TOOL, key: TOOL_KEY }, function () { return h(PlanCard, null) })
    })

    console.log('[plan-decomposition] client apply ' + STAMP + ': panel "' + PANEL_ID + '" registered on ' +
      SLOT_MAIN + ' / ' + SLOT_LIST + ' / ' + SLOT_TOOL)
  },
}
