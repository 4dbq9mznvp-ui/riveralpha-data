#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const DOMAIN = "riveralpha/record-integrity/v1";
const VERSION = 1;
// 엔진(packages/engine/src/record-integrity.ts)과 반드시 같은 목록을 유지할 것.
// 옛 버전을 빼면 그 버전으로 커밋된 보호 레코드가 검증 불가가 된다 — 추가만, 제거 금지.
//   v0.4 : executionContext 이전 payload
//   v0.5 : executionContext(호가·거래대금 스냅샷)가 보호 payload에 포함
//   v0.6 : providerReceipts(프로바이더 발급 식별자)가 보호 payload에 포함
// 목록의 순서가 곧 시간순 — 새 버전은 반드시 끝에 덧붙일 것.
const SUPPORTED_DATA_SCHEMA_VERSIONS = ["v0.4", "v0.5", "v0.6"];

/** version이 minimum 이상인가. 문자열 비교가 아니라 목록 순서로 판정한다. */
function atLeastSchema(version, minimum) {
  return (
    SUPPORTED_DATA_SCHEMA_VERSIONS.indexOf(version) >= SUPPORTED_DATA_SCHEMA_VERSIONS.indexOf(minimum)
  );
}

function fail(message) {
  throw new Error(message);
}

function readJsonl(path, label) {
  const text = readFileSync(path, "utf8").trim();
  if (!text) fail(`${label}: no records found`);
  return text.split(/\r?\n/).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`${label} line ${index + 1}: invalid JSON (${error.message})`);
    }
  });
}

function canonical(value) {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`canonical JSON: non-finite number (${String(value)})`);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === undefined) {
    fail(`canonical JSON: unsupported type ${typeof value}`);
  }
  return `{${Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

function hashPayload(value) {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function roundPayload(record) {
  // v0.4로 커밋된 레코드는 executionContext 키 없이 해싱됐다. 그 버전에 키를 끼워넣으면
  // 이미 커밋된 보호 라운드가 전부 검증 불가가 된다(append-only라 재작성 불가).
  const executionContext = atLeastSchema(record.dataSchemaVersion, "v0.5")
    ? { executionContext: record.executionContext ?? null }
    : {};
  const providerReceipts = atLeastSchema(record.dataSchemaVersion, "v0.6")
    ? { providerReceipts: record.providerReceipts ?? null }
    : {};
  return {
    ...executionContext,
    ...providerReceipts,
    v: record.v,
    dataSchemaVersion: record.dataSchemaVersion,
    roundId: record.roundId,
    assetClass: record.assetClass,
    committedAt: record.committedAt,
    methodologyVersion: record.methodologyVersion,
    horizons: record.horizons,
    universe: record.universe,
    entryPrices: record.entryPrices,
    priceSources: record.priceSources,
    failedTickers: record.failedTickers,
    missedParticipants: record.missedParticipants,
    receipt: record.receipt ?? null,
    predictionCommitment: {
      merkleRoot: record.merkleRoot,
      prevChainHash: record.prevChainHash,
      chainHash: record.chainHash,
    },
  };
}

function scorePayload(record) {
  return {
    v: record.v,
    dataSchemaVersion: record.dataSchemaVersion,
    roundId: record.roundId,
    horizon: record.horizon,
    resolvedAt: record.resolvedAt,
    targetTs: record.targetTs,
    exitPrices: record.exitPrices,
    exitSources: record.exitSources,
    realized: record.realized,
    benchmarkTicker: record.benchmarkTicker,
    benchmarkReturn: record.benchmarkReturn,
    scoring: record.scoring,
    methodologyVersion: record.methodologyVersion,
    scores: record.scores,
    predictionChainHash: record.predictionChainHash,
    roundRecordHash: record.roundRecordHash ?? null,
  };
}

function recordHash(kind, payload, prevRecordHash) {
  return hashPayload({
    domain: DOMAIN,
    kind,
    version: VERSION,
    prevRecordHash,
    payload,
  });
}

function verifyOptionalChain(kind, records, payloadFor) {
  let started = false;
  let latest = null;
  let legacy = 0;
  let protectedCount = 0;

  records.forEach((record, index) => {
    const integrity = record.recordIntegrity;
    if (!integrity) {
      if (started) fail(`${kind} record ${index}: unprotected record after integrity chain started`);
      legacy++;
      return;
    }
    if (integrity.version !== VERSION) fail(`${kind} record ${index}: unsupported integrity version`);
    if (!record.dataSchemaVersion) {
      fail(`${kind} record ${index}: missing dataSchemaVersion`);
    }
    if (!SUPPORTED_DATA_SCHEMA_VERSIONS.includes(record.dataSchemaVersion)) {
      fail(
        `${kind} record ${index}: unsupported dataSchemaVersion "${record.dataSchemaVersion}"` +
          ` (supported: ${SUPPORTED_DATA_SCHEMA_VERSIONS.join(", ")})`,
      );
    }
    const expectedPrev = started ? latest : null;
    if (integrity.prevRecordHash !== expectedPrev) {
      fail(`${kind} record ${index}: prevRecordHash mismatch or illegal restart`);
    }
    const expectedHash = recordHash(kind, payloadFor(record), expectedPrev);
    if (integrity.recordHash !== expectedHash) fail(`${kind} record ${index}: recordHash mismatch`);
    started = true;
    latest = integrity.recordHash;
    protectedCount++;
  });

  return { legacy, protectedCount, latest };
}

function verify(roundsPath, scoresPath) {
  const rounds = readJsonl(roundsPath, "rounds");
  const scores = readJsonl(scoresPath, "scores");
  const roundById = new Map();
  for (const round of rounds) {
    if (typeof round.roundId !== "string" || !round.roundId) fail("round: missing roundId");
    if (roundById.has(round.roundId)) fail(`${round.roundId}: duplicate round`);
    roundById.set(round.roundId, round);
  }

  const roundState = verifyOptionalChain("round", rounds, roundPayload);
  const scoreState = verifyOptionalChain("score", scores, scorePayload);

  for (const score of scores) {
    if (!score.recordIntegrity) continue;
    const label = `${score.roundId ?? "?"}/${score.horizon ?? "?"}`;
    const round = roundById.get(score.roundId);
    if (!round) fail(`${label}: protected score references a missing round`);
    if (score.predictionChainHash !== round.chainHash) {
      fail(`${label}: prediction chainHash reference mismatch`);
    }
    const expectedRoundRecordHash = round.recordIntegrity?.recordHash ?? null;
    if ((score.roundRecordHash ?? null) !== expectedRoundRecordHash) {
      fail(`${label}: round integrity hash reference mismatch`);
    }
  }

  if (roundState.protectedCount === 0 && scoreState.protectedCount === 0) {
    console.log(
      `record verification OK: legacy data only, rounds 0 protected/${roundState.legacy} legacy; scores 0 protected/${scoreState.legacy} legacy`,
    );
    return;
  }
  console.log(
    `record verification OK: rounds ${roundState.protectedCount} protected/${roundState.legacy} legacy; scores ${scoreState.protectedCount} protected/${scoreState.legacy} legacy; 0 mismatches`,
  );
}

try {
  verify(
    process.argv[2] ?? "data/log/crypto/rounds.jsonl",
    process.argv[3] ?? "data/log/crypto/scores.jsonl",
  );
} catch (error) {
  console.error(`record verification FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
