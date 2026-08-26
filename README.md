# RiverAlpha — public data mirror

Append-only, hash-chained log of AI market predictions, committed **before** the outcome and scored against realized returns.

This repository is the public data mirror for [RiverAlpha](https://river-alpha-web.vercel.app). It is updated automatically once per day by CI. Its visible git history provides publication evidence, while the hash chain makes changes to already-published prediction payloads detectable. The repository itself remains operator-controlled, but from 2026-08-26 the chain heads are additionally committed to an external timestamp that the operator does not control — see [Verify the external anchors](#verify-the-external-anchors).

Everything needed to check the published prediction hash chain is in this repo.

Verification is deliberately scoped: the chain covers prediction payloads and,
from 2026-07-09, bound model evidence. It does not independently validate
publication time, source prices, recorded scores, or model-provider responses.

## Version boundaries

- **Data/Audit Schema `v0.5`** identifies the fields and protected payload of
  future round and score records (`dataSchemaVersion: "v0.5"`).
  `v0.4` remains supported and is not rewritten: records committed under it are
  hashed with the payload that version defined.
- **Methodology `v0.3`** identifies forecast inputs and scoring conditions.
- **Record Integrity Format `v1`** (`recordIntegrity.version: 1`) identifies the
  separate round/score hash envelope and linkage rules. It is unchanged by the
  `v0.5` schema bump — the envelope, domain, and linkage rules are identical.

These are independent versions. Existing JSONL is not backfilled. A protected
record must declare a supported Data/Audit Schema version, and
`verify-records.mjs` includes that value in its recomputed payload hash.

### What changed in `v0.5`

Round records gained `executionContext`, recorded so that slippage, funding cost,
and capacity can be reconstructed later. It holds two independent snapshots:

- `sources` — per asset, each spot venue's best bid, best ask, and 24-hour traded
  volume at commit time, from the same four venues that provide reference prices.
- `funding` — per asset, the current perpetual-futures funding rate on each venue
  that answered (Binance, Bybit, Kraken Futures), with that venue's funding
  interval and next funding time. Venues are attempted independently and the keys
  show which ones replied; access differs by region, so a venue reachable from one
  environment may be blocked from another.

  Kraken reports an **absolute** funding figure rather than a relative rate, so
  its `rate` here is derived as `fundingRate / markPrice` on a one-hour interval.
  That derivation is an interpretation of the venue's semantics, so the
  pre-conversion values are also kept in `raw` — if the interpretation is wrong,
  the record still holds enough to recompute. Venues that publish a relative rate
  directly have no `raw`.
- `candidates` — a daily snapshot of every asset listed on at least three of the
  four spot venues, whether or not it is in the current universe: exchange count,
  median last price, and summed 24-hour USD volume. This exists so a future
  universe change can be judged against a multi-day record rather than a single
  reading taken on the day of the decision. Assets outside the universe have no
  price history anywhere else in this log, so it cannot be reconstructed later.
  Stablecoins and wrapped tokens are excluded; `listed` counts exchanges, not
  trading pairs.

`rate` is the relative rate for **one interval**, not an annual figure.
Annualising is `rate × (24 / intervalHours) × 365`, and the interval differs by
venue and symbol, so a rate without its interval cannot be annualised correctly.
Both are stored as reported rather than normalised.

**Neither snapshot is an input to scoring.** Entry prices, realized returns, and
every published score are computed exactly as before, from the four spot venues
only. Binance and Bybit appear here and nowhere else: they are the perpetual
venues, they are recorded for cost reconstruction, and if they were wrong or
disappeared no past score would change. Because the value sits inside the
protected payload from `v0.5` on, altering a recorded quote or rate breaks the
round record hash.

Collection is best-effort and the two halves fail independently: if a venue
cannot be reached the round still commits, and the affected half records
`{"status": "degraded", …, "reason": …}` rather than being silently omitted.
Quotes are stored as reported — a very wide spread is a real market state and is
not filtered out.

## Layout

```
data/log/crypto/rounds.jsonl   # one line per round: predictions, entry prices, hashes
data/log/crypto/scores.jsonl   # one line per (round, horizon) resolution: realized returns, IC, alpha
data/anchor/crypto/
  anchors.jsonl                # append-only index: one line per external anchor
  <anchorId>.anchor.json       # the exact bytes that were timestamped
  <anchorId>.anchor.json.ots   # OpenTimestamps proof for those bytes
verify.py                      # self-contained chain verifier (Python, stdlib only)
verify.mjs                     # same verifier in Node (no dependencies)
verify-scores.mjs              # recomputes realized returns and every recorded score
verify-records.mjs             # verifies optional round-metadata and score-record chains
verify-anchors.mjs             # verifies external timestamps against the log prefix
```

## Verify the chain

```bash
python verify.py
# or
node verify.mjs data/log/crypto/rounds.jsonl
```

It recomputes every payload hash, merkle root, and chain hash from the raw
data and compares them to the recorded values. A payload that no longer matches
its recorded commitment makes verification fail. Detecting a coherent rewrite
of both data and hashes requires comparison with a previously observed chain
hash or repository history.

## Verify the scores

```bash
node verify-scores.mjs data/log/crypto/rounds.jsonl data/log/crypto/scores.jsonl
```

This dependency-free verifier joins every score record to its round, rejects
duplicate records or missing participants, and checks methodology and horizon
consistency. It recomputes realized and benchmark returns from recorded entry
and exit prices, then recomputes tied-average-rank Spearman IC, equal-weight
top-k return, costs, and alpha for every submitted participant. Success reports
the number of score records and participant scores with `0 mismatches`. Empty
round or score logs fail verification rather than reporting a vacuous success.

The score verifier establishes internal consistency with the recorded prices;
it does not establish that exchange APIs supplied accurate prices.

## Verify protected round and score records

```bash
node verify-records.mjs data/log/crypto/rounds.jsonl data/log/crypto/scores.jsonl
```

Rounds and scores created after the optional record chains begin carry
`dataSchemaVersion` and
`recordIntegrity = {version, prevRecordHash, recordHash}`. The round payload
covers its prediction chain references, commit time, methodology, horizons,
universe, entry prices and sources, failures, misses, optional receipt, and —
from `v0.5` — the commit-time execution snapshot. The
score payload covers its resolution timestamps, exit prices and sources,
realized returns, benchmark and scoring configuration, participant scores, and
references to the source round's prediction chain and optional round record
hash. Both protected payloads cover `dataSchemaVersion`; missing or unsupported
schema versions fail verification.

The first protected record in each log has `prevRecordHash: null`; legacy
records before it are not retroactively protected. Once protection begins,
every later record must be protected and linked to the previous record hash.
The verifier rejects payload changes, a missing protected record, a chain
restart, and mismatched score-to-round references. With the current legacy-only
files it reports `0 protected` explicitly rather than implying historical
coverage. Empty round or score files fail.

## Verify the external anchors

```bash
node verify-anchors.mjs data/log/crypto/rounds.jsonl data/log/crypto/scores.jsonl data/anchor/crypto
# add --check-bitcoin to also fetch block merkle roots from blockstream.info
```

Every hash chain above proves only that this log is *internally* consistent. An
operator who recomputed the whole log could produce a different history that
still verifies. Detecting that requires comparing against something observed
earlier — which is what an external anchor provides, without asking you to trust
the operator or this repository.

Periodically the three chain heads (`predictionChainHash`, `roundRecordHash`,
`scoreRecordHash`) plus the covered record counts are written into a small
canonical JSON file and timestamped with
[OpenTimestamps](https://opentimestamps.org), which aggregates digests into the
Bitcoin blockchain. The anchor file's own SHA-256 **is** the timestamped digest,
so the standard client verifies it directly with no RiverAlpha code involved:

```bash
ots verify data/anchor/crypto/<anchorId>.anchor.json.ots
```

`verify-anchors.mjs` additionally checks what the standard client cannot: that
the heads recorded in each anchor still match the values recomputed from the
**first N records** of the current log. If a past round or score were rewritten,
added, or removed, the recomputed prefix would no longer reproduce the anchored
heads and verification fails.

Two states matter and the verifier always distinguishes them:

- **Pending** — a calendar server accepted the digest and returned a receipt.
  This is *not* independent evidence yet; it only says a calendar claims to have
  seen the value. Calendars normally commit to a Bitcoin block within hours.
- **Bitcoin-confirmed** — the proof resolves to a block header merkle root. The
  anchored log state provably existed before that block was mined, and no later
  rewrite can claim an earlier time. With `--check-bitcoin` the verifier fetches
  the block from blockstream.info and compares merkle roots; without it, the
  computed merkle root and block height are printed so you can check them in any
  block explorer.

What an anchor does **not** prove: that any individual prediction was made
before its outcome was known (the anchor bounds the whole log state, at the
resolution of the anchoring cadence and the calendar's block delay), that
recorded prices are accurate, or that a model provider truly returned a given
response. It bounds *when this exact log state existed*, nothing more.

Anchor payload files are immutable and `anchors.jsonl` is append-only. Proof
files grow monotonically — upgrading a pending receipt to a Bitcoin proof only
adds branches, never removes evidence.

Some anchors also carry a `.sigstore.json` bundle: a
[Sigstore](https://www.sigstore.dev) signature recorded in the public Rekor
transparency log. It confirms almost immediately rather than in hours, but it is
bound to this repository's GitHub Actions identity, so it is a weaker and
differently-shaped witness than the Bitcoin proof. Treat the two as
complementary, not redundant.

## Optional public round receipt

New rounds may include a round-level `receipt`. When present, it publishes the
common plaintext prompt and matching `promptHash`, the feature matrix actually
used (or an explicit degraded/null state), and the full expected roster with a
`submitted`, `missed`, or `inactive` status. Older rounds remain valid without
this optional field. The receipt is never added to the existing prediction
merkle or prediction chain. When the round also has `recordIntegrity`, however,
the separate round-record chain covers the receipt as audit context, and its
prompt hash can be cross-checked against each successful prediction's bound
evidence.

## Hash scheme (spec)

- `canonical_json(x)`: JSON with object keys sorted recursively, no whitespace
  (equivalent to Python `json.dumps(x, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`).
- Payload hash per prediction: `sha256(canonical_json({participantId, roundId, signal}))` (hex).
  Binding `roundId` makes signals non-replayable across rounds.
- **Evidence binding (rounds committed from 2026-07-09).** Each prediction also
  carries an `evidenceHash` covering its audit trail:
  `evidenceHash = sha256(canonical_json({modelRequested, modelUsed, params, promptHash, rationale, raw}))`,
  and the payload becomes
  `sha256(canonical_json({evidenceHash, participantId, roundId, signal}))`.
  So the model id, parameters, prompt hash, stated rationale, and raw response
  are tamper-evident too, not just the signal. Predictions without
  `evidenceHash` (earlier rounds) keep the original payload format and still
  verify unchanged.
- Merkle tree (RFC 6962-style domain separation), leaves sorted by `participantId`:
  - leaf node: `sha256("00" + payload_hash_hex)`
  - internal node: `sha256("01" + left_hex + right_hex)`
  - odd node count per level: last node is duplicated
- Chain: `chain = sha256("02" + prev_chain_hex + merkle_root_hex)`,
  with genesis `sha256("hangang-pj/genesis")`. The `hangang-pj` string is the
  project's original working name, retained verbatim because the genesis seed is
  fixed: changing it would invalidate the chain of every round already committed.
  It is not a separate project.

All hashes are lowercase hex; hash inputs are the UTF-8 bytes of the
concatenated hex strings (with the 2-char domain tag prefix).

The separate record chains use SHA-256 over canonical JSON with domain
`riveralpha/record-integrity/v1`, record kind (`round` or `score`), version,
`prevRecordHash`, and the explicit payload described above. They do not alter
the prediction hash scheme.

## Scoring (summary)

- Signal: expected 7-day return (%) for every asset in the universe; scored at 1d/7d/30d horizons.
- Entry: multi-exchange median spot (Coinbase, Gemini, Bitstamp, Kraken; USD) at commit time.
- Exit: close of the 1-hour candle containing `commit + horizon`, median across the same exchanges.
- Skill metric: Spearman rank IC across the universe; portfolio = equal-weight top-2, 20 bps cost; alpha vs BTC.
- A track record is labeled significant only at n ≥ 30 independent resolved rounds and |t| > 2;
  multi-day horizons count only non-overlapping windows.
- The methodology is versioned (currently v0.3); every round and score records the
  version it ran under, and records are never pooled across versions.

Full methodology: https://river-alpha-web.vercel.app/methodology

## Disclaimer

RiverAlpha is a research benchmark. Nothing here is investment advice or a
recommendation to buy or sell any asset.
