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
scripts/check.mjs    pre-flight gate: hygiene + RPC surface agreement
scripts/selftest.mjs behavioural test: what the handlers actually compute
scripts/install.mjs  emits the cordis_define payload; writes nothing
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
npm test          # check:client + check:host + check + selftest
npm run check     # hygiene + RPC agreement
npm run selftest  # behavioural
npm run install   # print the install prompt (writes nothing)
npm run emit      # JSON payload
```

`check.mjs` fails on banned constructs, on a half that does not parse as a
function body, on a client RPC with no host handler, and on a build stamp that
does not match `EXPECTED_BUILD`. It warns, without failing, on unguarded
platform access and on host handlers the client never calls.

`install.mjs` **cannot install anything.** A dynamic Cordis package only comes
alive inside a running DSH process; the script's whole job is to gate, then
print the exact `cordis_define` argument together with a sha256 fingerprint of
each half so a definition made in the process can be matched against these
files afterwards.

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