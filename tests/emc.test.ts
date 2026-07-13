import { describe, it, expect } from 'vitest';
import {
  celsiusToFahrenheit,
  equilibriumMoisturePercent,
  equilibriumMoistureFraction,
} from '../src/sim/emc';

/**
 * Pins the Simard (1968) EMC regression verbatim. The vectors are hand-worked from
 * the published three-branch form so a future refactor of `emc.ts` cannot silently
 * drift the coefficients (the same guard the Rothermel primitives get).
 */
describe('Simard 1968 equilibrium moisture content', () => {
  it('low-humidity branch (H < 10)', () => {
    // 0.03229 + 0.281073·5 − 0.000578·5·70
    expect(equilibriumMoisturePercent(5, 70)).toBeCloseTo(1.235355, 5);
  });

  it('mid-humidity branch (10 ≤ H ≤ 50)', () => {
    // 2.22749 + 0.160107·40 − 0.014784·70
    expect(equilibriumMoisturePercent(40, 70)).toBeCloseTo(7.59689, 5);
  });

  it('high-humidity branch (H > 50)', () => {
    // 21.0606 + 0.005565·80² − 0.00035·80·70 − 0.483199·80
    expect(equilibriumMoisturePercent(80, 70)).toBeCloseTo(16.06068, 5);
  });

  it('H = 10 takes the mid branch (strict < 10 boundary)', () => {
    // 2.22749 + 0.160107·10 − 0.014784·70
    expect(equilibriumMoisturePercent(10, 70)).toBeCloseTo(2.79368, 5);
  });

  it('EMC rises with humidity and falls with temperature', () => {
    expect(equilibriumMoisturePercent(60, 70)).toBeGreaterThan(equilibriumMoisturePercent(30, 70));
    expect(equilibriumMoisturePercent(40, 90)).toBeLessThan(equilibriumMoisturePercent(40, 50));
  });
});

describe('metric fraction wrapper', () => {
  it('converts °C→°F correctly', () => {
    expect(celsiusToFahrenheit(0)).toBeCloseTo(32, 10);
    expect(celsiusToFahrenheit(25)).toBeCloseTo(77, 10);
    expect(celsiusToFahrenheit(100)).toBeCloseTo(212, 10);
  });

  it('returns the percent form / 100 as a fraction', () => {
    // 25 °C = 77 °F, H=40 → (2.22749 + 6.40428 − 1.138368) / 100
    expect(equilibriumMoistureFraction(40, 25)).toBeCloseTo(0.07493402, 7);
  });

  it('clamps into [0, 1]', () => {
    const f = equilibriumMoistureFraction(0, 60);
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThanOrEqual(1);
  });
});
