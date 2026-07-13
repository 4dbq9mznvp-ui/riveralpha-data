#!/usr/bin/env node
import { readFileSync } from "node:fs";

const TOLERANCE = 1e-12;

function fail(message) {
  throw new Error(message);
}

function readJsonl(path, label) {
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

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${label}: expected a finite number`);
  }
  return value;
}

function positive(value, label) {
  const number = finite(value, label);
  if (number <= 0) fail(`${label}: expected a positive number`);
  return number;
}

function close(actual, expected, label) {
  finite(actual, `${label} (recorded)`);
  finite(expected, `${label} (recomputed)`);
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
  if (Math.abs(actual - expected) > TOLERANCE * scale) {
    fail(`${label}: recorded=${actual}, recomputed=${expected}`);
  }
}

function sameKeys(actual, expected, label) {
  const a = Object.keys(actual).sort();
  const b = Object.keys(expected).sort();
  if (a.length !== b.length || a.some((key, index) => key !== b[index])) {
    fail(`${label}: key set mismatch (recorded=${a.join(",")}, recomputed=${b.join(",")})`);
  }
}

function averageRanks(values) {
  const order = values.map((value, index) => [value, index]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k][1]] = rank;
    i = j + 1;
  }
  return ranks;
}

function pearson(a, b) {
  const n = a.length;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= n;
  meanB /= n;
  let numerator = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    numerator += da * db;
    varianceA += da * da;
    varianceB += db * db;
  }
  const denominator = Math.sqrt(varianceA * varianceB);
  return denominator === 0 ? 0 : numerator / denominator;
}

function spearman(signal, realized, label) {
  const symbols = Object.keys(signal).filter((symbol) => symbol in realized).sort();
  if (symbols.length < 2) fail(`${label}: fewer than two overlapping assets`);
  const predicted = symbols.map((symbol) => finite(signal[symbol], `${label} signal.${symbol}`));
  const outcomes = symbols.map((symbol) => finite(realized[symbol], `${label} realized.${symbol}`));
  return pearson(averageRanks(predicted), averageRanks(outcomes));
}

function topK(signal, realized, k, costBps, label) {
  const eligible = Object.keys(signal).filter((symbol) => symbol in realized);
  if (eligible.length === 0) fail(`${label}: no overlapping assets`);
  const picked = eligible
    .sort((a, b) => {
      const difference = finite(signal[b], `${label} signal.${b}`) - finite(signal[a], `${label} signal.${a}`);
      return difference !== 0 ? difference : a < b ? -1 : a > b ? 1 : 0;
    })
    .slice(0, Math.min(k, eligible.length));
  const gross = picked.reduce(
    (sum, symbol) => sum + finite(realized[symbol], `${label} realized.${symbol}`) / picked.length,
    0,
  );
  return gross - costBps / 10_000;
}

function verify(roundsPath, scoresPath) {
  const rounds = readJsonl(roundsPath, "rounds");
  const scoreRecords = readJsonl(scoresPath, "scores");
  if (rounds.length === 0) fail("rounds: no records found");
  if (scoreRecords.length === 0) fail("scores: no records found");
  const roundById = new Map();

  for (const round of rounds) {
    if (typeof round.roundId !== "string" || !round.roundId) fail("round: missing roundId");
    if (roundById.has(round.roundId)) fail(`${round.roundId}: duplicate round`);
    if (!Array.isArray(round.predictions)) fail(`${round.roundId}: predictions must be an array`);
    const participants = new Set();
    for (const prediction of round.predictions) {
      if (typeof prediction.participantId !== "string" || !prediction.participantId) {
        fail(`${round.roundId}: prediction missing participantId`);
      }
      if (participants.has(prediction.participantId)) {
        fail(`${round.roundId}: duplicate prediction participant ${prediction.participantId}`);
      }
      participants.add(prediction.participantId);
      if (!prediction.signal || typeof prediction.signal !== "object") {
        fail(`${round.roundId}/${prediction.participantId}: missing signal`);
      }
      for (const [symbol, value] of Object.entries(prediction.signal)) {
        finite(value, `${round.roundId}/${prediction.participantId} signal.${symbol}`);
      }
    }
    roundById.set(round.roundId, round);
  }

  const seenScores = new Set();
  let participantScores = 0;
  for (const record of scoreRecords) {
    const label = `${record.roundId ?? "?"}/${record.horizon ?? "?"}`;
    const round = roundById.get(record.roundId);
    if (!round) fail(`${label}: round not found`);
    const key = `${record.roundId}|${record.horizon}`;
    if (seenScores.has(key)) fail(`${label}: duplicate score record`);
    seenScores.add(key);
    if (!Array.isArray(round.horizons) || !round.horizons.includes(record.horizon)) {
      fail(`${label}: horizon not declared by round`);
    }
    if (record.methodologyVersion !== round.methodologyVersion) {
      fail(`${label}: methodology mismatch`);
    }
    if (!record.scoring || !Number.isInteger(record.scoring.k) || record.scoring.k <= 0) {
      fail(`${label}: invalid scoring.k`);
    }
    const costBps = finite(record.scoring.costBps, `${label} scoring.costBps`);
    if (costBps < 0) fail(`${label}: scoring.costBps must be non-negative`);
    if (typeof record.scoring.benchmark !== "string" || !record.scoring.benchmark) {
      fail(`${label}: invalid scoring.benchmark`);
    }
    if (record.benchmarkTicker !== record.scoring.benchmark) {
      fail(`${label}: benchmarkTicker does not match scoring.benchmark`);
    }
    if (!record.exitPrices || typeof record.exitPrices !== "object") fail(`${label}: missing exitPrices`);
    if (!record.realized || typeof record.realized !== "object") fail(`${label}: missing realized`);
    if (!round.entryPrices || typeof round.entryPrices !== "object") fail(`${label}: round missing entryPrices`);

    const recomputedRealized = {};
    for (const [symbol, exit] of Object.entries(record.exitPrices)) {
      const exitPrice = positive(exit, `${label} exitPrices.${symbol}`);
      if (!(symbol in round.entryPrices)) fail(`${label}: exit price has no matching entry price (${symbol})`);
      const entryPrice = positive(round.entryPrices[symbol], `${label} entryPrices.${symbol}`);
      recomputedRealized[symbol] = exitPrice / entryPrice - 1;
    }
    sameKeys(record.realized, recomputedRealized, `${label} realized`);
    for (const [symbol, value] of Object.entries(recomputedRealized)) {
      close(record.realized[symbol], value, `${label} realized.${symbol}`);
    }
    const benchmark = record.scoring.benchmark;
    if (!(benchmark in recomputedRealized)) fail(`${label}: benchmark return cannot be recomputed`);
    close(record.benchmarkReturn, recomputedRealized[benchmark], `${label} benchmarkReturn`);

    if (!Array.isArray(record.scores)) fail(`${label}: scores must be an array`);
    const expected = new Map(round.predictions.map((prediction) => [prediction.participantId, prediction]));
    const actual = new Set();
    for (const score of record.scores) {
      if (typeof score.participantId !== "string" || !score.participantId) {
        fail(`${label}: score missing participantId`);
      }
      if (actual.has(score.participantId)) fail(`${label}: duplicate score participant ${score.participantId}`);
      actual.add(score.participantId);
      const prediction = expected.get(score.participantId);
      if (!prediction) fail(`${label}: unexpected score participant ${score.participantId}`);
      const scoreLabel = `${label}/${score.participantId}`;
      const ic = spearman(prediction.signal, recomputedRealized, scoreLabel);
      const portfolioReturn = topK(
        prediction.signal,
        recomputedRealized,
        record.scoring.k,
        costBps,
        scoreLabel,
      );
      close(score.ic, ic, `${scoreLabel} ic`);
      close(score.portfolioReturn, portfolioReturn, `${scoreLabel} portfolioReturn`);
      close(score.alpha, portfolioReturn - recomputedRealized[benchmark], `${scoreLabel} alpha`);
      participantScores++;
    }
    for (const participantId of expected.keys()) {
      if (!actual.has(participantId)) fail(`${label}: missing score participant ${participantId}`);
    }
  }

  console.log(
    `score verification OK: ${scoreRecords.length} score record(s), ${participantScores} participant score(s), 0 mismatches`,
  );
}

try {
  verify(
    process.argv[2] ?? "data/log/crypto/rounds.jsonl",
    process.argv[3] ?? "data/log/crypto/scores.jsonl",
  );
} catch (error) {
  console.error(`score verification FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
