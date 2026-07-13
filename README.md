# RiverAlpha — public data mirror

Append-only, hash-chained log of AI market predictions, committed **before** the outcome and scored against realized returns.

This repository is the public data mirror for [RiverAlpha](https://river-alpha-web.vercel.app). It is updated automatically once per day by CI. Its visible git history provides publication evidence, while the hash chain makes changes to already-published prediction payloads detectable. The repository remains operator-controlled and is not an independent timestamp authority.

Everything needed to check the published prediction hash chain is in this repo.

Verification is deliberately scoped: the chain covers prediction payloads and,
from 2026-07-09, bound model evidence. It does not independently validate
publication time, source prices, recorded scores, or model-provider responses.

## Version boundaries

- **Data/Audit Schema `v0.4`** identifies the fields and protected payload of
  future round and score records (`dataSchemaVersion: "v0.4"`).
- **Methodology `v0.3`** identifies forecast inputs and scoring conditions.
- **Record Integrity Format `v1`** (`recordIntegrity.version: 1`) identifies the
  separate round/score hash envelope and linkage rules.

These are independent versions. Existing JSONL is not backfilled. The first
future protected record must declare supported Data/Audit Schema `v0.4`, and
`verify-records.mjs` includes that value in its recomputed payload hash.

## Layout

```
data/log/crypto/rounds.jsonl   # one line per round: predictions, entry prices, hashes
data/log/crypto/scores.jsonl   # one line per (round, horizon) resolution: realized returns, IC, alpha
verify.py                      # self-contained chain verifier (Python, stdlib only)
verify.mjs                     # same verifier in Node (no dependencies)
verify-scores.mjs              # recomputes realized returns and every recorded score
verify-records.mjs             # verifies optional round-metadata and score-record chains
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
`dataSchemaVersion: "v0.4"` and
`recordIntegrity = {version, prevRecordHash, recordHash}`. The round payload
covers its prediction chain references, commit time, methodology, horizons,
universe, entry prices and sources, failures, misses, and optional receipt. The
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
  with genesis `sha256("hangang-pj/genesis")`.

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
