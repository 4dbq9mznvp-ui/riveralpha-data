# RiverAlpha — public data mirror

Append-only, hash-chained log of AI market predictions, committed **before** the outcome and scored against realized returns.

This repository is the public anchor for [RiverAlpha](https://river-alpha-web.vercel.app). It is updated automatically once per day by CI. The git commit history is an independent, tamper-evident timestamp: a prediction cannot be inserted or altered after the fact without breaking every subsequent hash and rewriting public history.

**Don't trust us — verify.** Everything needed to check the chain is in this repo.

## Layout

```
data/log/crypto/rounds.jsonl   # one line per round: predictions, entry prices, hashes
data/log/crypto/scores.jsonl   # one line per (round, horizon) resolution: realized returns, IC, alpha
verify.py                      # self-contained chain verifier (Python, stdlib only)
verify.mjs                     # same verifier in Node (no dependencies)
```

## Verify the chain

```bash
python verify.py
# or
node verify.mjs data/log/crypto/rounds.jsonl
```

It recomputes every payload hash, merkle root, and chain hash from the raw
data and compares them to the recorded values. Any tampering with any past
prediction makes it fail.

## Hash scheme (spec)

- `canonical_json(x)`: JSON with object keys sorted recursively, no whitespace
  (equivalent to Python `json.dumps(x, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`).
- Payload hash per prediction: `sha256(canonical_json({participantId, roundId, signal}))` (hex).
  Binding `roundId` makes signals non-replayable across rounds.
- Merkle tree (RFC 6962-style domain separation), leaves sorted by `participantId`:
  - leaf node: `sha256("00" + payload_hash_hex)`
  - internal node: `sha256("01" + left_hex + right_hex)`
  - odd node count per level: last node is duplicated
- Chain: `chain = sha256("02" + prev_chain_hex + merkle_root_hex)`,
  with genesis `sha256("hangang-pj/genesis")`.

All hashes are lowercase hex; hash inputs are the UTF-8 bytes of the
concatenated hex strings (with the 2-char domain tag prefix).

## Scoring (methodology v0.1, summary)

- Signal: expected 7-day return (%) for every asset in the universe; scored at 1d/7d/30d horizons.
- Entry: multi-exchange median spot (Coinbase, Gemini, Bitstamp; USD) at commit time.
- Exit: close of the 1-hour candle containing `commit + horizon`, median across the same exchanges.
- Skill metric: Spearman rank IC across the universe; portfolio = equal-weight top-2, 20 bps cost; alpha vs BTC.
- A track record is labeled significant only at n ≥ 30 resolved rounds and |t| > 2.

Full methodology: https://river-alpha-web.vercel.app/methodology

## Disclaimer

RiverAlpha is a research benchmark. Nothing here is investment advice or a
recommendation to buy or sell any asset.
