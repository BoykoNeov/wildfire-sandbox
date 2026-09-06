/**
 * An INDEPENDENT verbatim port of the BehavePlus no-wind / no-slope assembly —
 * `surfaceFuelbedIntermediates.cpp` + `surfaceFireReactionIntensity.cpp` at
 * `firelab/behave` revision `aa1b4a07` — written from the C++ and deliberately
 * **not** from this repo's `rothermel.ts`. It produces the reference R₀ and live
 * moisture-of-extinction literals in `tests/rothermel-twocategory.test.ts` for
 * the Scott & Burgan 40.
 *
 *   node tools/sb40ReferencePort.mjs
 *
 * Two independent ports agreeing catches a copy error; a test that restates
 * `rothermel.ts` in another form would not. Zero wind and zero slope is the only
 * regime where the BehavePlus machinery collapses to a directly comparable R₀ —
 * no 20-ft→midflame adjustment, no wind/slope vector geometry, no
 * direction-of-max search — which is why the pin lives there.
 *
 * Reads `tests/fixtures/sb40-fuelModels.json` (see `tools/sb40Fixture.mjs`), so
 * it needs no network and no local copy of the C++. Writes the literals to
 * stdout and a JSON copy beside the fixture path given below.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const MaxParticles = 4;
const MaxDead = 4;
const MaxLive = 2;
const DEAD = 0;
const LIVE = 1;

const fixture = JSON.parse(
  readFileSync(new URL('../tests/fixtures/sb40-fuelModels.json', import.meta.url), 'utf8'),
);
const F = 2000 / 43560;

/** Returns { r0, mxLive } for one model at the given moistures, calm and flat. */
function reference(m, moistDead1h, moistDead10h, moistDead100h, moistHerb, moistWoody) {
  const depth = m.depth;
  const loadDead = [
    m.dead1hLoadTonsPerAcre * F,
    m.dead10hLoadTonsPerAcre * F,
    m.dead100hLoadTonsPerAcre * F,
    0,
  ];
  const loadLive = [m.liveHerbLoadTonsPerAcre * F, m.liveWoodyLoadTonsPerAcre * F, 0, 0];
  const savrDead = [m.dead1hSav, 109, 30, m.liveHerbSav];
  const savrLive = [m.liveHerbSav, m.liveWoodySav, 0, 0];
  const moistureDead = [moistDead1h, moistDead10h, moistDead100h, moistDead1h];
  const moistureLive = [moistHerb, moistWoody, 0, 0];
  const heatDead = [m.heatDead, m.heatDead, m.heatDead, m.heatDead];
  const heatLive = [m.heatLive, m.heatLive, 0, 0];
  const densDead = [32, 32, 32, 32];
  const densLive = [32, 32, 32, 32];
  const silicaEffDead = [0.01, 0.01, 0.01, 0.01];
  const silicaEffLive = [0.01, 0.01, 0, 0];
  const totalSilica = 0.0555;

  // countSizeClasses, then dynamicLoadTransfer (before the surface-area work).
  let nDead = 0;
  for (let i = 0; i < MaxDead; i++) if (loadDead[i]) nDead++;
  let nLive = 0;
  for (let i = 0; i < MaxLive; i++) if (loadLive[i]) nLive++;
  if (nLive > 0) nLive = MaxLive;
  if (nDead > 0) nDead = MaxDead;

  if (m.dynamic) {
    if (moistureLive[0] < 0.3) {
      loadDead[3] = loadLive[0];
      loadLive[0] = 0;
    } else if (moistureLive[0] <= 1.2) {
      loadDead[3] = loadLive[0] * (1.333 - 1.11 * moistureLive[0]);
      loadLive[0] -= loadDead[3];
    }
  }
  // savr entries are non-zero even for zero-load classes in the C++ (they come
  // from the model record), and every loop there guards on savr > 1e-7 while the
  // surface-area sums run to numberOfSizeClasses_. Reproduce exactly: zero the
  // savr of classes the model does not define, so the guards behave the same.
  for (let i = 0; i < MaxParticles; i++) {
    if (loadDead[i] === 0) savrDead[i] = 0;
    if (loadLive[i] === 0) savrLive[i] = 0;
  }

  // calculateFractionOfTotalSurfaceAreaForLifeStates
  const areaDead = [0, 0, 0, 0];
  const areaLive = [0, 0, 0, 0];
  const totalArea = [0, 0];
  const fracDead = [0, 0, 0, 0];
  const fracLive = [0, 0, 0, 0];
  for (let i = 0; i < nDead; i++) {
    areaDead[i] = (loadDead[i] * savrDead[i]) / densDead[i];
    totalArea[DEAD] += areaDead[i];
  }
  for (let i = 0; i < nLive; i++) {
    areaLive[i] = (loadLive[i] * savrLive[i]) / densLive[i];
    totalArea[LIVE] += areaLive[i];
  }
  for (let i = 0; i < nDead; i++) fracDead[i] = totalArea[DEAD] > 1e-7 ? areaDead[i] / totalArea[DEAD] : 0;
  for (let i = 0; i < nLive; i++) fracLive[i] = totalArea[LIVE] > 1e-7 ? areaLive[i] / totalArea[LIVE] : 0;

  const bin = (savr) =>
    savr >= 1200 ? 0 : savr >= 192 ? 1 : savr >= 96 ? 2 : savr >= 48 ? 3 : savr >= 16 ? 4 : -1;
  const sizeSorted = (frac, savr) => {
    const summed = [0, 0, 0, 0, 0];
    for (let i = 0; i < MaxParticles; i++) {
      const b = bin(savr[i]);
      if (b >= 0) summed[b] += frac[i];
    }
    return savr.map((s) => (bin(s) >= 0 ? summed[bin(s)] : 0));
  };
  const sizeSortedDead = sizeSorted(fracDead, savrDead);
  const sizeSortedLive = sizeSorted(fracLive, savrLive);

  const fracLifeDead = totalArea[DEAD] / (totalArea[DEAD] + totalArea[LIVE]);
  const fracLife = [fracLifeDead, 1 - fracLifeDead];

  // moisture of extinction
  const mxDead = m.deadMx;
  const mx = [mxDead, 0];
  if (nLive !== 0) {
    let fineDead = 0;
    let wMoistFineDead = 0;
    for (let i = 0; i < MaxParticles; i++) {
      const w = savrDead[i] > 1e-7 ? loadDead[i] * Math.exp(-138 / savrDead[i]) : 0;
      fineDead += w;
      wMoistFineDead += w * moistureDead[i];
    }
    const fineDeadMoisture = fineDead > 1e-7 ? wMoistFineDead / fineDead : 0;
    let fineLive = 0;
    for (let i = 0; i < nLive; i++) {
      if (savrLive[i] > 1e-7) fineLive += loadLive[i] * Math.exp(-500 / savrLive[i]);
    }
    const ratio = fineLive > 1e-7 ? fineDead / fineLive : 0;
    mx[LIVE] = 2.9 * ratio * (1 - fineDeadMoisture / mxDead) - 0.226;
    if (mx[LIVE] < mxDead) mx[LIVE] = mxDead;
  }

  // calculateCharacteristicSAVR
  const wHeat = [0, 0];
  const wSilica = [0, 0];
  const wMoist = [0, 0];
  const wSavr = [0, 0];
  const wLoad = [0, 0];
  const totalLoad = [0, 0];
  for (let i = 0; i < MaxParticles; i++) {
    let wnDead = 0;
    let wnLive = 0;
    if (savrDead[i] > 1e-7) {
      wnDead = loadDead[i] * (1 - totalSilica);
      wHeat[DEAD] += fracDead[i] * heatDead[i];
      wSilica[DEAD] += fracDead[i] * silicaEffDead[i];
      wMoist[DEAD] += fracDead[i] * moistureDead[i];
      wSavr[DEAD] += fracDead[i] * savrDead[i];
      totalLoad[DEAD] += loadDead[i];
    }
    if (savrLive[i] > 1e-7) {
      wnLive = loadLive[i] * (1 - totalSilica);
      wHeat[LIVE] += fracLive[i] * heatLive[i];
      wSilica[LIVE] += fracLive[i] * silicaEffLive[i];
      wMoist[LIVE] += fracLive[i] * moistureLive[i];
      wSavr[LIVE] += fracLive[i] * savrLive[i];
      totalLoad[LIVE] += loadLive[i];
    }
    wLoad[DEAD] += sizeSortedDead[i] * wnDead;
    wLoad[LIVE] += sizeSortedLive[i] * wnLive;
  }
  const sigma = fracLife[DEAD] * wSavr[DEAD] + fracLife[LIVE] * wSavr[LIVE];

  const bulkDensity = (totalLoad[DEAD] + totalLoad[LIVE]) / depth;
  let packingRatio = 0;
  for (let i = 0; i < MaxParticles; i++) {
    packingRatio += loadDead[i] / (depth * densDead[i]);
    packingRatio += loadLive[i] / (depth * densLive[i]);
  }
  const optimumPackingRatio = 3.348 / Math.pow(sigma, 0.8189);
  const relativePackingRatio = packingRatio / optimumPackingRatio;

  // calculateHeatSink
  let heatSink = 0;
  for (let i = 0; i < MaxParticles; i++) {
    if (savrDead[i] > 1e-7) {
      heatSink += fracLife[DEAD] * fracDead[i] * (250 + 1116 * moistureDead[i]) * Math.exp(-138 / savrDead[i]);
    }
    if (savrLive[i] > 1e-7) {
      heatSink += fracLife[LIVE] * fracLive[i] * (250 + 1116 * moistureLive[i]) * Math.exp(-138 / savrLive[i]);
    }
  }
  heatSink *= bulkDensity;

  const propagatingFlux =
    sigma < 1e-7 ? 0 : Math.exp((0.792 + 0.681 * Math.sqrt(sigma)) * (packingRatio + 0.1)) / (192 + 0.2595 * sigma);

  // calculateReactionIntensity
  const aa = 133 / Math.pow(sigma, 0.7913);
  const s15 = Math.pow(sigma, 1.5);
  const gammaMax = s15 / (495 + 0.0594 * s15);
  const gamma = gammaMax * Math.pow(relativePackingRatio, aa) * Math.exp(aa * (1 - relativePackingRatio));

  const etaM = [0, 0];
  const etaS = [0, 0];
  for (let i = 0; i < 2; i++) {
    let rel = 0;
    if (mx[i] > 0) rel = wMoist[i] / mx[i];
    if (wMoist[i] >= mx[i] || rel > 1) etaM[i] = 0;
    else etaM[i] = 1 - 2.59 * rel + 5.11 * rel * rel - 3.52 * rel * rel * rel;
    const den = Math.pow(wSilica[i], 0.19);
    etaS[i] = den < 1e-6 ? 0 : Math.min(0.174 / den, 1);
  }
  const reaction =
    gamma * wLoad[DEAD] * wHeat[DEAD] * etaM[DEAD] * etaS[DEAD] +
    gamma * wLoad[LIVE] * wHeat[LIVE] * etaM[LIVE] * etaS[LIVE];

  return { r0: (reaction * propagatingFlux) / heatSink, mxLive: mx[LIVE], sigma, reaction };
}

// The test regime: dead 8 %, live 100 %, no wind, no slope, transfer following
// the catalogue flag (moistureLive_[0] = 1.0 → transfer fraction 0.223).
const rows = [];
for (const m of fixture.models) {
  const r = reference(m, 0.08, 0.08, 0.08, 1.0, 1.0);
  rows.push([m.number, m.code, r.r0, r.mxLive]);
}
writeFileSync(
  new URL('../tests/fixtures/sb40-reference-r0.json', import.meta.url),
  JSON.stringify(rows.map(([n, code, r0, mxLive]) => ({ n, code, r0, mxLive })), null, 2),
);
for (const [n, code, r0, mxLive] of rows) {
  console.log(`${code.padEnd(4)} ${n}  r0=${r0.toFixed(6).padStart(12)}  mxLive=${mxLive.toFixed(6)}`);
}
