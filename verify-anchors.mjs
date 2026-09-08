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
 * `--cache <path>` 는 이미 받아본 확정 블록을 파일에 재사용한다. **기본은 꺼짐**이고,
 * 왜 그런지는 openBlockCache 위 주석에 적어뒀다 — 요약하면 캐시는 편의지 증거가 아니다.
 *
 *   node verify-anchors.mjs [rounds.jsonl] [scores.jsonl] [anchorDir] [--check-bitcoin] [--cache <path>]
 *
 * 종료코드: 0 정상 / 1 검증 실패(증거가 틀렸다) / 2 확인 못함(블록 탐색기에 닿지 못했다).
 * 1과 2를 나눈 이유는 catch 블록 주석에 적어뒀다.
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const ANCHOR_DOMAIN = "riveralpha/anchor/v1";
const ANCHOR_VERSION = 1;

const OTS_MAGIC = Buffer.from("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294", "hex");
const OTS_MAJOR_VERSION = 1;
const PENDING_TAG = "83dfe30d2ef90c8e";
const BITCOIN_TAG = "0588960d73d71901";

function fail(message) {
  throw new Error(message);
}

/**
 * "증거가 틀렸다"와 "확인하지 못했다"는 전혀 다른 사건이다. 머클루트 불일치는 앵커가
 * 주장하는 것이 거짓이라는 뜻이고, 429나 타임아웃은 공개 블록 탐색기가 오늘 바빴다는
 * 뜻일 뿐 증거에 대해서는 아무것도 말해주지 않는다. 호출자가 둘을 다르게 처리할 수
 * 있도록 전송 실패만 따로 던진다.
 */
class TransportError extends Error {
  constructor(message) {
    super(message);
    this.name = "TransportError";
  }
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

const BITCOIN_RETRIES = 5;
const BITCOIN_BACKOFF_MS = 1_000;
const BITCOIN_BACKOFF_CAP_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 공개 API에는 레이트리밋이 있고, 앵커가 늘수록 한 번의 실행이 보내는 요청 수도 함께
 * 는다. 2026-09-03에 실제로 429를 맞아 anchor-upgrade 잡이 세 번 빨간불이 났다.
 * 한 번의 429로 전체 검증을 포기하는 것은 과잉 반응이라 물러났다 다시 시도한다.
 *
 * 지터를 섞는 이유: 없으면 여러 앵커의 재시도가 같은 리듬으로 몰려 같은 리밋을
 * 그대로 다시 맞는다. 429가 아닌 4xx는 다시 물어봐도 같은 답이 오므로 즉시 포기한다.
 */
async function fetchWithRetry(url, label) {
  let lastError;
  let waitMs = 0;
  for (let attempt = 0; attempt <= BITCOIN_RETRIES; attempt++) {
    if (waitMs > 0) await sleep(Math.min(waitMs, BITCOIN_BACKOFF_CAP_MS));
    const backoff = () => BITCOIN_BACKOFF_MS * 2 ** attempt * (1 + Math.random());

    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      lastError = new TransportError(`blockstream: ${error?.message ?? String(error)} for ${label}`);
      waitMs = backoff();
      continue;
    }

    if (response.ok) return response;
    if (response.status !== 429 && response.status < 500) {
      throw new TransportError(`blockstream: HTTP ${response.status} for ${label}`);
    }
    lastError = new TransportError(`blockstream: HTTP ${response.status} for ${label}`);
    const retryAfter = Number(response.headers.get("retry-after"));
    waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : backoff();
  }
  throw lastError;
}

/**
 * 확정된 블록의 (높이 → 해시·머클루트·시각)은 불변이라 한 번 받으면 다시 받을 이유가
 * 없다. 4시간마다 전부 다시 조회하면 요청 수가 앵커 수에 비례해 계속 늘어난다.
 *
 * 그런데 캐시는 **검증이 대조하는 그 값**이다. 캐시를 믿는다는 것은 딱 그만큼 독립성을
 * 파는 것이고, 오염된 캐시는 틀린 증거를 통과시킨다. 그래서 기본은 꺼짐이다 — 공개
 * 검증자가 아무 옵션 없이 돌리면 예전 그대로 전부 네트워크에서 다시 받는다. 켜는 쪽은
 * 하루에 몇 번씩 같은 블록을 다시 묻는 우리 CI뿐이고, 그 캐시 파일은 커밋하지도
 * 미러에 싣지도 않는다. **권위 있는 확인은 언제나 캐시 없이 돌린 실행이다.**
 */
function openBlockCache(path) {
  if (!path) return null;
  let entries = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed?.v === 1 && parsed.blocks && typeof parsed.blocks === "object") entries = parsed.blocks;
    } catch {
      // 캐시가 깨졌으면 조용히 버리고 네트워크에서 다시 받는다. 캐시는 편의일 뿐이라
      // 여기서 실패시키면 그게 더 나쁜 결과다.
      entries = {};
    }
  }
  let dirty = false;
  return {
    get(height) {
      const entry = entries[String(height)];
      if (
        typeof entry?.blockHash !== "string" ||
        typeof entry?.merkleRoot !== "string" ||
        typeof entry?.timestamp !== "number"
      ) {
        return null;
      }
      return entry;
    },
    set(height, value) {
      entries[String(height)] = value;
      dirty = true;
    },
    save() {
      if (!dirty) return;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ v: 1, blocks: entries }, null, 2)}\n`);
    },
  };
}

async function bitcoinMerkleRoot(height, cache) {
  const cached = cache?.get(height);
  if (cached) return cached;

  const hashResponse = await fetchWithRetry(`https://blockstream.info/api/block-height/${height}`, `height ${height}`);
  const blockHash = (await hashResponse.text()).trim();
  const blockResponse = await fetchWithRetry(`https://blockstream.info/api/block/${blockHash}`, `block ${blockHash}`);
  const block = await blockResponse.json();

  const result = { blockHash, merkleRoot: block.merkle_root, timestamp: block.timestamp };
  cache?.set(height, result);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * 문서 스탬프 검증 — 체인이 아니라 **파일 내용**이 언제부터 이 상태였는지를 본다.
 * 사전등록 계획처럼 데이터보다 먼저 고정됐음을 보여야 하는 파일에 쓴다.
 */
async function verifyDocuments(anchorDir, repoRoot, checkBitcoin, cache) {
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
  const checked = [];

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

    checked.push({ label, bitcoin, pending, state });
  }

  // 2단계: 네트워크 대조. 1단계(로컬 검사)를 전부 끝낸 뒤에만 시작한다 — 아래에서
  // 탐색기에 닿지 못하면 그 자리에서 멈추므로, 둘을 한 루프에 섞으면 뒤쪽 항목의
  // 로컬 검사가 통째로 건너뛰어진다.
  for (const { label, bitcoin, pending, state } of checked) {
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
      const block = await bitcoinMerkleRoot(height, cache);
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

async function verify(roundsPath, scoresPath, anchorDir, checkBitcoin, cache) {
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
  const checked = [];

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

    checked.push({ anchor, label, bitcoin, pending });
  }

  // 2단계: 네트워크 대조. 위의 로컬 검사가 **모든** 앵커에 대해 끝난 뒤에 시작한다.
  // 여기서 탐색기가 429를 내면 그 자리에서 멈추는데, 한 루프로 섞여 있으면 뒤쪽
  // 앵커의 payload 해시·heads 재계산이 실행되지 않은 채 종료되고, 그 상태로
  // "오프라인 검증은 이미 통과했다"고 안내하게 된다 — 사실이 아닌 안내가 된다.
  for (const { anchor, label, bitcoin, pending } of checked) {
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
      const block = await bitcoinMerkleRoot(height, cache);
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

// `--cache <path>` 의 값은 `--` 로 시작하지 않아 그냥 두면 위치 인자로 빨려 들어간다.
const cacheIndex = args.indexOf("--cache");
const cachePath = cacheIndex === -1 ? null : args[cacheIndex + 1];
if (cacheIndex !== -1 && (!cachePath || cachePath.startsWith("--"))) {
  console.error("--cache needs a path, e.g. --cache .anchor-cache/blocks.json");
  process.exit(2);
}
const positional = args.filter(
  (arg, index) => !arg.startsWith("--") && !(cacheIndex !== -1 && index === cacheIndex + 1),
);

const cache = openBlockCache(cachePath);

try {
  if (documentsOnly) {
    await verifyDocuments(positional[0] ?? "data/anchor", positional[1] ?? ".", checkBitcoin, cache);
  } else {
    await verify(
      positional[0] ?? "data/log/crypto/rounds.jsonl",
      positional[1] ?? "data/log/crypto/scores.jsonl",
      positional[2] ?? "data/anchor/crypto",
      checkBitcoin,
      cache,
    );
  }
} catch (error) {
  const kind = documentsOnly ? "document" : "anchor";
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof TransportError) {
    // 여기서 종료코드를 1과 나누는 것이 요점이다. 둘을 같은 실패로 묶으면 공개 API가
    // 바쁜 날마다 잡이 빨간불이 되고, 빨간불이 일상이 되면 진짜 머클루트 불일치가
    // 났을 때 아무도 쳐다보지 않는다. 경보는 드물어야 경보다.
    console.error(`${kind} verification INCOMPLETE: ${message}`);
    console.error("  증거가 틀렸다는 뜻이 아니라 블록 탐색기에 닿지 못했다는 뜻이다.");
    console.error("  오프라인 검증(--check-bitcoin 없이)은 영향받지 않으며 이미 통과했다.");
    process.exitCode = 2;
  } else {
    console.error(`${kind} verification FAILED: ${message}`);
    process.exitCode = 1;
  }
} finally {
  // 중간에 실패했더라도 그때까지 받아둔 블록은 남긴다. 다음 실행이 거기서부터 이어간다.
  cache?.save();
}
