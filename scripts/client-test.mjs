#!/usr/bin/env node
/**
 * Behavioural test for the Plan Decomposition client half.
 *
 * selftest.mjs does this for src/host.js: evaluate the half, call its handlers,
 * assert what they compute. Nothing here did the same for src/client.js, so all
 * 52 selftest checks and all 26 check.mjs checks could pass while the panel
 * rendered nothing at all. Mutation testing confirmed it: replacing
 * `const h = React.createElement` with `() => null` left every gate green.
 *
 * WHY THIS NEEDS NO DSH. The client half is a function body evaluated the same
 * way the Cordis evaluator does. `apply(ctx)` takes a ctx we own, and every
 * component it registers is an ordinary function we can call. Seven of the
 * eight components use no hooks at all; the eighth (PlanApp) needs one
 * useState cell. A React double good enough to render them is ~20 lines and is
 * written out below rather than imported, because there are no dependencies.
 *
 * The register-on-mount contract in client.js:1439-1450 is exercised here: the
 * registered component is called for real and the resulting element tree is
 * walked and asserted. That is the step no gate took.
 *
 * Usage:  node scripts/client-test.mjs [--json]
 * Exit:   0 when every check passes, 1 otherwise.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const AS_JSON = process.argv.includes('--json')

const results = []
let fatal = null

function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: cond ? null : JSON.stringify(detail === undefined ? null : detail) })
  if (!AS_JSON) {
    console.log((cond ? '  ok    ' : '  FAIL  ') + name + (cond ? '' : '   -> ' + JSON.stringify(detail === undefined ? null : detail)))
  }
}

// Unconditional printing, same reasoning as selftest.mjs:38-41 — a missing
// report reads like a passing job.
function report() {
  const failed = results.filter((r) => !r.ok)
  const ok = failed.length === 0 && fatal === null
  if (AS_JSON) {
    const payload = { ok, total: results.length, failed: failed.length, checks: results }
    if (fatal !== null) payload.error = fatal
    console.log(JSON.stringify(payload, null, 2))
  } else {
    console.log('')
    if (fatal !== null) console.log('ABORTED before the run finished: ' + fatal)
    console.log(ok ? 'ALL PASS (' + String(results.length) + ' checks)' : 'FAILURES ' + String(failed.length) + ' of ' + String(results.length))
  }
  for (let i = 0; i < 200 && process.stdout.writableLength > 0; i++) sleep(1)
  process.exit(ok ? 0 : 1)
}

// ===========================================================================
// React double.
//
// Real React does not call a component passed as a child at createElement
// time; it keeps it as an element of that type and invokes it during
// reconciliation. So createElement stores children untouched and `render()`
// below walks the tree, calling function components with a fresh hook cursor
// per component. Calling them at createElement time (the naive double) renders
// every component zero times and every assertion built on it passes vacuously.
// ===========================================================================
let hookCursor = null
const hooksOf = { effects: [] }
const React = {
  createElement(type, props, ...kids) {
    return {
      __el: true,
      type,
      props: props || {},
      kids: kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false && k !== true),
    }
  },
  useState(init) {
    const i = hookCursor.i++
    const cells = hookCursor.cells
    if (cells[i] === undefined) cells[i] = { v: typeof init === 'function' ? init() : init }
    const c = cells[i]
    c.set = (nv) => { c.v = typeof nv === 'function' ? nv(c.v) : nv }
    return [c.v, c.set]
  },
  useEffect(fn) { hooksOf.effects.push(fn) },
  useMemo(fn) { return fn() },
  useRef(v) { return { current: v === undefined ? null : v } },
}

// Render one component: fresh hook cells, effects queued not run (this is a
// single-pass render; the mount effect is exercised separately below).
function renderComponent(fn, props) {
  const prev = hookCursor
  const effects = []
  hookCursor = { i: 0, cells: [] }
  hooksOf.effects = effects
  let tree
  let err = null
  try { tree = fn(props) } catch (e) { err = e }
  hookCursor = prev
  return { tree, effects, err }
}

// Walk a rendered tree. `fn` receives every element. Function-typed children
// (components) are left alone — we assert on the element tree, not on React's
// reconciliation.
function walk(node, fn) {
  if (!node || typeof node !== 'object') return
  if (node.__el) fn(node)
  if (node.kids) for (const k of node.kids) walk(k, fn)
}
function elementsOf(tree) { const out = []; walk(tree, (e) => out.push(e)); return out }
function textsOf(tree) {
  const out = []
  const rec = (n) => {
    if (n === null || n === undefined || n === false || n === true) return
    if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return }
    if (typeof n === 'object') for (const k of (n.kids || [])) rec(k)
  }
  rec(tree)
  return out
}

try {

// ===========================================================================
// Load the real client half, the way the Cordis evaluator does.
// ===========================================================================
const clientSrc = read('src/client.js')

let plugin = null
try {
  const half = new Function('React', 'styles', 'host', 'harness', 'console', clientSrc)
  plugin = half(React, { insert: () => ({ remove() {} }) }, { call: async () => ({ ok: true }) }, undefined, { log() {}, error() {} })
} catch (e) {
  check('client half evaluates as a function body', false, e.message)
  throw e
}
check('client half evaluates as a function body', plugin !== null && typeof plugin.apply === 'function',
  plugin === null ? 'returned null' : typeof plugin.apply)

// --- a ctx we own ----------------------------------------------------------
const registrations = []
const slots = {
  inject(name, fn) { fn() },
  register(spec, component) { registrations.push({ spec, component }); return {} },
}
let insertedCss = null
let effectRan = 0
const styles = { insert(css) { insertedCss = css; return { remove() {} } } }
const ctx = {
  get(name) {
    if (name === 'slots') return slots
    if (name === 'timer') return { timeout: () => new Promise(() => {}) }
    return undefined
  },
  effect(fn) { effectRan++; fn() },
}
const clientErrors = []
const quiet = { log() {}, error() { clientErrors.push(String(arguments[0])) } }

const clientPlugin = new Function('React', 'styles', 'host', 'harness', 'console', clientSrc)(
  React, styles, { call: async () => ({ ok: true }) }, undefined, quiet)
try {
  clientPlugin.apply(ctx)
  check('client half applies against a stub ctx', true)
} catch (e) {
  check('client half applies against a stub ctx', false, e.message)
}
check('client half registers three slots', registrations.length === 3, registrations.map((r) => r.spec && r.spec.name))
if (!AS_JSON) console.log('')

// ===========================================================================
// A. GraphSVG — "can a person read this graph". Highest priority: it is the
// entire visual half of the panel, and it is pure (no hooks).
// ===========================================================================

// GraphSVG is reached through the registered component at client.js:1441:
// `function () { return h(PlanApp, null) }`. Because the wrapper *returns* the
// element rather than nesting it, the value that wrapper produces IS the
// PlanApp element — so this is the component, not something containing one.
// That hop is asserted below, so a refactor of the registration cannot silently
// orphan every GraphSVG check in this file.
const mainReg = registrations.filter((r) => r.spec && r.spec.name === 'main')[0]
check('main slot registers a component', !!mainReg, registrations.map((r) => r.spec && r.spec.name))

let PlanApp = null
if (mainReg) {
  const wrapped = renderComponent(mainReg.component, {})
  check('main component renders without throwing', wrapped.err === null, wrapped.err && wrapped.err.message)
  check('main component returns the PlanApp element',
    !!wrapped.tree && typeof wrapped.tree.type === 'function', wrapped.tree && typeof wrapped.tree.type)
  if (wrapped.tree && typeof wrapped.tree.type === 'function') PlanApp = wrapped.tree.type
}

function findComponentType(tree, pred) {
  let found = null
  walk(tree, (e) => { if (found === null && typeof e.type === 'function' && pred(e.type)) found = e.type })
  return found
}

// The state the panel holds after a successful verify: what GraphSVG receives.
const st4 = (nodes, edges, analysis, extra) => Object.assign({
  selected: null, mock: false, busy: false, verifying: false, error: null, notice: null,
  history: [], drafts: {}, draftSeq: 0, gen: 0, verifyAt: 0, showFindings: true, showHistory: true,
  info: { ok: true, build: 'pd-1' }, nodes, edges, analysis,
}, extra || {})

// A four-node diamond: a->b, a->c, b->d, c->d. d is on the critical path.
const N = (id, extra) => Object.assign({
  id, title: 'n-' + id, plan: '', materials: '', acceptance: '',
  estLo: null, estHi: null, external: false, risk: 'low',
  review: 'pending', reviewNote: '', gate: false, missing: [],
}, extra || {})
const E = (from, to, kind) => ({ from, to, kind: kind || 'blocking', reason: '' })

const diaNodes = [N('a'), N('b'), N('c'), N('d')]
const diaEdges = [E('a', 'b'), E('a', 'c'), E('b', 'd'), E('c', 'd')]
const diaAnalysis = {
  waves: [{ wave: 0, nodes: ['a'] }, { wave: 1, nodes: ['b', 'c'] }, { wave: 2, nodes: ['d'] }],
  criticalPath: ['a', 'b', 'd'],
  onCriticalPath: { a: true, b: true, d: true },
  acyclic: true, ok: true,
}

// Obtain the real GraphSVG function. GraphSVG is only rendered when the panel
// has nodes (:1360 `st.nodes.length === 0 ? null : ...`), and the panel's store
// is filled by the 「示例」 button. So we drive that button for real: locate it in
// the rendered bar, invoke its onClick, let the microtask settle, and re-render.
// GraphSVG is then found by identity in the resulting tree. This keeps the test
// pointed at the real function rather than a transcription of it, and it
// exercises the demo-plan path a user actually takes.
let GraphSVG = null
if (PlanApp) {
  const app = renderComponent(PlanApp, null)
  check('PlanApp renders over an empty store without throwing', app.err === null, app.err && app.err.message)

  const demoBtn = elementsOf(app.tree).filter((e) => e.type === 'button' && e.props.onClick)[1]
  check('PlanApp offers a demo-plan button', !!demoBtn, elementsOf(app.tree).filter((e) => e.type === 'button').length)
  if (demoBtn) {
    try { demoBtn.props.onClick() } catch (e) { check('demo-plan button does not throw', false, e.message) }
    // let verifyNow()'s host call settle
    for (let i = 0; i < 8; i++) await Promise.resolve()
    await new Promise((r) => setImmediate(r))
    const app2 = renderComponent(PlanApp, null)
    check('PlanApp renders over a populated store without throwing', app2.err === null, app2.err && app2.err.message)
    GraphSVG = findComponentType(app2.tree, (t) => t.name === 'GraphSVG')
    check('the populated PlanApp tree contains the real GraphSVG', !!GraphSVG, GraphSVG ? 'found' : 'GraphSVG not present in tree')
    // Guard: if GraphSVG were never found, every A-class check below would run
    // against `undefined` and could pass vacuously. Assert it is callable.
    check('the GraphSVG obtained is a callable component', typeof GraphSVG === 'function', typeof GraphSVG)
  }
}

// GraphSVG is hook-free: it takes { state, nodes, edges, analysis } and reads
// nothing else, so it is called directly with props we control.
const callGraph = (props) => {
  if (typeof GraphSVG !== 'function') return { err: new Error('GraphSVG unavailable') }
  return renderComponent(GraphSVG, props)
}

// The two arrow markers in <defs> (:937-946) are also <path> elements with a
// `d`. They are told apart from real edges by `markerEnd`, which only
// edgeShape sets (:961). Counting "all paths" would silently include them and
// make every count off by two — so every edge assertion below filters on
// markerEnd. Counted naively, a one-edge graph reads as 3 and a diamond as 6.
const edgePathsOf = (tree) => elementsOf(tree).filter((e) => e.type === 'path' && e.props.markerEnd)

// --- A1: empty graph --------------------------------------------------------
{
  const r = callGraph({ state: st4([], [], null), nodes: [], edges: [], analysis: null })
  check('GraphSVG renders an empty graph without throwing', r.err === null, r.err && r.err.message)
  const txt = textsOf(r.tree)
  check('empty graph says there is no plan', txt.some((t) => t.indexOf('还没有计划') >= 0), txt)
  check('empty graph draws no svg edge', edgePathsOf(r.tree).length === 0, edgePathsOf(r.tree).length)
}

// --- A2: single node -------------------------------------------------------
{
  const nodes = [N('solo')]
  const r = callGraph({ state: st4(nodes, [], null), nodes, edges: [], analysis: null })
  check('GraphSVG renders a single node without throwing', r.err === null, r.err && r.err.message)
  check('single node produces one svg root', elementsOf(r.tree).filter((e) => e.type === 'svg').length === 1)
}

// --- A3: single edge -------------------------------------------------------
{
  const nodes = [N('a'), N('b')]
  const edges = [E('a', 'b')]
  const an = { waves: [{ wave: 0, nodes: ['a'] }, { wave: 1, nodes: ['b'] }], criticalPath: ['a', 'b'], onCriticalPath: { a: true, b: true }, acyclic: true }
  const r = callGraph({ state: st4(nodes, edges, an), nodes, edges, analysis: an })
  check('GraphSVG renders one edge without throwing', r.err === null, r.err && r.err.message)
  const paths = edgePathsOf(r.tree)
  check('one edge draws one edge path', paths.length === 1, paths.length)
  check('one edge draws a finite path', /M\s+-?\d/.test(String(paths[0] && paths[0].props.d)) && !/NaN|Infinity/.test(String(paths[0] && paths[0].props.d)),
    paths[0] && paths[0].props.d)
}

// --- A4: diamond, acyclic --------------------------------------------------
{
  const r = callGraph({ state: st4(diaNodes, diaEdges, diaAnalysis), nodes: diaNodes, edges: diaEdges, analysis: diaAnalysis })
  check('GraphSVG renders the diamond without throwing', r.err === null, r.err && r.err.message)
  const els = elementsOf(r.tree)
  const paths = edgePathsOf(r.tree)
  check('diamond draws four edge paths', paths.length === 4, paths.length)
  // Every coordinate must be finite. NaN or Infinity in a `d` attribute is
  // invisible in the DOM and silently drops the edge in some renderers.
  const badD = paths.filter((p) => /NaN|Infinity|undefined/.test(String(p.props.d)))
  check('no edge path contains NaN/Infinity/undefined', badD.length === 0, badD.map((p) => p.props.d).slice(0, 2))
  // Node labels present.
  const txt = textsOf(r.tree)
  check('diamond draws all four node ids', ['a', 'b', 'c', 'd'].every((id) => txt.indexOf(id) >= 0), txt)
}

// --- A5: the 未定位 warning column (cycle members) ---------------------------
// When the host reports no waves for a node (it is inside a cycle), layout
// appends it to a last column and captions it 未定位 with warn=true. GraphSVG
// draws that caption in the error colour and bold. This is the only signal the
// reader gets that the graph is not a schedule. If it goes missing the reader
// sees a graph that looks fine and is not.
{
  // b and c are cycle members: the host placed neither in any wave.
  const nodes = [N('a'), N('b'), N('c')]
  const edges = [E('a', 'b'), E('b', 'c'), E('c', 'a')]
  const an = { waves: [{ wave: 0, nodes: ['a'] }], criticalPath: ['a'], onCriticalPath: { a: true }, acyclic: false, ok: false }
  const r = callGraph({ state: st4(nodes, edges, an), nodes, edges, analysis: an })
  check('GraphSVG renders a cyclic graph without throwing', r.err === null, r.err && r.err.message)
  const txt = textsOf(r.tree)
  check('cycle members are labelled 未定位', txt.some((t) => t === '未定位'), txt.filter((t) => t.indexOf('未') >= 0))
  // The warning caption must carry the error colour, distinct from a real wave.
  const errCaptions = elementsOf(r.tree).filter((e) =>
    e.type === 'text' && String(e.props.fill || '').indexOf('state-error') >= 0)
  check('未定位 caption uses the error colour', errCaptions.length >= 1, errCaptions.length)
}

// --- A6: routeEdges marks only ADJACENT critical steps -----------------------
// A critical edge is a consecutive pair on the host's criticalPath, not merely
// two endpoints that are both on the path. In the diamond, a->b->d is the path;
// a->c, a->d (absent), c->d share endpoints with path nodes but are not steps.
// Over-marking floods the reader with highlighted edges and hides the one chain
// they are meant to follow — the comment at client.js:949-952 says exactly this.
{
  const an = Object.assign({}, diaAnalysis, {
    criticalPath: ['a', 'b', 'd'],
    onCriticalPath: { a: true, b: true, d: true },
  })
  const r = callGraph({ state: st4(diaNodes, diaEdges, an), nodes: diaNodes, edges: diaEdges, analysis: an })
  check('critical-edge fixture renders', r.err === null, r.err && r.err.message)
  const paths = edgePathsOf(r.tree)
  // Critical edges are drawn last with strokeWidth 2.4 (edgeShape, :963).
  const critical = paths.filter((p) => p.props.strokeWidth === 2.4)
  const nonCrit = paths.filter((p) => p.props.strokeWidth !== 2.4)
  // a->b and b->d are consecutive on [a,b,d]. a->c and c->d share an endpoint
  // with the path but are not steps, so neither may be highlighted.
  check('the diamond fixture draws four edges to split', paths.length === 4, paths.length)
  check('only adjacent critical steps are highlighted', critical.length === 2, { total: paths.length, critical: critical.length })
  // The counterpart, and the reason the one above is not a silent pass: the
  // two remaining edges must be present AND unhighlighted. If routeEdges stopped
  // drawing edges the count would still read 2+2.
  check('the non-adjacent edges are drawn but not marked critical', nonCrit.length === 2, nonCrit.length)
  check('a critical edge uses the warning colour, a plain one does not',
    critical.every((p) => String(p.props.stroke).indexOf('state-warning') >= 0) &&
    nonCrit.every((p) => String(p.props.stroke).indexOf('state-warning') < 0),
    { crit: critical.map((p) => p.props.stroke), plain: nonCrit.map((p) => p.props.stroke) })
}

// --- A7: a shortcut edge whose BOTH endpoints are on the critical path ------
//
// Mutation testing found the check above cannot tell the two implementations
// apart. In the diamond, a->c and c->d each have an endpoint OFF the path, so
// "both endpoints on the path" and "consecutive pair on the path" agree on
// every edge and the fixture cannot separate them. They differ only on a
// shortcut: an edge between two path nodes that is not a step of the path.
//
//   path    a -> b -> d
//   extra   a -> d  skips b
//
// `a -> d` has both endpoints on the path but is not consecutive, so it must
// NOT be highlighted. This is the assertion that makes the rule testable; the
// diamond above is kept because it is the shape a reader actually meets, but
// on its own it would let the wrong implementation through — that was found by
// mutation, not by reading.
{
  const nodes = [N('a'), N('b'), N('d')]
  const edges = [E('a', 'b'), E('b', 'd'), E('a', 'd')]  // a->d is the shortcut
  const an = {
    waves: [{ wave: 0, nodes: ['a'] }, { wave: 1, nodes: ['b'] }, { wave: 2, nodes: ['d'] }],
    criticalPath: ['a', 'b', 'd'],
    onCriticalPath: { a: true, b: true, d: true },
    acyclic: true, ok: true,
  }
  const r = callGraph({ state: st4(nodes, edges, an), nodes, edges, analysis: an })
  check('shortcut fixture renders', r.err === null, r.err && r.err.message)
  const paths = edgePathsOf(r.tree)
  const critical = paths.filter((p) => p.props.strokeWidth === 2.4)
  check('the shortcut fixture draws three edges', paths.length === 3, paths.length)
  // a->b and b->d are consecutive. a->d is not, though both its endpoints are
  // on the path — so exactly two edges may be highlighted.
  check('a shortcut between path nodes is NOT marked critical', critical.length === 2,
    { total: paths.length, critical: critical.length })
  // And the shortcut must actually be present, unhighlighted — otherwise the
  // check above could be satisfied by the edge simply not being drawn.
  const shortcutDrawn = paths.filter((p) => p.props.strokeWidth !== 2.4)
  check('the shortcut edge is drawn, just not highlighted', shortcutDrawn.length === 1, shortcutDrawn.length)
}

// --- A8: risk edges are dashed, blocking edges are not ----------------------
// The comment at client.js:911-915 promises the distinction survives
// monochrome: blocking solid, risk dashed. That promise is only testable on the
// rendered path, and it is the difference between "soft dependency" and
// "scheduling gate" as the reader sees them.
{
  const nodes = [N('a'), N('b')]
  const edges = [E('a', 'b', 'risk'), E('b', 'a', 'blocking')]
  const an = { waves: [{ wave: 0, nodes: ['a'] }, { wave: 1, nodes: ['b'] }], criticalPath: [], onCriticalPath: {}, acyclic: true }
  const r = callGraph({ state: st4(nodes, edges, an), nodes, edges, analysis: an })
  check('risk fixture renders', r.err === null, r.err && r.err.message)
  const dashed = edgePathsOf(r.tree).filter((p) => p.props.strokeDasharray === '5 4')
  const solid = edgePathsOf(r.tree).filter((p) => !p.props.strokeDasharray)
  check('the risk edge is dashed', dashed.length === 1, dashed.length)
  check('the blocking edge is solid', solid.length === 1, solid.length)
  check('a risk edge is drawn thinner than a blocking edge',
    dashed.length === 1 && solid.length === 1 && dashed[0].props.strokeWidth < solid[0].props.strokeWidth,
    { risk: dashed[0] && dashed[0].props.strokeWidth, blocking: solid[0] && solid[0].props.strokeWidth })
}

if (!AS_JSON) console.log('')

// ===========================================================================
// B. The pack*/normalise* seam between the two halves.
//
// The host half is verified in selftest.mjs against fixtures written to the
// host's own expectations, so a client that packs the wrong shape still agrees
// with those fixtures. These checks close that seam: packPlan output is fed to
// the real host readPlan and must be accepted.
// ===========================================================================
// The pure helpers are module-scope, so they are callable without a DSH. We
// evaluate the module's pure section the same way the runtime does: the whole
// file up to its top-level `return { apply }`.
const cut = clientSrc.split('\n').findIndex((l) => /^return \{$/.test(l))
check('client pure section has a module-scope return boundary', cut > 0, cut)
const pureSrc = clientSrc.split('\n').slice(0, cut).join('\n') +
  '\n;return { merge, clamp, num, isNum, fmtTime, estText, durText, clip, uniq, arr, obj, reviewMeta, riskMeta, findingMeta, packNode, packEdge, packPlan, normaliseNodes, normaliseEdges, layout, routeEdges, mockOutline, demoPlan }\n'
let M = null
try {
  M = new Function('React', pureSrc)(React)
  check('client pure helpers evaluate without DSH', M !== null)
} catch (e) {
  check('client pure helpers evaluate without DSH', false, e.message)
}

// --- load the host for the seam check --------------------------------------
let hostHandlers = {}
try {
  const hostHalf = new Function('harness', 'console', read('src/host.js'))
  const hmod = hostHalf({ handle: (m, fn) => { hostHandlers[m] = fn } }, { log() {} })
  hmod.apply({ get: () => undefined })
  check('host half is available for the seam check', typeof hostHandlers['pd-verify'] === 'function')
} catch (e) {
  check('host half is available for the seam check', false, e.message)
}

// --- B1: packPlan output is accepted by the host --------------------------
if (M && typeof hostHandlers['pd-verify'] === 'function') {
  const demo = M.demoPlan()
  const packed = M.packPlan(demo.nodes, demo.edges, demo.goal, demo.purpose)
  check('packPlan output carries exactly the node fields the host reads',
    ['id', 'title', 'estLo', 'estHi', 'risk', 'review', 'gate'].every((k) => k in packed.nodes[0]), Object.keys(packed.nodes[0]))
  check('packPlan output carries exactly the edge fields the host reads',
    ['from', 'to', 'kind', 'reason'].every((k) => k in packed.edges[0]), Object.keys(packed.edges[0]))
  const res = await hostHandlers['pd-verify'](packed)
  check('host accepts a plan packed by the client', res && res.ok === true, res && res.error)
  if (res && res.ok === true) {
    check('host echoes back every node the client packed', res.nodeCount === demo.nodes.length, { got: res.nodeCount, want: demo.nodes.length })
    check('host finds no malformed entries in a client-packed plan',
      res.analysis.findings.filter((f) => f.code === 'malformed').length === 0,
      res.analysis.findings.filter((f) => f.code === 'malformed'))
    check('host computes a critical path over a client-packed plan',
      Array.isArray(res.analysis.criticalPath) && res.analysis.criticalPath.length > 0, res.analysis.criticalPath)
  }

  // A risk edge must survive the client's pack as `risk`. If packEdge collapsed
  // everything to blocking, the host would schedule along a soft dependency and
  // the client's own "risk edges are dashed" rendering would lie.
  const riskDemo = M.demoPlan()
  const packedRisk = M.packPlan(riskDemo.nodes, riskDemo.edges, 'g', 'p')
  const riskRes = await hostHandlers['pd-verify'](packedRisk)
  if (riskRes && riskRes.ok === true) {
    check('client preserves risk edges through packPlan', riskRes.riskEdges >= 1, { riskEdges: riskRes.riskEdges })
  }
}

// --- B2: packNode never fabricates an estimate -----------------------------
if (M) {
  const noEst = M.packNode({ id: 'x' })
  check('packNode leaves a missing estimate null, not 0', noEst.estLo === null && noEst.estHi === null, { estLo: noEst.estLo, estHi: noEst.estHi })
  const withEst = M.packNode({ id: 'x', estLo: 0, estHi: 5 })
  check('packNode keeps a real zero estimate (0h is a claim)', withEst.estLo === 0, withEst.estLo)
  const badEst = M.packNode({ id: 'x', estLo: -3, estHi: 'abc' })
  check('packNode refuses a negative or non-numeric estimate', badEst.estLo === null && badEst.estHi === null, { estLo: badEst.estLo, estHi: badEst.estHi })
  check('packNode defaults a missing review state to pending', M.packNode({ id: 'x' }).review === 'pending', M.packNode({ id: 'x' }).review)
  // packNode is the client's whitelist. Assert the key SET exactly, not that
  // one particular field is absent: `!('missing' in ...)` passes for every
  // implementation that returns a fixed literal, including one that has since
  // grown a field — which is how a leaked field reaches the host unnoticed.
  // Mutation testing caught that version of this check (it was vacuous).
  const PACKED_KEYS = ['id', 'title', 'plan', 'materials', 'acceptance',
    'estLo', 'estHi', 'external', 'risk', 'review', 'reviewNote', 'gate']
  const packedKeys = Object.keys(M.packNode({ id: 'x', missing: ['estimate'], sneaky: 1 }))
  check('packNode emits exactly its whitelist, in order',
    JSON.stringify(packedKeys) === JSON.stringify(PACKED_KEYS), packedKeys)
  check('packNode smuggles nothing through from its input', packedKeys.length === PACKED_KEYS.length, packedKeys.length)
}

// --- B3: packEdge kind ------------------------------------------------------
if (M) {
  check('packEdge keeps a risk edge as risk', M.packEdge({ from: 'a', to: 'b', kind: 'risk' }).kind === 'risk')
  check('packEdge defaults an unknown kind to blocking', M.packEdge({ from: 'a', to: 'b', kind: 'nonsense' }).kind === 'blocking')
  check('packEdge stringifies numeric endpoints', M.packEdge({ from: 1, to: 2 }).from === '1' && M.packEdge({ from: 1, to: 2 }).to === '2')
}

// --- B4: normaliseEdges drops ghost endpoints -------------------------------
if (M) {
  const ids = ['a', 'b']
  const kept = M.normaliseEdges([E('a', 'b'), { from: 'a', to: 'ghost' }, { from: 1, to: 'b' }, null], ids)
  check('normaliseEdges keeps only edges between known nodes', kept.length === 1 && kept[0].from === 'a' && kept[0].to === 'b', kept)
  check('normaliseEdges on a non-array edges yields none', M.normaliseEdges('x', ids).length === 0)
  check('normaliseEdges keeps a risk edge as risk', M.normaliseEdges([E('a', 'b', 'risk')], ids)[0].kind === 'risk')
}

// --- B5: normaliseNodes coerces the review vocabulary -----------------------
if (M) {
  const out = M.normaliseNodes([
    { id: 'a', review: 'approved' },
    { id: 'a', review: 'rejected' },  // duplicate id — first wins
    { title: 'no id' },               // dropped
    { id: 'b', review: 'NOT-A-STATE' },
  ])
  check('normaliseNodes drops duplicate ids, keeping the first', out.filter((n) => n.id === 'a').length === 1, out.map((n) => n.id))
  check('normaliseNodes drops a node with no id', out.length === 2, out.map((n) => n.id))
  const b = out.filter((n) => n.id === 'b')[0]
  check('normaliseNodes coerces an unknown review state to pending', b && b.review === 'pending', b && b.review)
  check('normaliseNodes on a non-array yields none', M.normaliseNodes(null).length === 0)
}

// --- B6: the client's normalised round-trip agrees with the host ------------
// verifyNow (:787-800) compares host-normalised rows against its own with
// sameIds and only adopts the host's version when the id sets match. This is
// the seam where a shape disagreement would silently discard the human's edits.
if (M && typeof hostHandlers['pd-verify'] === 'function') {
  const demo = M.demoPlan()
  const clientNodes = M.normaliseNodes(demo.nodes)
  const clientEdges = M.normaliseEdges(demo.edges, clientNodes.map((n) => n.id))
  const round = await hostHandlers['pd-verify'](M.packPlan(clientNodes, clientEdges, demo.goal, demo.purpose))
  if (round && round.ok === true) {
    const hostNodes = M.normaliseNodes(round.nodes)
    const sameId = (a, b) => a.length === b.length && a.every((n, i) => n.id === b[i].id)
    check('client and host normalise a plan to the same ids', sameId(hostNodes, clientNodes),
      { client: clientNodes.map((n) => n.id), host: hostNodes.map((n) => n.id) })
  }
}

if (!AS_JSON) console.log('')

// ===========================================================================
// C. Text formatting. Small, but these strings are the estimates a reader
// relies on. 未估 is an admitted gap; 0h is a false claim.
// ===========================================================================
if (M) {
  check('estText renders a missing estimate as 未估', M.estText(null) === '未估', M.estText(null))
  check('estText renders a fractional estimate as typed', M.estText(0.5) === '0.5h', M.estText(0.5))
  check('estText drops the decimal above 10h (no column jitter)', M.estText(12.34) === '12.3h', M.estText(12.34))
  check('durText renders a missing total as an em dash', M.durText(null) === '—', M.durText(null))
  check('durText renders a real total', M.durText(3) === '3h', M.durText(3))
  check('clip truncates and adds an ellipsis', M.clip('abcdefgh', 4) === 'abc…', M.clip('abcdefgh', 4))
  check('clip leaves a short string alone', M.clip('ab', 4) === 'ab', M.clip('ab', 4))
  check('uniq removes duplicates and empty entries', JSON.stringify(M.uniq([1, 1, null, 2, undefined, 2])) === '[1,2]', M.uniq([1, 1, null, 2, undefined, 2]))
  check('num refuses to coerce a blank or negative to a number',
    M.num('') === null && M.num(-1) === null && M.num('abc') === null, [M.num(''), M.num(-1), M.num('abc')])
  check('num parses a real numeric string', M.num('3.5') === 3.5, M.num('3.5'))
}

if (!AS_JSON) console.log('')

// ===========================================================================
// D. The stylesheet, injected through ctx.effect (client.js:1439).
// Asserted from what styles.insert received, not from the source text.
// ===========================================================================
check('client inserts its stylesheet through ctx.effect', effectRan === 1 && insertedCss !== null, { effectRan, hasCss: insertedCss !== null })
if (insertedCss !== null) {
  check('the injected stylesheet is non-empty', insertedCss.trim().length > 0, insertedCss.length)
  check('the stylesheet defines the panel root class', /\.pd-root\s*\{/.test(insertedCss))
  check('the stylesheet defines the graph and list classes used by the panel',
    /\.pd-svg\s*\{/.test(insertedCss) && /\.pd-list\s*\{/.test(insertedCss),
    { svg: /\.pd-svg\s*\{/.test(insertedCss), list: /\.pd-list\s*\{/.test(insertedCss) })
  check('the stylesheet carries no unresolved placeholder',
    !/\{\{|\}\}|undefined|NaN/.test(insertedCss), (insertedCss.match(/undefined|NaN/) || [])[0])
}
check('client reported no error during apply', clientErrors.length === 0, clientErrors.slice(0, 2))

// ===========================================================================
// result
// ===========================================================================
} catch (e) {
  fatal = String((e && e.stack) || e)
  check('client-test completed without throwing', false, fatal)
}

report()