#!/usr/bin/env python3
"""RiverAlpha chain verifier — stdlib only. Recomputes every hash from raw data.

Usage: python verify.py [path/to/rounds.jsonl]
"""
import hashlib
import json
import sys


def H(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


GENESIS = H("hangang-pj/genesis")


def canon(o) -> str:
    return json.dumps(o, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def merkle(leaf_hashes: list[str]) -> str:
    if not leaf_hashes:
        return H("")
    level = [H("00" + leaf) for leaf in leaf_hashes]
    while len(level) > 1:
        nxt = []
        for i in range(0, len(level), 2):
            a = level[i]
            b = level[i + 1] if i + 1 < len(level) else a
            nxt.append(H("01" + a + b))
        level = nxt
    return level[0]


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else "data/log/crypto/rounds.jsonl"
    chain = GENESIS
    n = 0
    with open(path, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            r = json.loads(line)
            preds = sorted(r["predictions"], key=lambda p: p["participantId"])
            leaves = []
            for p in preds:
                payload = {
                    "participantId": p["participantId"],
                    "roundId": r["roundId"],
                    "signal": p["signal"],
                }
                h = H(canon(payload))
                if "payloadHash" in p and h != p["payloadHash"]:
                    print(f"FAIL {r['roundId']}: payload hash mismatch ({p['participantId']})")
                    return 1
                leaves.append(h)
            root = merkle(leaves)
            if root != r["merkleRoot"]:
                print(f"FAIL {r['roundId']}: merkle root mismatch")
                return 1
            if r["prevChainHash"] != chain:
                print(f"FAIL {r['roundId']}: prev chain hash mismatch")
                return 1
            chain = H("02" + chain + root)
            if chain != r["chainHash"]:
                print(f"FAIL {r['roundId']}: chain hash mismatch")
                return 1
            n += 1
            print(f"OK   {r['roundId']}  chain={chain[:16]}…")
    print(f"\nchain intact: {n} round(s) verified")
    print(f"latest chain hash: {chain}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
