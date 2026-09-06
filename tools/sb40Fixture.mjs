/**
 * Regenerate `tests/fixtures/sb40-fuelModels.json` by parsing the BehavePlus
 * source that the Scott & Burgan 40 catalogue is transcribed from.
 *
 *   node tools/sb40Fixture.mjs <path-to-fuelModels.cpp> [> tests/fixtures/...]
 *
 * The fixture exists so the transcription in `src/sim/scottBurgan40.ts` is
 * checked against the *source text*, not against a hand-retyped copy of itself:
 * a test that restates my own literals repeats my own slip. `tests/scottBurgan40
 * .test.ts` asserts the TypeScript catalogue equals this file field for field.
 *
 * Fetch the input with:
 *   gh api repos/firelab/behave/contents/src/behave/fuelModels.cpp --jq .content \
 *     | base64 -d > fuelModels.cpp
 *
 * Only the 40 standard model numbers are kept (101–109, 121–124, 141–149,
 * 161–165, 181–189, 201–204); BehavePlus' non-burnable, regional (`SCAL*`) and
 * international (`V-*`, `M-*`) rows are out of scope — see the phase-10 plan.
 * Loads are emitted in the source's own **tons/acre**, with `f = 2000/43560`
 * left un-applied, so the fixture reads like the C++ and the unit conversion is
 * checked on our side rather than baked into the expectation.
 */
import { readFileSync } from 'node:fs';

const STANDARD = new Set([
  ...range(101, 109),
  ...range(121, 124),
  ...range(141, 149),
  ...range(161, 165),
  ...range(181, 189),
  ...range(201, 204),
]);

function range(lo, hi) {
  const out = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
}

/** `0.10*f` → 0.10; `8000.` → 8000; `0` → 0. Anything else is a parse failure. */
function num(token, field, number) {
  const t = token.trim().replace(/\*\s*f$/, '');
  const v = Number(t);
  if (!Number.isFinite(v)) throw new Error(`FM${number}: cannot read ${field} from "${token}"`);
  return v;
}

function bool(token, field, number) {
  const t = token.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  throw new Error(`FM${number}: cannot read ${field} from "${token}"`);
}

const src = readFileSync(process.argv[2], 'utf8');

// `setFuelModelRecord(<args>);` — the args span several lines and the name is a
// quoted string that itself contains commas, so pull the quoted fields out first
// and split what is left on commas.
const calls = [...src.matchAll(/\bsetFuelModelRecord\(([\s\S]*?)\);/g)].map((m) => m[1]);

const models = [];
for (const call of calls) {
  const strings = [...call.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  const rest = call
    .replace(/"(?:[^"\\]|\\.)*"/g, '"')
    .split(',')
    .map((s) => s.trim());
  const number = Number(rest[0]);
  if (!STANDARD.has(number)) continue;
  if (strings.length !== 2) throw new Error(`FM${number}: expected code and name, got ${strings.length} strings`);
  // rest: number, "", "", depth, deadMx, heatDead, heatLive, load1h, load10h,
  //       load100h, loadLiveHerb, loadLiveWoody, savr1h, savrLiveHerb,
  //       savrLiveWoody, isDynamic, isReserved
  if (rest.length !== 17) throw new Error(`FM${number}: expected 17 fields, got ${rest.length}`);
  models.push({
    number,
    code: strings[0],
    name: strings[1].replace(/\s+/g, ' '),
    depth: num(rest[3], 'depth', number),
    deadMx: num(rest[4], 'deadMx', number),
    heatDead: num(rest[5], 'heatDead', number),
    heatLive: num(rest[6], 'heatLive', number),
    dead1hLoadTonsPerAcre: num(rest[7], 'load1h', number),
    dead10hLoadTonsPerAcre: num(rest[8], 'load10h', number),
    dead100hLoadTonsPerAcre: num(rest[9], 'load100h', number),
    liveHerbLoadTonsPerAcre: num(rest[10], 'loadLiveHerb', number),
    liveWoodyLoadTonsPerAcre: num(rest[11], 'loadLiveWoody', number),
    dead1hSav: num(rest[12], 'savr1h', number),
    liveHerbSav: num(rest[13], 'savrLiveHerb', number),
    liveWoodySav: num(rest[14], 'savrLiveWoody', number),
    dynamic: bool(rest[15], 'isDynamic', number),
  });
}

if (models.length !== 40) throw new Error(`expected 40 standard models, parsed ${models.length}`);
models.sort((a, b) => a.number - b.number);

process.stdout.write(
  `${JSON.stringify(
    {
      source: 'firelab/behave src/behave/fuelModels.cpp',
      revision: process.env.SB40_REVISION ?? 'unknown',
      note: 'Loads are tons/acre as the source writes them (the `*f` factor 2000/43560 is NOT applied).',
      models,
    },
    null,
    2,
  )}\n`,
);
