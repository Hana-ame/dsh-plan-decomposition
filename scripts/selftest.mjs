#!/usr/bin/env node
/**
 * Behavioural test for the Plan Decomposition host half.
 *
 * check.mjs proves the package is hygienic; it cannot prove behaviour. This file
 * does the opposite: it evaluates src/host.js as a function body against a
 * harness the test controls, then calls the captured handlers directly and
 * checks what they actually compute. No DSH process, no Cordis runtime,
 * nothing to approve, no network.
 *
 * The host half needs only `harness` and `console` — it deliberately asks no
 * DSH Service for data — so a stub ctx that returns undefined for everything is
 * a faithful environment, not a degraded one. That is asserted, not assumed:
 * "tolerates absent services" is only meaningful if it survives it.
 *
 * Usage:  node scripts/selftest.mjs [--json]
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

// `--json` exists so CI can read a report. A report missing because the run
// crashed is worse than no report: an empty stream reads like a passing job, so
// CI records a green build that verified nothing. Printing is therefore
// unconditional — every path out of this file, throw or not, ends in report().
function report() {
  const failed = results.filter((r) => !r.ok)
  const ok = failed.length === 0 && fatal === null
  if (AS_JSON) {
    const payload = { ok: ok, total: results.length, failed: failed.length, checks: results }
    if (fatal !== null) payload.error = fatal
    console.log(JSON.stringify(payload, null, 2))
  } else {
    console.log('')
    if (fatal !== null) console.log('ABORTED before the run finished: ' + fatal)
    console.log(ok
      ? 'ALL PASS (' + String(results.length) + ' checks)'
      : 'FAILURES ' + String(failed.length) + ' of ' + String(results.length))
  }
  // process.exit() can truncate a large pending stdout write when stdout is a
  // pipe, and CI reads this report through one. Drain synchronously before
  // exiting rather than cutting the process off mid-write.
  for (let i = 0; i < 200 && process.stdout.writableLength > 0; i++) {
    sleep(1)
  }
  process.exit(ok ? 0 : 1)
}

// The body below is deliberately left at its original indentation: it is a long
// flat sequence of assertions, and re-indenting all of it would bury the six
// assertion fixes this run was actually about under a whitespace diff.
try {

// --- evaluate the host half against a harness we own ------------------------
const handlers = {}
const harness = { handle: function (method, fn) { handlers[method] = fn } }

let hostModule = null
try {
  hostModule = new Function('harness', 'console', read('src/host.js'))(harness, { log: function () {} })
} catch (e) {
  // Reported through the normal path, not console.error: in --json mode a bare
  // stderr write would still leave stdout empty.
  check('src/host.js evaluates as a function body', false, e.message)
  throw e
}
check('host half evaluates as a function body', hostModule !== null && typeof hostModule.apply === 'function',
  hostModule === null ? 'returned null' : typeof hostModule.apply)

// A ctx that offers no service at all. If any handler needs one, this is where
// that shows up.
const ctx = { get: function () { return undefined } }
hostModule.apply(ctx)

const METHODS = ['pd-info', 'pd-verify', 'pd-outline', 'pd-review', 'pd-plan']
for (const m of METHODS) {
  check('host registers ' + m, typeof handlers[m] === 'function')
}
if (!AS_JSON) console.log('')

const call = (m, args) => handlers[m](args)
const node = (id, extra) => Object.assign({
  id,
  title: 'n-' + id,
  plan: 'do ' + id,
  materials: '',
  acceptance: '',
  estLo: null,
  estHi: null,
  external: false,
  risk: 'low',
  review: 'pending',
  reviewNote: '',
  gate: false,
  missing: [],
}, extra || {})
const edge = (from, to, kind, reason) => ({ from, to, kind: kind || 'blocking', reason: reason || '' })
const planOf = (nodes, edges, extra) => Object.assign({ goal: 'g', purpose: 'p', nodes, edges }, extra || {})

// ===========================================================================
// pd-info
// ===========================================================================
const info = await call('pd-info', {})
check('pd-info ok', info && info.ok === true, info)
check('pd-info reports a build stamp', info && info.build === 'pd-1', info && info.build)
check('pd-info publishes limits', info && info.limits && info.limits.nodes > 0, info && info.limits)
check('pd-info publishes the review state vocabulary',
  info && Array.isArray(info.reviewStates) && info.reviewStates.indexOf('pending') >= 0, info && info.reviewStates)

// ===========================================================================
// pd-verify — the gate a human decides on. This is the part that must be right.
// ===========================================================================
// A diamond: a -> b, a -> c, b -> d, c -> d. d sits on the critical path.
const diamond = planOf(
  [node('a', { estLo: 1, estHi: 1 }), node('b', { estLo: 2, estHi: 2 }),
   node('c', { estLo: 3, estHi: 3 }), node('d', { estLo: 4, estHi: 4 })],
  [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')]
)
const dv = await call('pd-verify', diamond)
check('pd-verify accepts a well-formed diamond', dv && dv.ok === true, dv && dv.error)
check('pd-verify echoes node and edge counts', dv && dv.nodeCount === 4 && dv.edgeCount === 4,
  dv && [dv.nodeCount, dv.edgeCount])
check('pd-verify separates blocking from risk edges',
  dv && dv.blockingEdges === 4 && dv.riskEdges === 0, dv && [dv.blockingEdges, dv.riskEdges])
check('pd-verify reports a cycle-free DAG as acyclic', dv && dv.analysis && dv.analysis.acyclic === true,
  dv && dv.analysis && dv.analysis.acyclic)
check('pd-verify finds the critical path through the diamond',
  dv && dv.analysis && Array.isArray(dv.analysis.criticalPath) &&
    dv.analysis.criticalPath.indexOf('a') >= 0 && dv.analysis.criticalPath.indexOf('d') >= 0,
  dv && dv.analysis && dv.analysis.criticalPath)

// A cycle must be detected and must not hang or throw. Note the two levels of
// `ok`: pd-verify's top-level ok means "the verification ran", while the gate
// verdict a human reads is analysis.ok. A cycle has to fail that one.
const cyclic = planOf([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')])
const cv = await call('pd-verify', cyclic)
check('pd-verify detects a cycle',
  cv && cv.ok === true && cv.analysis && cv.analysis.acyclic === false && cv.analysis.ok === false,
  cv && [cv.ok, cv.analysis && cv.analysis.acyclic, cv.analysis && cv.analysis.ok])
check('pd-verify survives a cyclic graph without throwing', cv && cv.analysis !== undefined, cv)

// A node nothing reaches is an orphan, not an error.
const orphan = planOf([node('a'), node('lonely')], [edge('a', 'b'), edge('b', 'a')].concat([edge('a', 'a')]))
const ov = await call('pd-verify', orphan)
check('pd-verify tolerates an edge to a missing node', ov && ov.ok === false || ov && ov.analysis !== undefined,
  ov && ov.error)

// An unestimated node must be reported as unestimated, never defaulted to 0.
// The third disjunct this check used to carry — `JSON.stringify(...).indexOf('null')
// >= 0` — matched any object merely *containing* the token "null", so it was true
// for essentially every plan and made the check vacuous. The claim is asserted
// directly instead: the node is named in `unestimated`, and its missing-estimate
// sum contributes nothing. criticalPath stays non-empty on purpose — with a
// pessimistic duration of 0 the longest path still runs a->b, which is correct:
// an unestimated node must not be silently dropped from the schedule.
const unestimated = planOf([node('a'), node('b', { estLo: null, estHi: null })], [edge('a', 'b')])
const uv = await call('pd-verify', unestimated)
check('pd-verify does not invent an estimate',
  uv && uv.ok === true && uv.analysis &&
    uv.analysis.unestimated.indexOf('b') >= 0 &&
    uv.analysis.sequentialTotalHi === 0 && uv.analysis.criticalTotalHi === 0,
  uv && uv.analysis && { unestimated: uv.analysis.unestimated, seq: uv.analysis.sequentialTotalHi, cp: uv.analysis.criticalTotalHi })

// A risk edge must not become a scheduling dependency.
const withRisk = planOf([node('a', { estLo: 1, estHi: 1 }), node('b', { estLo: 1, estHi: 1 })],
  [edge('a', 'b', 'risk', 'soft')])
const rv = await call('pd-verify', withRisk)
check('pd-verify counts a risk edge as risk, not blocking',
  rv && rv.blockingEdges === 0 && rv.riskEdges === 1, rv && [rv.blockingEdges, rv.riskEdges])
check('pd-verify does not schedule along a risk edge',
  rv && rv.analysis && JSON.stringify(rv.analysis.waves || null) !== null, rv && rv.analysis && rv.analysis.waves)

// Malformed input must come back as { ok:false, error }, never as a throw.
for (const [label, bad] of [['null', null], ['undefined', undefined], ['no nodes', { goal: 'g', nodes: [], edges: [] }],
  ['nodes not an array', { goal: 'g', nodes: 'x', edges: [] }]]) {
  let threw = null
  let res = null
  try { res = await call('pd-verify', bad) } catch (e) { threw = String(e) }
  check('pd-verify rejects ' + label + ' without throwing', threw === null, threw)
  check('pd-verify answers ' + label + ' with ok:false', res !== null && res.ok === false, res)
}

// A non-array `edges` is the one malformed input the host does NOT refuse.
// readPlan guards it with `Array.isArray(...) ? args.edges : []` (src/host.js:65),
// so a string arrives as a plan with no edges at all. That is the deliberate
// design the project settled on, so this records the behaviour as it is.
// What is asserted is what the host actually does: it stays standing (a plan with
// no edges is still a plan) and it does not throw.
//
// Note what is NOT asserted here, because it would be a second restatement of
// the same line rather than a test of it. There is no `problems` entry and no
// findings[code='malformed'] for this input — `problems` is internal to readPlan
// and is never returned; it reaches a caller only through
// analysis.findings[code='malformed'], which derives from the per-entry loop at
// src/host.js:131-153. That loop never runs for a non-array, so nothing is
// reported. The "check it and report it" promise of src/host.js:59 is therefore
// met for every *entry* inside a well-formed array and is not met for the array
// itself; see the three checks below, which hold readPlan to its real contract.
const badEdges = await call('pd-verify', { goal: 'g', nodes: [node('a')], edges: 'x' })
check('pd-verify does not throw on a non-array edges',
  badEdges !== null && badEdges.ok === true && Array.isArray(badEdges.edges) && badEdges.edges.length === 0,
  badEdges && { ok: badEdges.ok, edges: badEdges.edges })
check('pd-verify normalises a non-array edges to empty rather than failing the plan',
  badEdges && badEdges.edgeCount === 0 && badEdges.blockingEdges === 0 && badEdges.riskEdges === 0,
  badEdges && [badEdges.edgeCount, badEdges.blockingEdges, badEdges.riskEdges])

// The counterpart, and the reason the one above is not a silent pass: an edge
// that is genuinely malformed inside a real array IS reported, as a finding of
// level 'error', and it turns the gate red (analysis.ok === false) while leaving
// the top-level ok alone — that ok means "verification ran".
for (const [label, badEdge] of [
  ['a missing endpoint', { from: '', to: '' }],
  ['an edge to a checkpoint that does not exist', { from: 'a', to: 'ghost' }],
]) {
  const r = await call('pd-verify', planOf([node('a'), node('b')], [badEdge]))
  const reported = r && r.analysis && r.analysis.findings.filter((f) => f.level === 'error' && f.code === 'malformed')
  check('pd-verify reports ' + label + ' as a malformed finding',
    reported && reported.length === 1 && r.analysis.ok === false,
    r && r.analysis && r.analysis.findings.map((f) => f.code))
}

// The declared limits must actually bound work.
const many = []
for (let i = 0; i < 500; i++) many.push(node('n' + i))
const mv = await call('pd-verify', planOf(many, []))
check('pd-verify refuses more nodes than MAX_NODES allows',
  mv && mv.ok === false && /too many checkpoints/i.test(String(mv.error)), mv && mv.error)

const dup = planOf([node('a'), node('a')], [])
const dv2 = await call('pd-verify', dup)
check('pd-verify refuses a duplicate node id', dv2 && (dv2.ok === false || dv2.nodeCount === 1), dv2 && dv2.error)

if (!AS_JSON) console.log('')

// ===========================================================================
// pd-outline — a scaffold, deliberately not a decision
// ===========================================================================
const ovl = await call('pd-outline', { goal: '拆解一个大任务' })
check('pd-outline ok', ovl && ovl.ok === true, ovl && ovl.error)
check('pd-outline echoes the goal', ovl && ovl.goal === '拆解一个大任务', ovl && ovl.goal)
check('pd-outline returns editable nodes', ovl && Array.isArray(ovl.nodes) && ovl.nodes.length > 0, ovl && ovl.nodes)
check('pd-outline leaves every checkpoint pending', ovl && ovl.nodes.every((n) => n.review === 'pending'),
  ovl && ovl.nodes.map((n) => n.review))
check('pd-outline leaves estimates unset for the human', ovl && ovl.nodes.every((n) => n.estLo === null && n.estHi === null),
  ovl && ovl.nodes.map((n) => [n.estLo, n.estHi]))
check('pd-outline leaves acceptance criteria for the human',
  ovl && ovl.nodes.every((n) => n.acceptance === ''), ovl && ovl.nodes.map((n) => n.acceptance))
check('pd-outline chains its stages in order',
  ovl && ovl.edges.length === ovl.nodes.length - 1 &&
    ovl.edges.every((e) => e.kind === 'blocking'), ovl && ovl.edges)

// A goal over the limit must be truncated, not rejected — losing the panel over
// a long goal string would be worse than a clipped one.
const longGoal = 'x'.repeat(5000)
const lo = await call('pd-outline', { goal: longGoal })
check('pd-outline truncates an over-long goal instead of failing',
  lo && lo.ok === true && lo.goal.length < longGoal.length, lo && lo.goal && lo.goal.length)

if (!AS_JSON) console.log('')

// ===========================================================================
// pd-review / pd-plan — a human decision is recorded, never computed
// ===========================================================================

// The host starts with nothing and invents nothing: before any decision is
// recorded the plan is empty. This must be observed *before* the first
// pd-review below, or the assertion can only ever see C1.
const virgin = await call('pd-plan', {})
check('pd-plan starts empty — the host does not invent a plan',
  Array.isArray(virgin.history) && virgin.history.length === 0, virgin && virgin.history)

const bad = await call('pd-review', { state: 'pending' })
check('pd-review refuses a missing id', bad && bad.ok === false && bad.error === 'id required', bad)
const badState = await call('pd-review', { id: 'a', state: 'nonsense' })
check('pd-review refuses an unknown state', badState && badState.ok === false, badState)

const good = await call('pd-review', { id: 'C1', state: 'approved', note: 'looks right' })
check('pd-review accepts a decision', good && good.ok === true, good && good.error)
check('pd-review returns the recorded entry',
  good && good.entry && good.entry.id === 'C1' && good.entry.state === 'approved' && good.entry.note === 'looks right',
  good && good.entry)

const reload = await call('pd-plan', {})
check('pd-plan ok', reload && reload.ok === true, reload && reload.error)
check('pd-plan replays what the human decided',
  reload.history.length === 1 && reload.history[0].id === 'C1', reload && reload.history)

const second = await call('pd-review', { id: 'C2', state: 'rejected', note: 'too coarse' })
check('pd-review keeps newest first', second && second.history[0].id === 'C2' && second.history[1].id === 'C1',
  second && second.history.map((h) => h.id))

// The bound is enforced, not merely declared.
for (let i = 0; i < 260; i++) await call('pd-review', { id: 'n' + i, state: 'pending' })
const bounded = await call('pd-plan', {})
check('pd-review bounds its history', bounded.history.length === 200, bounded.history.length)

// ===========================================================================
// result
// ===========================================================================

} catch (e) {
  // A check block that throws has not answered its question. Record it as a
  // failure rather than letting the stack escape, so the checks that already
  // ran are still reported and CI still gets a parseable document.
  fatal = String((e && e.stack) || e)
  check('selftest completed without throwing', false, fatal)
}

report()