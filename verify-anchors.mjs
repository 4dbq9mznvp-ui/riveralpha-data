#!/usr/bin/env node
/**
 * 외부 앵커 검증기 — 의존성 없음. 엔진 코드를 쓰지 않는 독립 재구현이다.
 *
 * 확인하는 것:
 *   1. 게시된 앵커 payload 파일의 sha256 === 색인의 앵커 해시
 *   2. `.ots` 증거가 그 앵커 해시를 다이제스트로 갖는가 (OpenTimestamps 와이어 포맷 직접 파싱)
 *   3. 앵커가 커밋한 체인 head가 **현재 로그의 앞부분 N개**에서 다시 계산한 값과 같은가
 *   4. 앵커 색인이 단조로운가 (구간이 줄어들지 않는가)
 *   5. 각 앵커가 지금 어떤 증거를 갖고 있는가 — pending(캘린더 접수증) vs 비트코인 블록
 *
 * 확인하지 **않는** 것: 체인 자체의 내부 정합성. 그건 verify.mjs(예측 체인)와
 * verify-records.mjs(레코드 체인)의 몫이다. 이 스크립트는 "그 체인의 head가 과거
 * 어느 시점에 외부에 고정됐는가"만 본다. 셋을 다 돌려야 그림이 완성된다.
 *
 * `--check-bitcoin` 을 주면 blockstream.info 공개 API로 블록 머클루트까지 대조한다
 * (네트워크 필요). 이 옵션 없이는 블록 높이와 계산된 머클루트를 출력만 하므로,
 * 아무 블록 탐색기에서 직접 대조할 수 있다.
 *
 *   node verify-anchors.mjs [rounds.jsonl] [scores.jsonl] [anchorDir] [--check-bitcoin]
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ANCHOR_DOMAIN = "riveralpha/anchor/v1";
const ANCHOR_VERSION = 1;

const OTS_MAGIC = Buffer.from("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294", "hex");
const OTS_MAJOR_VERSION = 1;
const PENDING_TAG = "83dfe30d2ef90c8e";
const BITCOIN_TAG = "0588960d73d71901";

function fail(message) {
  throw new Error(message);
}

// ─────────────────────────────────────────────────────────────────────────────
// canonical JSON (해싱 규약 — 엔진과 같은 규칙을 독립적으로 다시 구현)
// ─────────────────────────────────────────────────────────────────────────────

function canonical(value) {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`canonical JSON: non-finite number (${String(value)})`);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object") fail(`canonical JSON: unsupported type ${typeof value}`);
  return `{${Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

const sha256Hex = (buffer) => createHash("sha256").update(buffer).digest("hex");

function readJsonl(path, label) {
  if (!existsSync(path)) fail(`${label}: file not found (${path})`);
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  return text.split(/\r?\n/).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`${label} line ${index + 1}: invalid JSON (${error.message})`);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenTimestamps 파서 (읽기 전용)
// ─────────────────────────────────────────────────────────────────────────────

class Reader {
  #buf;
  #pos = 0;
  constructor(buf) {
    this.#buf = buf;
  }
  get remaining() {
    return this.#buf.length - this.#pos;
  }
  bytes(n) {
    if (this.remaining < n) fail(`ots: truncated (need ${n}, have ${this.remaining})`);
    const out = this.#buf.subarray(this.#pos, this.#pos + n);
    this.#pos += n;
    return out;
  }
  byte() {
    return this.bytes(1)[0];
  }
  varuint() {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      value += (b & 0x7f) * 2 ** shift;
      if (!Number.isSafeInteger(value)) fail("ots: varuint out of safe range");
      if ((b & 0x80) === 0) return value;
      shift += 7;
      if (shift > 63) fail("ots: varuint too long");
    }
  }
  varbytes(max) {
    const n = this.varuint();
    if (n > max) fail(`ots: varbytes too long (${n} > ${max})`);
    return this.bytes(n);
  }
}

function applyOp(op, msg) {
  switch (op.kind) {
    case "sha256":
      return createHash("sha256").update(msg).digest();
    case "sha1":
      return createHash("sha1").update(msg).digest();
    case "ripemd160":
      return createHash("ripemd160").update(msg).digest();
    case "reverse":
      return Buffer.from(msg).reverse();
    case "hexlify":
      return Buffer.from(Buffer.from(msg).toString("hex"), "ascii");
    case "append":
      return Buffer.concat([Buffer.from(msg), op.arg]);
    case "prepend":
      return Buffer.concat([op.arg, Buffer.from(msg)]);
    default:
      // keccak256 등은 Node가 제공하지 않는다. 다른 해시로 대체하면 틀린 값을
      // 옳다고 보고하게 되므로 조용히 넘어가지 않는다.
      fail(`ots: unsupported operation '${op.kind}'`);
  }
}

function parseOp(reader, tag) {
  switch (tag) {
    case 0x02:
      return { kind: "sha1" };
    case 0x03:
      return { kind: "ripemd160" };
    case 0x08:
      return { kind: "sha256" };
    case 0x67:
      return { kind: "keccak256" };
    case 0xf2:
      return { kind: "reverse" };
    case 0xf3:
      return { kind: "hexlify" };
    case 0xf0:
      return { kind: "append", arg: Buffer.from(reader.varbytes(4096)) };
    case 0xf1:
      return { kind: "prepend", arg: Buffer.from(reader.varbytes(4096)) };
    default:
      fail(`ots: unknown opcode 0x${tag.toString(16).padStart(2, "0")}`);
  }
}

function parseAttestation(reader) {
  const tag = Buffer.from(reader.bytes(8)).toString("hex");
  const payload = Buffer.from(reader.varbytes(8192));
  const inner = new Reader(payload);
  if (tag === PENDING_TAG) return { type: "pending", uri: Buffer.from(inner.varbytes(1024)).toString("utf8") };
  if (tag === BITCOIN_TAG) return { type: "bitcoin", height: inner.varuint() };
  return { type: "unknown", tag };
}

/** 트리를 걸으며 attestation과 그 지점의 메시지를 모은다. */
function parseTimestamp(reader, msg, out, depth = 256) {
  if (depth <= 0) fail("ots: recursion limit exceeded");
  const consume = (tag) => {
    if (tag === 0x00) {
      out.push({ attestation: parseAttestation(reader), msg });
      return;
    }
    const op = parseOp(reader, tag);
    parseTimestamp(reader, applyOp(op, msg), out, depth - 1);
  };
  let tag = reader.byte();
  while (tag === 0xff) {
    consume(reader.byte());
    tag = reader.byte();
  }
  consume(tag);
}

function parseDetachedOts(buf) {
  const reader = new Reader(buf);
  if (!Buffer.from(reader.bytes(OTS_MAGIC.length)).equals(OTS_MAGIC)) fail("ots: bad magic header");
  const version = reader.varuint();
  if (version !== OTS_MAJOR_VERSION) fail(`ots: unsupported major version ${version}`);
  const fileHashOp = parseOp(reader, reader.byte());
  if (fileHashOp.kind !== "sha256") fail(`ots: expected a sha256 file hash, got '${fileHashOp.kind}'`);
  const digest = Buffer.from(reader.bytes(32));
  const attestations = [];
  parseTimestamp(reader, digest, attestations);
  if (reader.remaining !== 0) fail(`ots: ${reader.remaining} trailing bytes`);
  return { digest, attestations };
}

// ─────────────────────────────────────────────────────────────────────────────
// 로그 앞부분에서 head 재계산
// ─────────────────────────────────────────────────────────────────────────────

function headsForPrefix(rounds, scores, scope) {
  if (rounds.length < scope.roundCount) {
    fail(`log shrank: anchor covers ${scope.roundCount} rounds but the log has ${rounds.length}`);
  }
  if (scores.length < scope.scoreCount) {
    fail(`log shrank: anchor covers ${scope.scoreCount} scores but the log has ${scores.length}`);
  }
  const roundPrefix = rounds.slice(0, scope.roundCount);
  const scorePrefix = scores.slice(0, scope.scoreCount);
  const protectedRounds = roundPrefix.filter((r) => r.recordIntegrity);
  const protectedScores = scorePrefix.filter((s) => s.recordIntegrity);
  return {
    heads: {
      predictionChainHash: roundPrefix.at(-1)?.chainHash ?? null,
      roundRecordHash: protectedRounds.at(-1)?.recordIntegrity?.recordHash ?? null,
      scoreRecordHash: protectedScores.at(-1)?.recordIntegrity?.recordHash ?? null,
    },
    scope: {
      roundCount: scope.roundCount,
      scoreCount: scope.scoreCount,
      firstRoundId: roundPrefix[0]?.roundId ?? null,
      latestRoundId: roundPrefix.at(-1)?.roundId ?? null,
      protectedRoundCount: protectedRounds.length,
      protectedScoreCount: protectedScores.length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 비트코인 대조 (선택)
// ─────────────────────────────────────────────────────────────────────────────

async function bitcoinMerkleRoot(height) {
  const hashResponse = await fetch(`https://blockstream.info/api/block-height/${height}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!hashResponse.ok) fail(`blockstream: HTTP ${hashResponse.status} for height ${height}`);
  const blockHash = (await hashResponse.text()).trim();
  const blockResponse = await fetch(`https://blockstream.info/api/block/${blockHash}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!blockResponse.ok) fail(`blockstream: HTTP ${blockResponse.status} for block ${blockHash}`);
  const block = await blockResponse.json();
  return { blockHash, merkleRoot: block.merkle_root, timestamp: block.timestamp };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * 문서 스탬프 검증 — 체인이 아니라 **파일 내용**이 언제부터 이 상태였는지를 본다.
 * 사전등록 계획처럼 데이터보다 먼저 고정됐음을 보여야 하는 파일에 쓴다.
 */
async function verifyDocuments(anchorDir, repoRoot, checkBitcoin) {
  const indexPath = join(anchorDir, "documents.jsonl");
  if (!existsSync(indexPath)) {
    console.log("document verification OK: no documents stamped yet");
    return;
  }
  const docs = readJsonl(indexPath, "documents");
  if (docs.length === 0) {
    console.log("document verification OK: no documents stamped yet");
    return;
  }

  let confirmed = 0;
  let pendingOnly = 0;
  let changed = 0;

  for (const doc of docs) {
    const label = doc.path ?? "?";
    const filePath = join(repoRoot, doc.path);
    const otsPath = join(repoRoot, doc.otsFile);
    if (!existsSync(otsPath)) fail(`${label}: proof file missing (${doc.otsFile})`);

    const detached = parseDetachedOts(readFileSync(otsPath));
    if (detached.digest.toString("hex") !== doc.sha256) {
      fail(`${label}: proof digest ${detached.digest.toString("hex")} != recorded ${doc.sha256}`);
    }

    // 파일이 남아 있으면 현재 내용이 스탬프된 내용인지 본다. 다르면 실패가 아니라
    // **사실 보고**다 — 옛 증거는 옛 내용에 대해 여전히 유효하고, 바뀌었다는 것
    // 자체가 독자가 알아야 할 정보다.
    let matchesNow = null;
    if (existsSync(filePath)) {
      matchesNow = sha256Hex(readFileSync(filePath)) === doc.sha256;
      if (!matchesNow) changed++;
    }

    const bitcoin = detached.attestations.filter((s) => s.attestation.type === "bitcoin");
    const pending = detached.attestations.filter((s) => s.attestation.type === "pending");
    const state = matchesNow === null ? "file absent" : matchesNow ? "current" : "SUPERSEDED";

    if (bitcoin.length === 0) {
      pendingOnly++;
      console.log(`~ ${label}  PENDING via ${new Set(pending.map((s) => s.attestation.uri)).size} calendar(s)  [${state}]`);
      continue;
    }
    confirmed++;
    for (const site of bitcoin) {
      const height = site.attestation.height;
      const merkleRoot = Buffer.from(site.msg).reverse().toString("hex");
      if (!checkBitcoin) {
        console.log(`✔ ${label}  bitcoin block ${height}  [${state}]`);
        console.log(`    merkle root: ${merkleRoot}`);
        continue;
      }
      const block = await bitcoinMerkleRoot(height);
      if (block.merkleRoot !== merkleRoot) {
        fail(`${label}: block ${height} merkle root mismatch (proof ${merkleRoot}, chain ${block.merkleRoot})`);
      }
      console.log(
        `✔ ${label}  bitcoin block ${height} @ ${new Date(block.timestamp * 1000).toISOString()}  [${state}]`,
      );
    }
  }

  console.log(
    `\ndocument verification OK: ${docs.length} stamp(s); ${confirmed} bitcoin-confirmed, ${pendingOnly} pending` +
      (changed > 0 ? `; ${changed} superseded by a later edit` : ""),
  );
  if (changed > 0) {
    console.log(
      "NOTE: a SUPERSEDED stamp still proves what the file said when it was stamped.\n" +
        "      It does not cover the current text — that needs its own stamp.",
    );
  }
}

async function verify(roundsPath, scoresPath, anchorDir, checkBitcoin) {
  const indexPath = join(anchorDir, "anchors.jsonl");
  if (!existsSync(indexPath)) {
    console.log("anchor verification OK: no anchors published yet");
    return;
  }

  const rounds = readJsonl(roundsPath, "rounds");
  const scores = readJsonl(scoresPath, "scores");
  const anchors = readJsonl(indexPath, "anchors");
  if (anchors.length === 0) {
    console.log("anchor verification OK: no anchors published yet");
    return;
  }

  let pendingOnly = 0;
  let confirmed = 0;
  let previous = null;

  for (const anchor of anchors) {
    const label = anchor.anchorId ?? "?";
    if (anchor.v !== ANCHOR_VERSION) fail(`${label}: unsupported anchor version ${anchor.v}`);

    // 1. 색인은 단조로워야 한다 — 앵커된 구간이 줄어드는 것은 로그 재작성의 징후다.
    if (previous) {
      if (anchor.scope.roundCount < previous.scope.roundCount) fail(`${label}: roundCount went backwards`);
      if (anchor.scope.scoreCount < previous.scope.scoreCount) fail(`${label}: scoreCount went backwards`);
      if (anchor.createdAt < previous.createdAt) fail(`${label}: createdAt went backwards`);
    }
    // 아래 검사들이 `continue` 로 빠져나가는 경로가 있으므로 순서 비교 기준은 여기서 갱신한다.
    previous = anchor;

    // 2. payload 파일의 바이트가 곧 해시 대상이다.
    const payloadPath = join(anchorDir, anchor.payloadFile);
    if (!existsSync(payloadPath)) fail(`${label}: payload file missing (${anchor.payloadFile})`);
    const payloadBytes = readFileSync(payloadPath);
    const computed = sha256Hex(payloadBytes);
    if (computed !== anchor.anchorHash) {
      fail(`${label}: payload file hash ${computed} != anchorHash ${anchor.anchorHash}`);
    }

    // 3. payload 내용과 색인이 같은 말을 하는가.
    const payload = JSON.parse(payloadBytes.toString("utf8"));
    if (payload.domain !== ANCHOR_DOMAIN) fail(`${label}: wrong anchor domain "${payload.domain}"`);
    if (payload.version !== ANCHOR_VERSION) fail(`${label}: wrong anchor version ${payload.version}`);
    if (canonical(payload.heads) !== canonical(anchor.heads)) fail(`${label}: index/payload heads disagree`);
    if (canonical(payload.scope) !== canonical(anchor.scope)) fail(`${label}: index/payload scope disagree`);
    // canonical 재직렬화가 원본 바이트와 같아야 한다 — 아니면 같은 내용의 다른
    // 바이트열을 만들어 해시를 우회할 여지가 생긴다.
    if (canonical(payload) !== payloadBytes.toString("utf8")) {
      fail(`${label}: payload file is not canonical JSON`);
    }

    // 4. 앵커가 커밋한 head가 현재 로그의 앞부분에서 다시 나오는가.
    const recomputed = headsForPrefix(rounds, scores, anchor.scope);
    if (canonical(recomputed.heads) !== canonical(anchor.heads)) {
      fail(
        `${label}: anchored heads do not match the current log prefix\n` +
          `    anchored:   ${canonical(anchor.heads)}\n` +
          `    recomputed: ${canonical(recomputed.heads)}`,
      );
    }
    if (canonical(recomputed.scope) !== canonical(anchor.scope)) {
      fail(
        `${label}: anchored scope does not match the current log prefix\n` +
          `    anchored:   ${canonical(anchor.scope)}\n` +
          `    recomputed: ${canonical(recomputed.scope)}`,
      );
    }

    // 5. 증거 파일.
    const otsPath = join(anchorDir, anchor.otsFile);
    if (!existsSync(otsPath)) fail(`${label}: proof file missing (${anchor.otsFile})`);
    const detached = parseDetachedOts(readFileSync(otsPath));
    if (detached.digest.toString("hex") !== anchor.anchorHash) {
      fail(`${label}: proof digest ${detached.digest.toString("hex")} != anchorHash ${anchor.anchorHash}`);
    }

    const bitcoin = detached.attestations.filter((site) => site.attestation.type === "bitcoin");
    const pending = detached.attestations.filter((site) => site.attestation.type === "pending");

    // 6. Sigstore 번들은 **있다는 사실만** 보고한다. 서명 검증에는 X.509 체인 검증,
    // DSSE, Rekor 포함증명이 필요해서 의존성 없는 스크립트의 범위를 넘는다. 검증한
    // 척하는 것보다, 있다는 것과 여기서 검증하지 않았다는 것을 함께 말하는 편이 낫다.
    // 실제 검증 명령은 README의 "Verify the external anchors" 절에 있다.
    const reportSigstore = () => {
      const bundlePath = join(anchorDir, `${anchor.payloadFile}.sigstore.json`);
      if (!existsSync(bundlePath)) return;
      let bundle;
      try {
        bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
      } catch (error) {
        fail(`${label}: sigstore bundle is not valid JSON (${error.message})`);
      }
      const index = bundle.verificationMaterial?.tlogEntries?.[0]?.logIndex;
      console.log(`    sigstore bundle present${index ? ` (rekor log index ${index})` : ""} — not verified by this script`);
    };

    if (bitcoin.length === 0) {
      pendingOnly++;
      const uris = [...new Set(pending.map((site) => site.attestation.uri))];
      console.log(`~ ${label}  rounds≤${anchor.scope.roundCount}  PENDING via ${uris.length} calendar(s)`);
      for (const uri of uris) console.log(`    pending: ${uri}`);
      reportSigstore();
      continue;
    }

    confirmed++;
    for (const site of bitcoin) {
      const height = site.attestation.height;
      // 비트코인 attestation은 "이 지점의 메시지가 블록 헤더의 머클루트다"라고 말한다.
      // 헤더 안의 값은 내부 바이트 순서(little-endian)이고 블록 탐색기는 그 역순으로
      // 표시하므로 뒤집어야 대조된다. 이 규약은 참조 구현이 동봉한 실제 확정 증거로
      // 실증했다 — 블록 129405 / 358391 / 523364 의 머클루트가 뒤집었을 때만 일치했고,
      // 같은 라이브러리의 의도적 불량 증거(bad-stamp)는 같은 높이에서 불일치했다.
      // 뒤집기를 빼면 모든 확정 앵커가 조용히 검증 실패한다.
      const merkleRoot = Buffer.from(site.msg).reverse().toString("hex");
      if (!checkBitcoin) {
        console.log(`✔ ${label}  rounds≤${anchor.scope.roundCount}  bitcoin block ${height}`);
        console.log(`    merkle root: ${merkleRoot}`);
        continue;
      }
      const block = await bitcoinMerkleRoot(height);
      if (block.merkleRoot !== merkleRoot) {
        fail(`${label}: block ${height} merkle root mismatch (proof ${merkleRoot}, chain ${block.merkleRoot})`);
      }
      const when = new Date(block.timestamp * 1000).toISOString();
      console.log(`✔ ${label}  rounds≤${anchor.scope.roundCount}  bitcoin block ${height} @ ${when}`);
    }
    if (pending.length > 0) {
      console.log(`    (${pending.length} pending branch(es) also present)`);
    }
    reportSigstore();
  }

  const suffix = checkBitcoin ? " (block merkle roots checked against blockstream.info)" : "";
  console.log(
    `\nanchor verification OK: ${anchors.length} anchor(s); ${confirmed} bitcoin-confirmed, ${pendingOnly} pending${suffix}`,
  );
  if (confirmed === 0) {
    console.log(
      "NOTE: no anchor is bitcoin-confirmed yet. A pending attestation only shows that a calendar\n" +
        "      accepted the digest — it is not yet independent evidence. Run `npm run anchor:upgrade`\n" +
        "      once the calendars have committed to a block (usually a few hours).",
    );
  }
}

const args = process.argv.slice(2);
const checkBitcoin = args.includes("--check-bitcoin");
const documentsOnly = args.includes("--documents");
const positional = args.filter((arg) => !arg.startsWith("--"));

try {
  if (documentsOnly) {
    await verifyDocuments(positional[0] ?? "data/anchor", positional[1] ?? ".", checkBitcoin);
  } else {
    await verify(
      positional[0] ?? "data/log/crypto/rounds.jsonl",
      positional[1] ?? "data/log/crypto/scores.jsonl",
      positional[2] ?? "data/anchor/crypto",
      checkBitcoin,
    );
  }
} catch (error) {
  const kind = documentsOnly ? "document" : "anchor";
  console.error(`${kind} verification FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
