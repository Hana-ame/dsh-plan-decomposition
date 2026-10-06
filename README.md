# dsh-plan-decomposition

A **dynamic Cordis plugin** for the DeepSeek Harness Web GUI. It gives a person a
panel for supervising a large task that an LLM has broken into stages: the plan
is drawn as a dependency graph, every checkpoint carries an explicit
accept/reject state, and nothing advances without a human saying so.

The point is not the graph. The point is that **the graph cannot be green on its
own** — an unestimated checkpoint is reported as unestimated, never defaulted, so
the panel always shows what a human still owes a decision.

---

## Layout

```
src/host.js          code.host   — graph algebra, validation, review log
src/client.js        code.client — the panel (React, drawn by the DSH shell)
scripts/check.mjs      pre-flight gate: hygiene + RPC surface agreement
scripts/selftest.mjs   behavioural test: what the handlers actually compute
scripts/client-test.mjs behavioural test, client half: renders the panel against a
                       stub ctx and asserts the element tree; also feeds packPlan
                       output into the real host readPlan. No DSH process involved.
scripts/install.mjs    emits the cordis_define payload; writes nothing
```

`src/host.js` and `src/client.js` are **plain JavaScript function bodies**. They
are not modules: no `import`, no `require`, no `export`, no TypeScript type
syntax, no JSX. The Cordis evaluator injects `React`, `styles`, `host`,
`harness` and `console` as function parameters, and both halves must carry the
same build stamp (`pd-1`) so the client can prove the two halves running in a
process belong to the same iteration.

## RPC surface

All methods are prefixed `pd-` to avoid colliding with any other dynamic
package in the same process.

| method | purpose |
|---|---|
| `pd-info` | build id, limits, review-state and risk vocabularies |
| `pd-verify` | the gate: acyclicity, topological levels, critical path, waves, orphans |
| `pd-outline` | a scaffold decomposition of a free-form goal, as editable nodes |
| `pd-review` | record a human's decision about one checkpoint |
| `pd-plan` | replay the review log, for reloading the panel |

## What the host half does not do

- **It does not schedule by defaulting.** A node with no `estHi` is reported as
  unestimated; the critical path is not computed from an invented zero.
- **It does not approve anything.** `REVIEW_STATES` starts at `pending`, and only
  `pd-review` moves it.
- **It does not touch the filesystem.** It stores nothing durable.
- **It does not require a Service.** `ctx.get` is probed but never required, so a
  partial runtime still yields a partial panel.

## Gates

```sh
npm test                # check:client + check:host + check + selftest + client-test
npm run check           # hygiene + RPC agreement
npm run selftest        # behavioural (host half)
npm run check:clienttest # behavioural (client half, no DSH needed)
npm run install         # print the install prompt (writes nothing)
npm run emit            # JSON payload
```

`npm test` covers everything CI runs, plus two parse-only checks CI skips
(`check:client` / `check:host` are subsumed by `check.mjs`, which parses both
halves as function bodies anyway). The one thing `npm test` does **not** do is
the last CI step, `install.mjs --json`; run `npm run emit` for that. So:

| | check | selftest | client-test | emit |
|---|---|---|---|---|
| CI (`cordis-preflight`) | ✅ | ✅ | ✅ | ✅ |
| `npm test` / `npm run gate` | ✅ | ✅ | ✅ | ❌ use `npm run emit` |

There are three behavioural suites, not one: `selftest.mjs` covers the host
handlers against fixtures, and `client-test.mjs` covers the client half — which
is the half a person actually looks at, and which no suite covered before it
existed. The `packPlan` → `readPlan` seam between the two halves is checked by
neither suite alone; only `client-test.mjs` feeds one into the other.

`check.mjs` fails on banned constructs, on a half that does not parse as a
function body, on a client RPC with no host handler, and on a build stamp that
does not match `EXPECTED_BUILD`. It warns, without failing, on unguarded
platform access and on host handlers the client never calls.

`install.mjs` **cannot install anything.** A dynamic Cordis package only comes
alive inside a running DSH process; the script's whole job is to gate, then
print the exact `cordis_define` argument together with a sha256 fingerprint of
each half so a definition made in the process can be matched against these
files afterwards.

## CI

`.github/workflows/check.yml` (`cordis-preflight`) runs on pushes to **both**
`main` and `master`, on every pull request, and on `workflow_dispatch`. It is
the only thing that runs these suites outside this machine, so it is also the
only thing that can catch a runtime difference — `client-test.mjs` in particular
has no other path onto Node 18.

- matrix `node: [18, 20, 22]`, `fail-fast: false` — one runtime failing is
  visible on its own row instead of hiding behind a cancelled sibling
- `timeout-minutes: 5` — the suites are zero-dependency and finish in seconds;
  a job still running after five minutes is hung, not slow
- `permissions: contents: read` — nothing here writes to the repository
- steps, in order: `check` → `selftest` → `client-test` → `install.mjs --json`

One known, non-blocking annotation, recorded here because it is otherwise
visible only in a CI log: `checkout@v4` and `setup-node@v4` — the only two
actions this workflow uses — target Node 20, and GitHub reported forcing them
onto Node 24. It affects no step's conclusion. The obvious fix is the `v5`
actions, which is deliberately **not** in this commit: whether `v5` actually
drops the runtime, and what else changes with it (notably setup-node's cache
key), has not been verified here. Check the changelogs before bumping.

That last step prints the payload and a fingerprint of each half. It writes
nothing, and it is there so the CI log itself carries the shas a definition
made inside a running DSH can be checked against.

## Installing

```sh
node scripts/install.mjs          # short prompt, agent reads ./src
node scripts/install.mjs --prompt # self-contained, both halves inline
```

Hand the prompt to a DSH agent, then `cordis_define`, then `cordis_run`. A client
half returns **awaiting-approval** and needs your approval plus a browser page
refresh — it only loads at page load. The panel appears as **计划拆解** in the
left sidebar.

## Limits

- The critical path is derived from the estimate range the human supplied. It is
  not a measurement and does not know how long the work really takes.
- `pd-review` history is in-memory only, capped at 200 entries, newest first. It
  does not survive a host restart.
- `pd-outline` truncates an over-long goal at 2000 characters rather than
  rejecting it; a clipped scaffold is more useful than no panel.

## License

MIT.