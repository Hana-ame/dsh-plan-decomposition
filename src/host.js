// ============================================================================
// Plan Decomposition — Host half.
//
// This file is the content of `code.host` for the cordis_define tool: a plain
// JavaScript function body returning a Cordis Plugin. It owns the graph algebra
// — validation, topological levels, the critical path — that the Client half
// draws and that a human intervenes in.
//
// Design premise: this plugin exists so a person can supervise a large task the
// LLM has broken into stages. So the host does not decide anything for the
// human. It reports what the graph says and refuses to invent judgement: an
// unestimated checkpoint is reported as unestimated, never defaulted.
//
// Rules this half obeys (they are also enforced by scripts/check.mjs):
//   * every handler answers an owned JSON value — never a live DSH object;
//   * every handler tolerates an absent Service (`ctx.get` + undefined check)
//     and reports it as `{ ok: false, error }` instead of throwing;
//   * nothing reads or writes the filesystem.
//
// The RPC surface (all methods are prefixed `pd-` to avoid colliding with any
// other dynamic package in the same process):
//
//   pd-info      -> service availability + limits, for the client's status line
//   pd-verify    -> validate one plan graph: acyclicity, waves, critical path,
//                   reachability and orphans — the gate a human relies on
//   pd-outline   -> a scaffold decomposition for a goal, as editable nodes
//   pd-review    -> record a human's decision about one checkpoint
//   pd-plan      -> the last reviewed plan, for reloading the panel
// ============================================================================

// Build stamp. It must equal STAMP in src/client.js — scripts/check.mjs enforces
// that — so the client can prove the two halves that are actually running in
// the process belong to the same iteration.
const BUILD = 'pd-1'

// Limits. They exist so a malformed or hostile plan cannot make this half spin:
// the algorithms below are O(V + E) per pass and none of them recurse.
const MAX_NODES = 400
const MAX_EDGES = 2000
const MAX_ID_CHARS = 64
const MAX_TEXT_CHARS = 4000
const MAX_GOAL_CHARS = 2000
const MAX_HISTORY = 200

// A checkpoint's human-supervision state. `pending` is the only state the LLM
// may set on its own; everything else records that a person acted.
const REVIEW_STATES = ['pending', 'approved', 'rejected', 'edited', 'skipped']
// Risk is carried by the human or the decomposition, never guessed here.
const RISK_LEVELS = ['low', 'medium', 'high']

const fail = (e) => ({ ok: false, error: String((e && e.message) || e || 'unknown error') })

const str = (v) => (v === undefined || v === null ? null : String(v))

const isNum = (v) => typeof v === 'number' && isFinite(v) && v >= 0

// --- graph normalisation -----------------------------------------------------
//
// The client sends what a person typed, so every field is hostile until checked.
// This pass is the only place that decides what counts as a node or an edge;
// everything downstream may then trust `nodes` and `edges`.

function readPlan(args) {
  // `edges` that is not an array is deliberately normalised to [], not refused.
  // scripts/selftest.mjs records this as a settled design decision (search for
  // "one malformed input the host does NOT refuse") and spells out the
  // consequence honestly: the per-entry loop below never runs for a non-array,
  // so nothing lands in analysis.findings[code='malformed']. The "hostile until
  // checked" promise at the top of this function therefore holds for every entry
  // inside a well-formed array, and not for the array itself. That gap is
  // recorded rather than closed — changing it is a behaviour change, not a fix.
  // (No line numbers here on purpose: they drift, and a stale one reads as
  // authority it no longer has.)
  const rawNodes = Array.isArray(args && args.nodes) ? args.nodes : []
  const rawEdges = Array.isArray(args && args.edges) ? args.edges : []
  if (rawNodes.length === 0) return { ok: false, error: 'a plan needs at least one checkpoint' }
  if (rawNodes.length > MAX_NODES) {
    return { ok: false, error: 'too many checkpoints: ' + String(rawNodes.length) + ' > ' + String(MAX_NODES) }
  }
  if (rawEdges.length > MAX_EDGES) {
    return { ok: false, error: 'too many edges: ' + String(rawEdges.length) + ' > ' + String(MAX_EDGES) }
  }

  const nodes = []
  const seen = Object.create(null)
  const problems = []

  for (let i = 0; i < rawNodes.length; i++) {
    const r = rawNodes[i]
    const id = r && typeof r.id === 'string' ? r.id.trim() : ''
    if (id.length === 0) {
      problems.push({ kind: 'node', index: i, detail: 'checkpoint has no id' })
      continue
    }
    if (id.length > MAX_ID_CHARS) {
      problems.push({ kind: 'node', id: id.slice(0, 24), detail: 'id longer than ' + String(MAX_ID_CHARS) + ' chars' })
      continue
    }
    if (seen[id]) {
      problems.push({ kind: 'node', id: id, detail: 'duplicate checkpoint id' })
      continue
    }
    seen[id] = true
    const title = typeof r.title === 'string' ? r.title.slice(0, MAX_TEXT_CHARS) : ''
    const plan = typeof r.plan === 'string' ? r.plan.slice(0, MAX_TEXT_CHARS) : ''
    const materials = typeof r.materials === 'string' ? r.materials.slice(0, MAX_TEXT_CHARS) : ''
    const acceptance = typeof r.acceptance === 'string' ? r.acceptance.slice(0, MAX_TEXT_CHARS) : ''
    const estLo = isNum(r.estLo) ? r.estLo : null
    const estHi = isNum(r.estHi) ? r.estHi : null
    const external = r.external === true
    const node = {
      id: id,
      title: title,
      plan: plan,
      materials: materials,
      acceptance: acceptance,
      // An unestimated checkpoint stays null. The host will not invent hours:
      // a made-up estimate is worse than an admitted gap, because a human
      // reading a gap knows to fill it.
      estLo: estLo,
      estHi: estHi,
      external: external,
      risk: RISK_LEVELS.indexOf(r.risk) >= 0 ? r.risk : 'unknown',
      review: REVIEW_STATES.indexOf(r.review) >= 0 ? r.review : 'pending',
      reviewNote: typeof r.reviewNote === 'string' ? r.reviewNote.slice(0, MAX_TEXT_CHARS) : '',
      // Does this checkpoint need a person to sign off before it may run?
      gate: r.gate === true,
    }
    // Completeness is reported, never enforced. The whole point of the panel is
    // that the human sees which stages are underspecified.
    const missing = []
    if (title.length === 0) missing.push('title')
    if (plan.length === 0) missing.push('plan')
    if (estLo === null || estHi === null) missing.push('estimate')
    if (acceptance.length === 0) missing.push('acceptance')
    node.missing = missing
    nodes.push(node)
  }

  const edges = []
  for (let i = 0; i < rawEdges.length; i++) {
    const r = rawEdges[i]
    const from = r && typeof r.from === 'string' ? r.from.trim() : ''
    const to = r && typeof r.to === 'string' ? r.to.trim() : ''
    if (from.length === 0 || to.length === 0) {
      problems.push({ kind: 'edge', index: i, detail: 'edge endpoint missing' })
      continue
    }
    if (!seen[from] || !seen[to]) {
      problems.push({ kind: 'edge', from: from, to: to, detail: 'edge references an unknown checkpoint' })
      continue
    }
    if (from === to) {
      // A self-loop is the smallest possible cycle. Report it rather than
      // dropping it, because the human needs to see that they drew it.
      problems.push({ kind: 'edge', from: from, to: to, detail: 'self-loop' })
      edges.push({ from: from, to: to, kind: 'blocking', reason: '' })
      continue
    }
    const kind = r.kind === 'risk' ? 'risk' : 'blocking'
    const reason = typeof r.reason === 'string' ? r.reason.slice(0, MAX_TEXT_CHARS) : ''
    edges.push({ from: from, to: to, kind: kind, reason: reason })
  }

  const goal = args && typeof args.goal === 'string' ? args.goal.slice(0, MAX_GOAL_CHARS) : ''
  const purpose = args && typeof args.purpose === 'string' ? args.purpose.slice(0, MAX_GOAL_CHARS) : ''
  return { ok: true, nodes: nodes, edges: edges, problems: problems, goal: goal, purpose: purpose }
}

// --- graph algebra ------------------------------------------------------------

// Kahn's algorithm. `edges` is assumed to contain only blocking edges, so a
// node is emitted once every blocking predecessor has been. Emitting fewer
// nodes than were offered means the remainder is in or downstream of a cycle.
function topoLevels(nodeIds, edges) {
  const indeg = Object.create(null)
  const adj = Object.create(null)
  for (let i = 0; i < nodeIds.length; i++) {
    indeg[nodeIds[i]] = 0
    adj[nodeIds[i]] = []
  }
  for (let i = 0; i < edges.length; i++) {
    adj[edges[i].from].push(edges[i].to)
    indeg[edges[i].to] += 1
  }
  const ready = []
  for (let i = 0; i < nodeIds.length; i++) if (indeg[nodeIds[i]] === 0) ready.push(nodeIds[i])
  ready.sort()
  const order = []
  const level = Object.create(null)
  const preds = Object.create(null)
  for (let i = 0; i < nodeIds.length; i++) preds[nodeIds[i]] = []
  for (let i = 0; i < edges.length; i++) preds[edges[i].to].push(edges[i].from)

  while (ready.length > 0) {
    const n = ready.shift()
    order.push(n)
    // Level is decided from the emitted predecessors, so it never depends on
    // which of several ready nodes happened to sort first.
    let lv = 0
    for (let p = 0; p < preds[n].length; p++) {
      const from = preds[n][p]
      if (level[from] === undefined) continue
      if (level[from] + 1 > lv) lv = level[from] + 1
    }
    level[n] = lv
    const unlocked = []
    for (let k = 0; k < adj[n].length; k++) {
      indeg[adj[n][k]] -= 1
      if (indeg[adj[n][k]] === 0) unlocked.push(adj[n][k])
    }
    unlocked.sort()
    for (let k = 0; k < unlocked.length; k++) ready.push(unlocked[k])
    ready.sort()
  }
  return { order: order, level: level }
}

// Longest path weighted by the pessimistic estimate. `estHi` is used rather
// than a midpoint on purpose: a checkpoint whose upper bound is 3h cannot start
// later than 3h before its successor needs it. Reporting a single number built
// from midpoints is the false precision recorded in the experiment notes.
function criticalPath(nodeIds, edges, dur) {
  const res = topoLevels(nodeIds, edges)
  const order = res.order
  const finish = Object.create(null)
  const prev = Object.create(null)
  for (let i = 0; i < order.length; i++) {
    const n = order[i]
    const own = isNum(dur[n]) ? dur[n] : 0
    finish[n] = own
    prev[n] = null
    for (let p = 0; p < edges.length; p++) {
      const e = edges[p]
      if (e.to !== n) continue
      if (finish[e.from] === undefined) continue
      if (finish[e.from] + own > finish[n]) {
        finish[n] = finish[e.from] + own
        prev[n] = e.from
      }
    }
  }
  let end = null
  for (let i = 0; i < order.length; i++) {
    const n = order[i]
    if (end === null || finish[n] > finish[end]) end = n
  }
  const path = []
  let walk = end
  while (walk !== null && walk !== undefined && path.length <= nodeIds.length) {
    path.unshift(walk)
    walk = prev[walk]
  }
  return {
    order: order,
    level: res.level,
    path: path,
    total: end === null ? 0 : finish[end],
    end: end,
  }
}

function reachFrom(nodeIds, edges, start) {
  const adj = Object.create(null)
  for (let i = 0; i < nodeIds.length; i++) adj[nodeIds[i]] = []
  for (let i = 0; i < edges.length; i++) adj[edges[i].from].push(edges[i].to)
  const seenSet = Object.create(null)
  const stack = [start]
  seenSet[start] = true
  while (stack.length > 0) {
    const n = stack.pop()
    for (let i = 0; i < adj[n].length; i++) {
      const v = adj[n][i]
      if (seenSet[v]) continue
      seenSet[v] = true
      stack.push(v)
    }
  }
  return seenSet
}

// The single source of truth for "can this plan be drawn and scheduled".
// Everything the panel shows as a gate result comes from here.
function analyse(plan) {
  const nodes = plan.nodes
  const nodeIds = nodes.map((n) => n.id)
  const blocking = plan.edges.filter((e) => e.kind === 'blocking')
  const risk = plan.edges.filter((e) => e.kind === 'risk')

  const dur = Object.create(null)
  for (let i = 0; i < nodes.length; i++) {
    dur[nodes[i].id] = nodes[i].estHi === null ? null : nodes[i].estHi
  }

  const cp = criticalPath(nodeIds, blocking, dur)
  const cyclic = cp.order.length !== nodeIds.length
  const stuck = nodeIds.filter((id) => cp.level[id] === undefined)

  // Waves are derived, never supplied: a hand-drawn wave column drifts out of
  // sync with the edges, and the human then trusts the wrong number.
  const waves = []
  if (!cyclic) {
    const byLevel = Object.create(null)
    for (let i = 0; i < nodes.length; i++) {
      const lv = cp.level[nodes[i].id]
      if (!byLevel[lv]) byLevel[lv] = []
      byLevel[lv].push(nodes[i].id)
    }
    for (const key of Object.keys(byLevel)) waves.push({ wave: Number(key) + 1, nodes: byLevel[key].sort() })
    waves.sort((a, b) => a.wave - b.wave)
  }

  let totalHi = 0
  const unestimated = []
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].estHi === null) {
      unestimated.push(nodes[i].id)
      continue
    }
    totalHi += nodes[i].estHi
  }

  const criticalSet = Object.create(null)
  for (let i = 0; i < cp.path.length; i++) criticalSet[cp.path[i]] = true

  // Isolation is judged on blocking degree: a node joined only by risk edges is
  // schedulable now, which is a fact worth surfacing rather than an error.
  const degIn = Object.create(null)
  const degOut = Object.create(null)
  for (let i = 0; i < nodeIds.length; i++) {
    degIn[nodeIds[i]] = 0
    degOut[nodeIds[i]] = 0
  }
  for (let i = 0; i < blocking.length; i++) {
    degOut[blocking[i].from] += 1
    degIn[blocking[i].to] += 1
  }
  const isolated = nodeIds.filter((id) => degIn[id] === 0 && degOut[id] === 0)

  // A risk edge that carries no reason is decoration: the reader is told there
  // is a hazard but not what to do about it. This is the exact failure recorded
  // in the experiment notes, so it is reported by name.
  const bareRisk = risk.filter((e) => typeof e.reason !== 'string' || e.reason.trim().length === 0)
  // A risk edge that duplicates a blocking edge is mislabelled — the experiment
  // notes record a gate drawn as a risk edge causing the very failure it warned
  // about.
  const redundantRisk = risk.filter((e) => blocking.some((b) => b.from === e.from && b.to === e.to))

  const incomplete = nodes.filter((n) => n.missing.length > 0).map((n) => ({ id: n.id, missing: n.missing }))
  const blockedExternal = nodes.filter((n) => n.external).map((n) => n.id)
  const awaitingHuman = nodes.filter((n) => n.review === 'pending').map((n) => n.id)
  const gates = nodes.filter((n) => n.gate).map((n) => n.id)

  const findings = []
  if (cyclic) {
    findings.push({ level: 'error', code: 'cycle', detail: 'circular dependency: ' + (stuck.join(', ') || 'unknown') })
  }
  for (let i = 0; i < plan.problems.length; i++) {
    findings.push({ level: 'error', code: 'malformed', detail: plan.problems[i].detail })
  }
  if (unestimated.length > 0) {
    findings.push({ level: 'warn', code: 'unestimated', detail: 'no time estimate: ' + unestimated.join(', ') })
  }
  if (incomplete.length > 0) {
    findings.push({
      level: 'warn',
      code: 'incomplete',
      detail: incomplete.map((x) => x.id + '[' + x.missing.join('+') + ']').join(' '),
    })
  }
  if (bareRisk.length > 0) {
    findings.push({
      level: 'warn',
      code: 'bare-risk-edge',
      detail: 'risk edge without a reason: ' + bareRisk.map((e) => e.from + '->' + e.to).join(' '),
    })
  }
  for (let i = 0; i < redundantRisk.length; i++) {
    findings.push({
      level: 'warn',
      code: 'redundant-risk-edge',
      detail: 'risk edge is also blocking: ' + redundantRisk[i].from + '->' + redundantRisk[i].to,
    })
  }
  if (isolated.length > 0) {
    findings.push({ level: 'warn', code: 'isolated', detail: 'no blocking edge either way: ' + isolated.join(', ') })
  }
  if (awaitingHuman.length > 0) {
    findings.push({ level: 'info', code: 'awaiting-human', detail: 'not yet reviewed: ' + awaitingHuman.join(', ') })
  }
  if (blockedExternal.length > 0) {
    findings.push({
      level: 'warn',
      code: 'blocked-external',
      detail: 'depends on something outside this plan: ' + blockedExternal.join(', '),
    })
  }

  return {
    ok: !cyclic && plan.problems.length === 0,
    acyclic: !cyclic,
    blocked: stuck,
    waves: waves,
    criticalPath: cp.path,
    criticalTotalHi: cp.total,
    sequentialTotalHi: totalHi,
    parallelSavingHi: totalHi - cp.total,
    unestimated: unestimated,
    incomplete: incomplete,
    isolated: isolated,
    blockedExternal: blockedExternal,
    awaitingHuman: awaitingHuman,
    gates: gates,
    bareRiskEdges: bareRisk.map((e) => e.from + '->' + e.to),
    redundantRiskEdges: redundantRisk.map((e) => e.from + '->' + e.to),
    onCriticalPath: criticalSet,
    findings: findings,
  }
}

// --- scaffold -----------------------------------------------------------------
//
// pd-outline returns nodes and edges, never a finished plan. The stages are the
// generic shape the methodology found necessary, expressed as something a person
// edits down to the actual task: establish the ground, split it, build each
// piece, verify. Nothing here is claimed to be the right decomposition of the
// user's task — that is the human's to make, which is why the first two stages
// are gates.

const OUTLINE_STAGES = [
  { id: 'C1', title: '确立出发点与目的', plan: '写清现在的真实状态、要达成什么、成功的判据是什么', gate: true, risk: 'low' },
  { id: 'C2', title: '倒推所需阶段', plan: '从目的反推必须完成哪些事，以及它们的先后', gate: true, risk: 'medium' },
  { id: 'C3', title: '逐项落实', plan: '每个阶段写清：做什么、用什么、产出是什么', gate: false, risk: 'medium' },
  { id: 'C4', title: '验证与修正', plan: '用什么检查证明真的做完了，不通过怎么回退', gate: true, risk: 'medium' },
]

return {
  apply(ctx) {
    // This plugin stores nothing durable and asks no service for data; it only
    // reads what the human typed. ctx.get is still probed so a later half can
    // be added without changing this one.
    const slots = ctx.get('slots')
    let reviews = []

    console.log('[plan-decomposition] host apply ' + BUILD, {
      slots: slots !== undefined,
    })

    harness.handle('pd-info', async () => ({
      ok: true,
      build: BUILD,
      limits: {
        nodes: MAX_NODES,
        edges: MAX_EDGES,
        idChars: MAX_ID_CHARS,
        textChars: MAX_TEXT_CHARS,
        goalChars: MAX_GOAL_CHARS,
        history: MAX_HISTORY,
      },
      reviewStates: REVIEW_STATES,
      riskLevels: RISK_LEVELS,
    }))

    // The gate. A human deciding whether to trust a plan reads this and nothing
    // else, so it answers in one object: is it drawable, is it schedulable, what
    // is missing, what is waiting on a person.
    harness.handle('pd-verify', async (args) => {
      try {
        const plan = readPlan(args)
        if (plan.ok !== true) return { ok: false, error: plan.error }
        const analysis = analyse(plan)
        return {
          ok: true,
          goal: plan.goal,
          purpose: plan.purpose,
          nodeCount: plan.nodes.length,
          edgeCount: plan.edges.length,
          blockingEdges: blockingCount(plan.edges),
          riskEdges: plan.edges.length - blockingCount(plan.edges),
          nodes: plan.nodes,
          edges: plan.edges,
          analysis: analysis,
        }
      } catch (e) {
        return fail(e)
      }
    })

    harness.handle('pd-outline', async (args) => {
      const goal = args && typeof args.goal === 'string' ? args.goal.slice(0, MAX_GOAL_CHARS) : ''
      try {
        const nodes = OUTLINE_STAGES.map((s) => ({
          id: s.id,
          title: s.title,
          plan: s.plan,
          materials: '',
          acceptance: '',
          estLo: null,
          estHi: null,
          external: false,
          risk: s.risk,
          review: 'pending',
          reviewNote: '',
          gate: s.gate,
          missing: [],
        }))
        const edges = []
        for (let i = 1; i < nodes.length; i++) {
          edges.push({
            from: nodes[i - 1].id,
            to: nodes[i].id,
            kind: 'blocking',
            reason: '前一个阶段的产出是后一个的输入',
          })
        }
        return { ok: true, goal: goal, purpose: '', nodes: nodes, edges: edges }
      } catch (e) {
        return fail(e)
      }
    })

    // A human decision is the one thing this plugin cannot derive, so it is
    // recorded rather than computed. The log is bounded and returned newest
    // first so the panel can show what changed since the plan was drawn.
    harness.handle('pd-review', async (args) => {
      if (!args || typeof args.id !== 'string' || args.id.trim().length === 0) {
        return { ok: false, error: 'id required' }
      }
      const state = REVIEW_STATES.indexOf(args.state) >= 0 ? args.state : null
      if (state === null) return { ok: false, error: 'state must be one of ' + REVIEW_STATES.join(', ') }
      try {
        const entry = {
          id: args.id.trim().slice(0, MAX_ID_CHARS),
          state: state,
          note: typeof args.note === 'string' ? args.note.slice(0, MAX_TEXT_CHARS) : '',
          at: Date.now(),
        }
        reviews.unshift(entry)
        if (reviews.length > MAX_HISTORY) reviews.length = MAX_HISTORY
        return { ok: true, entry: entry, history: reviews }
      } catch (e) {
        return fail(e)
      }
    })

    // Reload. The panel is registered at page load, and a client half only
    // loads then, so whatever the human was looking at has to be recoverable.
    harness.handle('pd-plan', async () => {
      try {
        return { ok: true, history: reviews }
      } catch (e) {
        return fail(e)
      }
    })
  },
}

function blockingCount(edges) {
  let n = 0
  for (let i = 0; i < edges.length; i++) if (edges[i].kind === 'blocking') n += 1
  return n
}