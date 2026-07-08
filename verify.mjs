// 일회용 교차검증: 엔진 코드 없이 README 스펙만으로 체인 재계산 (verify.py와 동일 로직)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const H = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const canon = (o) => {
  if (o === null || typeof o !== "object") return JSON.stringify(o);
  if (Array.isArray(o)) return "[" + o.map(canon).join(",") + "]";
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canon(o[k])).join(",") + "}";
};
const merkle = (leaves) => {
  if (!leaves.length) return H("");
  let lv = leaves.map((l) => H("00" + l));
  while (lv.length > 1) {
    const nx = [];
    for (let i = 0; i < lv.length; i += 2) nx.push(H("01" + lv[i] + (lv[i + 1] ?? lv[i])));
    lv = nx;
  }
  return lv[0];
};

let chain = H("hangang-pj/genesis");
let n = 0;
const path = process.argv[2] ?? "data/log/crypto/rounds.jsonl";
for (const line of readFileSync(path, "utf8").trim().split("\n")) {
  const r = JSON.parse(line);
  const leaves = [...r.predictions]
    .sort((a, b) => (a.participantId < b.participantId ? -1 : 1))
    .map((p) => {
      const payload = { participantId: p.participantId, roundId: r.roundId, signal: p.signal };
      if (p.evidenceHash) {
        // 2026-07-09~: 감사 증거(모델·파라미터·promptHash·rationale·원응답)도 leaf에 바인딩
        const ev = H(canon({
          modelRequested: p.modelRequested,
          modelUsed: p.modelUsed,
          params: p.params,
          promptHash: p.promptHash,
          rationale: p.rationale,
          raw: p.raw,
        }));
        if (ev !== p.evidenceHash) throw new Error(`${r.roundId}: evidence mismatch (${p.participantId})`);
        payload.evidenceHash = p.evidenceHash;
      }
      const h = H(canon(payload));
      if (p.payloadHash && h !== p.payloadHash) throw new Error(`${r.roundId}: payload mismatch (${p.participantId})`);
      return h;
    });
  const root = merkle(leaves);
  if (root !== r.merkleRoot) throw new Error(`${r.roundId}: merkle mismatch`);
  if (r.prevChainHash !== chain) throw new Error(`${r.roundId}: prev mismatch`);
  chain = H("02" + chain + root);
  if (chain !== r.chainHash) throw new Error(`${r.roundId}: chain mismatch`);
  n++;
}
console.log(`independent crosscheck OK: ${n} round(s), chain=${chain}`);
