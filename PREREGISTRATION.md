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

### `v1.1` — 2026-09-07 · statement of the Šidák interval level

**What changed.** Under [Primary hypotheses](#primary-hypotheses) the plan reads:
"the interval level is Šidák-adjusted to hold the family-wide error rate at 5%:
for m simultaneous tests, each interval is computed at level
`1 − (1 − 0.05)^(1/m)`." The preceding sentence sets that level at 95%, so
"level" there names a confidence level — and the expression given is the
corrected per-test **significance level** α, which is the complement of the
confidence level, not the level itself. At m = 6 the sentence as written asks
for a 0.85% interval. The commitment is restated without the ambiguity:

> For m simultaneous tests, each interval is computed at confidence level
> `(1 − 0.05)^(1/m)`, equivalently at per-test significance level
> `α = 1 − (1 − 0.05)^(1/m)`. At m = 6 that is a 99.15% interval.

**Why.** The expression is correct as an α and incorrect as a level, so the
sentence had two readings and only one of them is arithmetically coherent. A
plan whose stated threshold can be read two ways gives back part of the freedom
it exists to remove, and the reading has to be fixed before any milestone
report applies it rather than after.

**What did not change.** No hypothesis, metric, family definition, milestone
trigger, or numeric threshold moves. `1 − (1 − 0.05)^(1/m)` remains the per-test
α; the family-wide error rate remains 5%; the family remains the one defined in
the same section, including the regime cells added at M3.

**Implementation status.** `familyThreshold` in
`packages/engine/src/scoring.ts` already computes the per-test α as
`1 − (1 − alpha)^(1/m)` and derives its two-sided threshold from it, so the
badge rule was never affected by the wording. The BCa routine in
`packages/engine/src/bootstrap.ts` accepts an `alpha` and currently runs at the
unadjusted 0.05 for the leaderboard's displayed intervals, which are
descriptive and carry no hypothesis claim. No family-adjusted interval has been
computed to date because no milestone has triggered: M1 requires n ≥ 120 on the
1d track for at least four participants, and the fourth-ranked row stands at
n = 71.

**Data already observed.** The 1d, 7d and 30d logs through 2026-09-07 have been
observed, and this amendment is therefore made with data in hand. It bears on
no test that has been run — no milestone report exists — and it corrects the
statement of a rule rather than the rule. Disclosed here as this section
requires.

**The v1 proof.** Appending this section changes the bytes of
`PREREGISTRATION.md`, so the Bitcoin-confirmed proof for plan `v1` no longer
matches this file. Those bytes and that proof are preserved unchanged as
`PREREGISTRATION.v1.md` and `PREREGISTRATION.v1.md.ots`, recorded under their
own entry in `data/anchor/documents.jsonl` with the original digest
`ee78172929270d8a…` and stamp time. `v1` therefore remains provably earlier
than the data it covers, independently of anything done to this file later.

### `v1.2` — 2026-09-08 · what counts as an independent observation

**What changed.** The independent-series rule promises that overlapping windows
are never counted twice. The implementation did not deliver it. Anchor
eligibility was decided by comparing calendar day indices, while a round is
scored over the interval that starts at its `committedAt`. Commit times drift
across the day — 00:06 to 09:52 UTC on the log so far — so consecutive anchors
shared hours of the same price path. On the log as of 2026-09-08, 39 of 79
adjacent 1d anchor pairs overlapped, by up to 9 hours 16 minutes of a 24 hour
window, and 7 of 10 did on 7d. The rule is restated so that it means what it
says:

> An anchor's window runs from its `committedAt` to `committedAt + horizon`. A
> round is eligible as the next anchor only if its window start is at or after
> the previous anchor's window end, compared as instants rather than as calendar
> days. The calendar bucket rule is unchanged: at most one anchor per ISO week
> at 7d and per calendar month at 30d. The 1d track no longer treats every round
> as an anchor, because at 1d the drift in commit time is a large fraction of
> the window.

**Why.** Independence is the assumption every interval and every t statistic in
this plan rests on. Counting two windows that share nine hours of the same price
movement as two observations inflates n, narrows every interval, and makes the
significance clock run faster than the evidence does. The defect was in the
implementation rather than in the plan's intent, but the plan's numbers were
computed with it, so correcting it is a change to the record and belongs here.

Pinning the job to a fixed commit time was considered and rejected as the fix. A
scheduled runner cannot guarantee an instant, and it would leave the existing
log unrepaired. The rule has to tolerate drift.

**A known residual, stated rather than hidden.** The exit price is the close of
the one-hour candle containing `committedAt + horizon`, so scoring actually
resolves up to one hour after the window end defined above. Two anchors exactly
one horizon apart therefore still share at most one hour of price path — at most
4% of a 1d window. That hour is deliberately not counted as overlap. Counting it
would make even a perfectly regular daily schedule overlap with itself, dropping
every second round forever. The residual is bounded by one candle and is
recorded here as a limitation of the independent series, not as something the
rule removes.

**The stricter rule came first, and it was replaced after both effects were
known.** The first draft of this amendment, committed locally on 2026-09-08 and
never published or timestamped, ended the window at the close of the exit
candle, and it said — truthfully — that the rule was fixed before its effect on
any participant was computed. That effect was then computed: 43 anchors on the
1d track rather than 52, gpt-5.5 moving from last among participants to second
(mean IC 0.050 against 0.001 under the rule adopted here), and claude-sonnet-5
at n = 30 with mean IC 0.091 against n = 37 and 0.117 here. The rule was
replaced the same evening, on the ground stated above — that discarding about a
sixth of the sample to remove a bounded 4% artefact is a bad trade. That ground
is an argument about the window, not about any participant, but the replacement
was made with the effect of both rules in view, so it is recorded as such and
not as a rule chosen blind. The draft's claim of having been fixed before its
effect was computed does not carry over to the rule adopted here. Both outcomes
are published so that a reader can weigh the choice against its effect rather
than take the reasoning on trust.

**Effect on the record.** Applied to the log as of 2026-09-08, current era, 1d:

| participant | n before | n after | mean IC before | mean IC after |
|---|---:|---:|---:|---:|
| *1d anchors* | *80* | *52* | | |
| claude-sonnet-5 | 58 | 37 | 0.0879 | 0.1173 |
| claude-opus-4-8 | 78 | 50 | 0.0142 | 0.0243 |
| gemini-3.5-flash | 73 | 47 | 0.0097 | 0.0349 |
| claude-fable-5 | 58 | 37 | 0.0113 | 0.0071 |
| gpt-5.5 | 74 | 48 | −0.0005 | 0.0011 |

The 1d track loses 35% of its observations. The order changes: gemini-3.5-flash
moves from fourth among participants to second. On 7d, 11 anchors become 10 and
every participant's mean IC falls; the 7d order moves more, because 7d has ten
observations and almost nothing there is separable from anything else.

**This amendment is made with the results in view, and it moves them.** That is
the disclosure this section exists to force, so it is stated plainly rather than
in a footnote. Three things bear on how much weight to give it. The defect was
found by reading the anchor-selection code against the scoring code, not by
inspecting rankings. The window-end definition was chosen on the argument set
out above, with the rejected alternative's effect published beside it. And the
sample loss falls on every participant at once, which is the shape a correction
to a shared definition should have.

**Retroactive.** The corrected rule applies to the whole log, not from this date
forward. Nothing in the committed data changes: rounds, predictions, prices and
per-round scores are untouched and their hashes and anchors still verify. Only
which of those already-committed rounds enter the independent series changes,
and that is a deterministic function any third party recomputes from the same
raw log. A forward-only cutover would instead leave two incompatible definitions
of n inside one methodology era, which is the thing era boundaries exist to
prevent.

**What did not change.** No hypothesis, metric, baseline, family definition or
threshold moves. M1 still triggers at n ≥ 120 on the 1d track for at least four
participants; the threshold is not restated in terms of the scarcer samples,
because lowering a bar after seeing that it moved away is exactly the freedom
this plan gives up. The projected dates recede accordingly — roughly by the
ratio the sample count falls, and further if commit times drift more.

**Two related corrections, recorded here but not plan changes.**

The `tilt:<model>` reference line was averaging that model's signals from
earlier methodology eras, although the plan already forbids pooling across eras.
The code now cuts the signal history at the era boundary; the price history
behind the three baselines is market data and is not cut. On the log before this
amendment's anchor change, that moved `tilt:claude-opus-4-8` from n = 77, IC
0.1304 to n = 68, IC 0.0985, and that participant's `IC − tilt` from −0.1223 to
−0.0849. No baseline lost a sample. This brings the implementation to the stated
rule rather than changing it, and no milestone report has ever used the old
values.

The paired gap between two rows was being computed twice — once for the tier
column and once for the vs-leader column — under two different seeds, so the two
columns could in principle separate a pair and not separate it. They are now one
computation, seeded from the participant pair in sorted order. Published
interval bounds shift slightly as a result. This is recorded next to the
prohibition on re-running an analysis with a different seed to obtain a
different result: it is the merging of two implementations of one comparison,
not a search across seeds, and the estimand is unchanged.

**Proofs.** Plan `v1` remains frozen at `PREREGISTRATION.v1.md` with its
Bitcoin-confirmed proof. This file's bytes now carry `v1`, `v1.1` and `v1.2` and
are stamped as one document; the amendments are not separately timestamped from
each other, only jointly with the text that contains them.

**Settled and stamped on different dates.** The rule, figures and reasoning in
`v1.2` were settled on 2026-09-08. The section was timestamped on 2026-09-14,
and the proof establishes only that later date. The only text added between the
two is the account above of the first draft and this paragraph. In that
interval, under the rule adopted here, claude-sonnet-5's 1d row crossed the
family-corrected badge threshold (t = 2.70 against 2.63 at n = 38, on the log as
of 2026-09-12). That row's statistic under the stricter first-draft rule was not
computed. Nothing in the rule was changed on account of it.

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
