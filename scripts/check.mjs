#!/usr/bin/env node
// ============================================================================
// Pre-flight gate for the Plan Decomposition dynamic Cordis package.
//
// It answers one question: "would cordis_define accept this, and do the two
// halves agree on their RPC surface?" It does NOT prove behaviour — that is
// scripts/selftest.mjs.
//
// Checks, per half:
//   1. parse      — the file must evaluate as a function body (`new Function`),
//                   which is exactly what the Cordis evaluator does.
//   2. load       — calling it with stub globals must return an object with an
//                   `apply` function (a Cordis Plugin).
//   3. banned     — no import / require / export / TS type syntax / JSX, the
//                   constructs the dynamic evaluator forbids.
//   4. warnings   — off-guidance globals (unguarded platform access, native
//                   timers, innerHTML) reported without failing.
//   5. RPC match  — every client `hostCall('pd-…')` has a host `harness.handle`,
//                   and every handler is called by the client.
//   6. behaviour  — the slot registrations are asserted from what the stub
//                   `slots.register` actually received while the half ran, not
//                   from the source text. See the note above the registration
//                   invariants: a grep of the source goes false-red on any
//                   refactor of the client and false-green on a wrong slot.
//
// Exit 0 = no errors. Warnings never fail the run.
// Usage: node scripts/check.mjs [--json]
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const AS_JSON = process.argv.includes('--json')

// The build stamp both halves must carry, byte for byte. It lives here rather
// than being read out of the sources so that changing one half alone fails.
const EXPECTED_BUILD = 'pd-1'

const results = []
function record(half, name, pass, detail) {
  results.push({ half, name, pass, detail: detail === undefined ? null : String(detail) })
  return pass
}

// ---------------------------------------------------------------------------
// Source blanking: replace comments, string literals, template literals and
// regex literals with spaces while preserving newlines, so a rule can never
// trip on prose inside a string. Offsets stay aligned for diagnostics.
// ---------------------------------------------------------------------------
function blankSource(src) {
  let out = ''
  let i = 0
  const n = src.length
  let prev = ''
  const regexAllowed = (p) => p === '' || '(,=:[!&|?{};+-*%~^<>'.indexOf(p) >= 0
  while (i < n) {
    const c = src[i]
    const c2 = i + 1 < n ? src[i + 1] : ''
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i += 1 }
      continue
    }
    if (c === '/' && c2 === '*') {
      out += '  '
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i += 1 }
      if (i < n) { out += '  '; i += 2 }
      continue
    }
    if (c === "'" || c === '"') {
      const q = c
      out += ' '
      i += 1
      while (i < n) {
        const d = src[i]
        if (d === '\\') { out += '  '; i += 2; continue }
        if (d === q) { out += ' '; i += 1; break }
        out += d === '\n' ? '\n' : ' '
        i += 1
      }
      prev = q
      continue
    }
    if (c === '`') {
      out += ' '
      i += 1
      while (i < n) {
        const d = src[i]
        if (d === '\\') { out += '  '; i += 2; continue }
        if (d === '`') { out += ' '; i += 1; break }
        out += d === '\n' ? '\n' : ' '
        i += 1
      }
      prev = '`'
      continue
    }
    if (c === '/' && regexAllowed(prev)) {
      out += ' '
      i += 1
      let inClass = false
      let closed = false
      while (i < n) {
        const d = src[i]
        if (d === '\\') { out += '  '; i += 2; continue }
        if (d === '\n') break
        if (d === '[') inClass = true
        else if (d === ']') inClass = false
        else if (d === '/' && !inClass) { out += ' '; i += 1; closed = true; break }
        out += ' '
        i += 1
      }
      if (closed) {
        while (i < n && /[a-z]/.test(src[i])) { out += ' '; i += 1 }
      }
      prev = '/'
      continue
    }
    out += c
    if (!/\s/.test(c)) prev = c
    i += 1
  }
  return out
}

function lineOf(src, index) {
  let line = 1
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === '\n') line += 1
  return line
}

const BANNED = [
  { name: 'import statement', re: /(^|[^.\w$])import\s*[({'"`]/m },
  { name: 'dynamic import()', re: /(^|[^.\w$])import\s*\(/m },
  { name: 'require()', re: /(^|[^.\w$])require\s*\(/m },
  { name: 'export statement', re: /(^|[^.\w$])export\s+(default|const|let|var|function|class|\{)/m },
  { name: 'TypeScript interface/enum', re: /(^|[^.\w$])(interface|enum)\s+[A-Za-z_$]/m },
  { name: 'TypeScript as-cast', re: /\bas\s+[A-Za-z_$][\w$.<>[\]]*/m },
  { name: 'JSX element', re: /<\/?(div|span|button|input|textarea|select|option|svg|path|circle|b|i|p|a|h1|h2|ul|li|table|tr|td)\b[\s/>]/m },
]

const WARN = [
  { name: 'window access', re: /(^|[^.\w$])window\s*[.[]/m },
  { name: 'document access', re: /(^|[^.\w$])document\s*[.[]/m },
  { name: 'localStorage access', re: /(^|[^.\w$])localStorage\s*[.[]/m },
  { name: 'native timer', re: /(^|[^.\w$])(setTimeout|setInterval)\s*\(/m },
  { name: 'fetch()', re: /(^|[^.\w$])fetch\s*\(/m },
  { name: 'innerHTML', re: /\.innerHTML\s*=/m },
  { name: 'eval()', re: /(^|[^.\w$])eval\s*\(/m },
]

function firstMatch(blanked, re) {
  const m = re.exec(blanked)
  if (!m) return null
  const idx = m.index + (m[1] ? m[1].length : 0)
  return { line: lineOf(blanked, idx), text: m[0].trim() }
}

// ---------------------------------------------------------------------------
// Stub globals so each half can actually be loaded, like the evaluator does.
// ---------------------------------------------------------------------------
function makeHostEnv() {
  const handlers = {}
  const harness = { handle: (name, fn) => { handlers[name] = fn } }
  const ctx = { get: () => undefined }
  return { globals: { harness, console: { log() {}, error() {} } }, ctx, handlers }
}

function makeClientEnv() {
  const registrations = []
  // `registered` records every spec the half hands to `slots.register`, so the
  // registration invariants below can assert on what the client *did* rather
  // than on how it happens to spell it in source. `inject` still fires its
  // callback, because a real slot host would; these specs are therefore the
  // ones a real DSH would have received.
  const registered = []
  // spec -> component, kept alongside so a registration can be checked for a
  // render function as well as a slot name.
  const registeredComponents = new Map()
  const slots = {
    inject: (name, fn) => { registrations.push(name); fn() },
    register: (spec, component) => {
      registered.push(spec)
      registeredComponents.set(spec, component)
      return { spec, component }
    },
  }
  const ctx = {
    get: (name) => (name === 'slots' ? slots : undefined),
    effect: (fn) => { fn() },
  }
  const React = {
    createElement: () => null,
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (v) => ({ current: v === undefined ? null : v }),
  }
  const styles = { insert: () => {} }
  const host = { call: async () => ({ ok: true }) }
  return { globals: { React, styles, host, console: { log() {}, error() {} } }, ctx, registrations, registered, registeredComponents }
}

// The dynamic evaluator hands each half a fixed set of names as function
// parameters (host: `harness`, `console`; client: `React`, `styles`, `host`,
// `console`). Injecting them the same way is what makes this load check stand
// in for the real evaluator instead of merely parsing the file.
const GLOBAL_NAMES = ['React', 'styles', 'host', 'harness', 'console']

function loadHalf(kind, src) {
  let fn
  try {
    fn = new Function(...GLOBAL_NAMES, src)
  } catch (e) {
    return { ok: false, error: 'parse: ' + String((e && e.message) || e) }
  }
  const env = kind === 'host' ? makeHostEnv() : makeClientEnv()
  const args = GLOBAL_NAMES.map((name) => env.globals[name])
  let plugin
  try {
    plugin = fn(...args)
  } catch (e) {
    return { ok: false, error: 'load: ' + String((e && e.message) || e) }
  }
  if (!plugin || typeof plugin.apply !== 'function') {
    return { ok: false, error: 'load: did not return a Cordis Plugin (missing apply)' }
  }
  try {
    plugin.apply(env.ctx)
  } catch (e) {
    return { ok: false, error: 'apply: ' + String((e && e.message) || e) }
  }
  return { ok: true, env }
}

// ---------------------------------------------------------------------------
// Service-tolerance analysis (host half).
//
// WHY THIS IS GENERALISED — do not "fix" it back.
//
// An earlier revision of this file asserted the exact rule
//
//     ctx.get('sessionQuery') exists  AND  'sessionQuery === undefined' appears
//
// That hardcoded one service name copied from the host it was written against.
// It was wrong twice over: it would fail a host that legitimately needs no
// `sessionQuery` service, and it would happily pass a host that calls
// `ctx.get('timer')` and dereferences the result without ever checking it —
// because the name it inspected was not the name the host actually asked for.
//
// The service name is an implementation detail. Fault tolerance is the intent,
// and the intent is what a gate should encode. So this version derives the
// names from the host's own source and demands a guard on *every* service the
// host binds, whatever it happens to be called:
//
//   * a host that never calls `ctx.get` at all is a hard failure — otherwise
//     "no services" would trivially satisfy "no unguarded service";
//   * each `const|let NAME = ctx.get(...)` binding must be compared against
//     `undefined`/`null` (or `typeof`-tested) somewhere in the half;
//   * an inline `ctx.get(...) === undefined` with no binding name must be
//     guarded at the call site itself.
//
// Strength is a superset of the old rule's: the old rule checked one hardcoded
// binding, this checks all of them.
// ---------------------------------------------------------------------------

// `const slots = ctx.get('slots')` — also matches `let x`, `var x`, and the
// trailing-comma / paren variants. The service name inside the quotes is not
// captured: it is irrelevant to the guard requirement.
const SERVICE_BINDING_RE = /(^|[^.\w$])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*ctx\.get\s*\(/g
const CTX_GET_RE = /(^|[^.\w$])ctx\.get\s*\(/g

// A binding is considered guarded when its name is compared against a value it
// might legitimately lack. `typeof x === 'undefined'` is accepted too, since it
// also reads correctly for a service that is present but empty.
const guardFor = (name) => [
  new RegExp('(^|[^.\\w$])' + name + '\\s*(===|!==)\\s*(undefined|null)\\b'),
  new RegExp('(^|[^.\\w$])(undefined|null)\\s*(===|!==)\\s*' + name + '\\b'),
  new RegExp('(^|[^.\\w$])typeof\\s+' + name + '\\s*(===|!==)'),
  new RegExp('(^|[^.\\w$])typeof\\s*\\(\\s*' + name + '\\s*\\)'),
]

function analyseServiceTolerance(raw, blanked) {
  // Rule 1: the host must reach for services at all. Without this, a host that
  // simply never calls ctx.get would satisfy every per-binding rule vacuously.
  const getCount = (CTX_GET_RE.exec(blanked), (blanked.match(new RegExp(CTX_GET_RE.source, 'g')) || []).length)
  CTX_GET_RE.lastIndex = 0
  if (getCount === 0) {
    return {
      ok: false,
      detail: 'host never calls ctx.get: the "tolerate an absent Service" rule would pass vacuously, so this is treated as a bypass, not as compliance',
    }
  }

  // Rule 2: every bound service must be null-checked.
  const bindings = []
  let m
  SERVICE_BINDING_RE.lastIndex = 0
  while ((m = SERVICE_BINDING_RE.exec(raw)) !== null) bindings.push({ name: m[2], at: m.index })
  SERVICE_BINDING_RE.lastIndex = 0

  const unguarded = []
  for (const b of bindings) {
    let guarded = false
    for (const re of guardFor(b.name)) {
      re.lastIndex = 0
      if (re.test(blanked)) { guarded = true; break }
    }
    if (!guarded) unguarded.push(b.name + ' (line ' + String(lineOf(raw, b.at)) + ')')
  }

  // Rule 3: bindings we could not name (inline `ctx.get(x) === undefined`) must
  // still be guarded where they are used.
  if (bindings.length === 0) {
    const inline = /(?:===|!==)\s*(?:undefined|null)|typeof\s*\([^)]*ctx\.get/.test(blanked)
    if (!inline) {
      return {
        ok: false,
        detail: getCount + ' ctx.get call(s) but no null/undefined guard anywhere in the host half',
      }
    }
  }

  if (unguarded.length > 0) {
    return {
      ok: false,
      detail: 'ctx.get result used without a null check: ' + unguarded.join(', ') +
        ' (a Service may legitimately be absent; compare it against undefined/null before use)',
    }
  }
  return {
    ok: true,
    detail: bindings.length === 0
      ? getCount + ' ctx.get call(s), guarded inline'
      : getCount + ' ctx.get call(s); guarded: ' + bindings.map((b) => b.name).join(', '),
  }
}

// ---------------------------------------------------------------------------
function run() {
  const files = { host: path.join(ROOT, 'src', 'host.js'), client: path.join(ROOT, 'src', 'client.js') }
  const sources = {}
  const blanked = {}
  const envs = {}

  for (const half of ['host', 'client']) {
    const file = files[half]
    if (!fs.existsSync(file)) {
      record(half, 'file exists', false, file)
      continue
    }
    const src = fs.readFileSync(file, 'utf8')
    sources[half] = src
    blanked[half] = blankSource(src)
    record(half, 'file exists', true, file)
    // Size is displayed, never asserted — no byte count is hardcoded, so an
    // edit to either half moves this number without failing anything. Read it
    // as UTF-8 BYTES rather than JavaScript string length, which counts UTF-16
    // code units and under-reports any file containing non-ASCII (both halves
    // carry Chinese UI strings): "68086 bytes" was really 69994 bytes.
    const srcBytes = Buffer.byteLength(src, 'utf8')
    record(half, 'has content', src.trim().length > 0, srcBytes + ' bytes')

    const loaded = loadHalf(half, src)
    record(half, 'evaluates and loads', loaded.ok, loaded.ok ? 'returns a Cordis Plugin with apply()' : loaded.error)
    if (loaded.ok) envs[half] = loaded.env

    let banned = 0
    for (const rule of BANNED) {
      const hit = firstMatch(blanked[half], rule.re)
      if (hit !== null) {
        banned += 1
        record(half, 'bans ' + rule.name, false, 'line ' + String(hit.line) + ': ' + hit.text)
      }
    }
    if (banned === 0) record(half, 'bans forbidden constructs', true, 'import/require/export/TS/JSX absent')

    const warned = []
    for (const rule of WARN) {
      const hit = firstMatch(blanked[half], rule.re)
      if (hit !== null) warned.push(rule.name + ' @' + String(hit.line))
    }
    record(half, 'platform access warnings', warned.length === 0, warned.length === 0 ? 'none' : warned.join(', '))
  }

  // -- RPC reconciliation ---------------------------------------------------
  const hostHandlers = new Set()
  const clientCalls = new Set()
  if (sources.host) {
    const re = /harness\.handle\(\s*'([^']+)'/g
    let m
    while ((m = re.exec(sources.host)) !== null) hostHandlers.add(m[1])
  }
  if (sources.client) {
    const re = /(?:hostCall|host\.call)\(\s*'([^']+)'/g
    let m
    while ((m = re.exec(sources.client)) !== null) clientCalls.add(m[1])
  }
  record('cross', 'host registers RPC handlers', hostHandlers.size > 0, Array.from(hostHandlers).sort().join(', '))
  record('cross', 'client calls RPC handlers', clientCalls.size > 0, Array.from(clientCalls).sort().join(', '))
  const missing = Array.from(clientCalls).filter((name) => !hostHandlers.has(name))
  record('cross', 'every client call has a host handler', missing.length === 0, missing.length === 0 ? 'all matched' : 'missing: ' + missing.join(', '))
  const unused = Array.from(hostHandlers).filter((name) => !clientCalls.has(name))
  record('cross', 'every host handler is called by the client', unused.length === 0, unused.length === 0 ? 'all used' : 'unused (warning only): ' + unused.join(', '))

  // -- build stamp agreement -------------------------------------------------
  if (sources.host && sources.client) {
    const hostBuild = /const BUILD = '([^']+)'/.exec(sources.host)
    const clientBuild = /const STAMP = '([^']+)'/.exec(sources.client)
    const same = hostBuild !== null && clientBuild !== null && hostBuild[1] === clientBuild[1]
    record('cross', 'both halves carry the same build stamp', same,
      same ? hostBuild[1] : 'host=' + (hostBuild ? hostBuild[1] : '?') + ' client=' + (clientBuild ? clientBuild[1] : '?'))
    // The stamp must also be the stamp this gate expects: agreeing on a wrong
    // value would mean a half was edited without the gate noticing.
    const both = hostBuild !== null && clientBuild !== null
    const expected = both && hostBuild[1] === EXPECTED_BUILD && clientBuild[1] === EXPECTED_BUILD
    record('cross', 'build stamp matches the published one', expected,
      expected ? EXPECTED_BUILD : 'expected ' + EXPECTED_BUILD + ', host=' + (hostBuild ? hostBuild[1] : '?') + ' client=' + (clientBuild ? clientBuild[1] : '?'))
  }

  // -- registration invariants ---------------------------------------------
  if (sources.client) {
    // WHY THIS ASKS THE CLIENT, NOT THE SOURCE — do not "fix" it back to grep.
    //
    // These two rules used to be
    //
    //     /slots\.register\(\s*\{\s*name:\s*'main'/.test(sources.client)
    //     /slots\.register\(\s*\{\s*name:\s*'sidebar\.panellist'/.test(sources.client)
    //
    // They asserted a fact about the *source text*: that the string literal
    // 'main' appears immediately after `name:`. That is not the fact anyone
    // cares about. The fact is "the panel registers itself on the main slot" —
    // and the source cannot answer that, because the client hoisted the names
    // into constants (`const SLOT_MAIN = 'main'`) to stop the registration block
    // and the status log from drifting apart.
    //
    // So the refactor broke the grep and the gate went red, while the runtime
    // behaviour never changed. That is the worst possible failure mode for a
    // gate: a false failure whose fix — loosening the regex until it matches the
    // new spelling — would equally happily pass a client that registers on the
    // wrong slot. Every re-spelling of the source is a new chance to be wrong.
    //
    // The environment above already evaluates the half the way the Cordis
    // evaluator does, and `slots.register` already receives the real spec
    // objects. So assert on the captured specs: the value that arrives is the
    // value the runtime sees, regardless of whether it was written inline or as
    // a constant, a template, or a concatenation. Renaming SLOT_MAIN is now a
    // no-op for this gate; changing the slot it registers on is still a failure.
    const registered = (envs.client && envs.client.registered) || []
    const registeredComponents = (envs.client && envs.client.registeredComponents) || new Map()
    const specFor = (slotName) => registered.find((spec) => spec && spec.name === slotName) || null
    const shape = (spec) => {
      const key = spec && (spec.key !== undefined ? spec.key : spec.id)
      const slotName = spec && spec.name
      return 'slots.register({ name: ' + JSON.stringify(slotName) +
        ', key/id: ' + JSON.stringify(key === undefined ? null : key) + ' })'
    }

    // A registration is only proof if the half could produce one. Without this
    // guard a client that registers nothing at all would satisfy the two slot
    // rules vacuously, so the count is checked first.
    record('client', 'registers through slots.register', registered.length > 0,
      registered.length + ' registration(s): ' +
      (registered.length === 0 ? 'none' : registered.map((s) => String(s && s.name)).join(', ')))

    const main = specFor('main')
    record('client', 'registers a main panel', main !== null, main !== null ? shape(main) : 'no slots.register({ name: "main" })')

    const sidebar = specFor('sidebar.panellist')
    record('client', 'registers a sidebar entry', sidebar !== null, sidebar !== null ? shape(sidebar) : 'no slots.register({ name: "sidebar.panellist" })')

    // The third registration. `client.js` registers a tool card on
    // 'tool.view.cordis' as well as the panel and the sidebar entry, and the
    // panel closes — this card is what survives, showing how much of the plan
    // is waiting on a human. It was registered all along and no rule covered
    // it, so a client could have dropped it and the gate would still have been
    // green. Now the gate fails if it disappears.
    const tool = specFor('tool.view.cordis')
    record('client', 'registers a tool-view card', tool !== null, tool !== null ? shape(tool) : 'no slots.register({ name: "tool.view.cordis" })')

    // Every registration must carry a component function, or the slot renders
    // nothing while still counting as registered.
    const componentless = registered.filter((s) => typeof registeredComponents.get(s) !== 'function')
    record('client', 'every registration carries a component', componentless.length === 0,
      componentless.length === 0
        ? registered.length + '/' + String(registered.length) + ' with a component function'
        : 'no component function for: ' + componentless.map((s) => String(s && s.name)).join(', '))

    const samePanel = /const PANEL_ID = '([^']+)'/.exec(sources.client)
    record('client', 'panel id is a single constant', samePanel !== null, samePanel ? samePanel[1] : 'PANEL_ID not found')
    record('client', 'inserts its stylesheet via ctx.effect', /ctx\.effect\(/.test(sources.client), 'ctx.effect(...)')
    const timerOnly = !/(^|[^.\w$])(setTimeout|setInterval)\s*\(/.test(blanked.client)
    record('client', 'uses the Cordis timer service', /ctx\.get\(\s*'timer'\s*\)/.test(sources.client) && timerOnly, "ctx.get('timer')")
  }
  if (sources.host) {
    const tol = analyseServiceTolerance(sources.host, blanked.host)
    record('host', 'tolerates absent services', tol.ok, tol.detail)
    record('host', 'no filesystem access', !/ctx\.get\(\s*'fs'\s*\)/.test(sources.host), 'the plan algebra needs no fs service')
  }

  const errors = results.filter((r) => !r.pass && !r.name.startsWith('every host handler') && !r.name.startsWith('platform access'))
  const warnings = results.filter((r) => !r.pass && (r.name.startsWith('every host handler') || r.name.startsWith('platform access')))
  return { errors, warnings, all: results }
}

const report = run()

if (AS_JSON) {
  console.log(JSON.stringify({
    ok: report.errors.length === 0,
    errors: report.errors.length,
    warnings: report.warnings.length,
    checks: report.all,
  }, null, 2))
} else {
  let lastHalf = null
  for (const r of report.all) {
    if (r.half !== lastHalf) {
      console.log('\n[' + r.half + ']')
      lastHalf = r.half
    }
    const mark = r.pass ? 'PASS' : (r.name.startsWith('every host handler') || r.name.startsWith('platform access') ? 'WARN' : 'FAIL')
    console.log('  ' + mark + '  ' + r.name + (r.detail ? '  — ' + r.detail : ''))
  }
  console.log('\n' + (report.errors.length === 0
    ? 'ALL PASS (' + String(report.all.length - report.warnings.length) + ' checks, ' + String(report.warnings.length) + ' warnings)'
    : 'FAILURES ' + String(report.errors.length)))
}

process.exit(report.errors.length === 0 ? 0 : 1)
