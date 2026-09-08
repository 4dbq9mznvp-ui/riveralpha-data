# RiverAlpha analysis pre-registration

**Plan version `v1` · registered 2026-08-26 · covers Methodology `v0.3`**

This document fixes how RiverAlpha's data will be analysed **before** the data
exists to analyse. It is timestamped externally (see
[Timestamp](#timestamp)), so the commitments below can be shown to predate the
results they will be applied to.

## Why this exists

The benchmark already commits each forecast before its outcome is known, and
the hash chain plus external anchors make that commitment checkable. That
removes one degree of freedom — the predictions cannot be edited after the
fact. It does not remove the other one.

The remaining freedom is on our side of the table. With five participants,
three horizons, several derived reference lines, and a growing log, an analyst
who waits to see the numbers can almost always find a slice where somebody looks
skilled: pick the horizon that flatters, the window that starts after a bad
month, the baseline that happens to be weakest, the metric that happens to be
positive. None of that requires dishonesty. It only requires making the choices
after seeing the data.

So the choices are made here, first. If a later analysis departs from this plan,
that departure is itself reportable — see [Amendments](#amendments).

## What was already fixed before this plan

These are not new commitments; they are recorded so the boundary is clear.
They are defined in `apps/ingest/src/jobs/run-round.ts`,
`packages/engine/src/scoring.ts`, and `packages/engine/src/aggregation.ts`, and
are covered by the published methodology.

- The forecast target: expected 7-day return per asset, scored at 1d, 7d, 30d.
- The skill metric: Spearman rank IC across the round's universe.
- The independent series: one anchor round per ISO week (7d) or calendar month
  (30d), chosen by the calendar and never from results. Overlapping windows are
  never counted twice.
- Portfolio scoring: equal-weight top-2, 20 bps cost, alpha versus BTC.
- The existing badge rule: n ≥ 30 and |t| above a Šidák threshold that rises
  with the number of participant rows tested at once.
- Non-information reference lines: `baseline-lowvol`, `baseline-mom30`,
  `baseline-reversal`, and each participant's own frozen static tilt.

## Primary hypotheses

All primary tests use the **1d track**. It is designated primary here, before
the milestone is reached, because it is the only horizon that gains an
independent observation every day; 7d and 30d accrue too slowly for a primary
test within the plan's horizon. Choosing the primary track by pace rather than
by result is the point.

Each test uses the **95% BCa bootstrap interval** over the participant's
independent (anchor) rounds, with a fixed seed derived from the participant id
so the interval is reproducible. Where several participants are tested at once,
the interval level is Šidák-adjusted to hold the family-wide error rate at 5%:
for m simultaneous tests, each interval is computed at level
`1 − (1 − 0.05)^(1/m)`.

| ID | Hypothesis | Test | Supported when |
|---|---|---|---|
| **H1** | A participant has positive cross-sectional skill. | Mean IC over independent 1d rounds. | Family-adjusted interval excludes zero and lies above it. |
| **H2** | A participant beats non-information baselines. | Paired IC difference versus **each** of the three baselines, round by round. | All three paired intervals exclude zero and lie above it. |
| **H3** | Daily re-judgement adds value over a frozen ranking. | Paired mean(IC − own static-tilt IC). | Interval excludes zero and lies above it. |
| **H4** | The median consensus beats the best individual. | Paired IC difference, consensus versus each model. | Interval versus every model excludes zero and lies above it. |
| **H5** | An edge survives realistic execution cost. | Breakeven one-way cost in bps for the L/S conviction construction. | Breakeven exceeds 10 bps with the interval on mean return excluding zero. |

**H2 requires clearing all three baselines, not the weakest.** That conjunction
is deliberately conservative and is fixed now precisely because the ranking of
the baselines is already visible in the current data; allowing "the appropriate
baseline" to be selected later would hand back the freedom this plan removes.

## Milestones

Analyses run when a **sample threshold** is reached, not on a calendar date
chosen afterwards. Dates below are projections from the accrual rate at
registration and carry no authority; the sample count is the trigger.

Every trigger is stated as "for at least four participants", so a milestone
cannot be reached by one fast-accruing row.

| Milestone | Trigger | Projected | Reports |
|---|---|---|---|
| **M1** | 1d track reaches n ≥ 120 | ≈ 2026-10-24 | H1, H2, H3, H4 |
| **M2** | 7d track reaches n ≥ 30 | ≈ 2027-01-27 | H1–H3 on 7d |
| **M3** | 1d track reaches n ≥ 250 | ≈ 2027-03-03 | H1–H5, plus the regime split below |

Projections use the accrual observed at registration: the fourth-ranked
participant by sample count stands at n = 61 (1d) and n = 8 (7d), gaining one
independent observation per day and per ISO week respectively.

The 30d track needs about 29 more months to reach n = 30, at one independent
observation per calendar month — roughly 2029-01. No 30d hypothesis test is
pre-registered here, because the plan cannot honestly promise one within its own
horizon. Until then 30d rows are descriptive only, and the site says so.

## Pre-specified regime split

Reported at M3. Regimes are defined only from data already committed in the log,
so the definition cannot be tuned to the answer:

- **Volatility regime** — terciles of BTC's trailing 30-round realized
  volatility, computed from recorded `entryPrices` at each anchor round.
- **Direction regime** — sign of BTC's realized return over the scoring window,
  from the same recorded prices used for scoring.

Each regime cell is treated as an additional simultaneous test and enters the
Šidák family. Regime results are **secondary**: a hypothesis that fails overall
but passes in one regime is reported as a failed hypothesis with an exploratory
note, never as a success.

## What will not be done

- No participant will be dropped, and no date range excluded, on the basis of
  its results. Participants enter when their credentials are configured and
  leave only when the provider stops answering; both are visible in the log.
- No new skill metric will be introduced and then reported as primary. New
  metrics are exploratory until a subsequent plan version pre-registers them.
- No pooling across methodology eras. The significance clock restarts at an era
  boundary, as it already does on the site.
- No re-running of an analysis with a different seed to obtain a different
  interval. Seeds are derived deterministically from participant id and horizon.
- No reporting of the best cell from a set of unreported ones. Every cell in a
  reported family is published, including the ones that fail.

## Publication commitment

The result of each milestone will be published in full, including the outcome
that no participant clears any primary hypothesis.

That outcome is a live possibility and is worth stating plainly while it is
still a prediction rather than an excuse: at registration, on the 1d track, no
participant's interval excludes zero, while several non-information reference
lines do. If that pattern holds at M1 and M3, the finding is that these models
show no measurable cross-sectional skill on this task at this horizon — and that
is a result the benchmark exists to be able to state.

## Amendments

This plan is append-only. A change is made by adding a new dated section below
and incrementing the plan version; the text above is never rewritten. Each
amendment records what changed, why, and whether any data covered by the change
had already been observed. An amendment made after seeing data that bears on the
amended test is disclosed as such in the milestone report.

Analyses always name the plan version they ran under.

*No amendments yet.*

## Timestamp

`PREREGISTRATION.md` is timestamped with OpenTimestamps. The proof lives at
`PREREGISTRATION.md.ots` and is verified against this file's bytes:

```bash
ots verify PREREGISTRATION.md.ots
# or, without the reference client:
node public-mirror/verify-anchors.mjs --documents
```

A pending proof only shows that a calendar server accepted the digest. Once it
confirms in a Bitcoin block, this plan provably predates that block — which is
what distinguishes a pre-registration from a claim about one.

Because the proof covers the file's exact bytes, **editing this file invalidates
it.** That is the intended behaviour, and it is why amendments are appended and
separately stamped rather than edited in.
