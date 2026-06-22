import { describe, it, expect } from 'vitest';
import { MOISTURE_BYTE_MAX, byteToFraction, fractionToByte } from '../src/core/moisture';

describe('moisture byte↔fraction convention (D6)', () => {
  it('maps the endpoints: 0 = bone dry, 255 = 100%', () => {
    expect(byteToFraction(0)).toBe(0);
    expect(byteToFraction(MOISTURE_BYTE_MAX)).toBe(1);
    expect(fractionToByte(0)).toBe(0);
    expect(fractionToByte(1)).toBe(MOISTURE_BYTE_MAX);
  });

  it('is linear (byte 128 ≈ 50%)', () => {
    expect(byteToFraction(128)).toBeCloseTo(128 / 255, 12);
    // round(0.5 * 255) = round(127.5) = 128
    expect(fractionToByte(0.5)).toBe(128);
  });

  it('round-trips every byte exactly', () => {
    for (let b = 0; b <= MOISTURE_BYTE_MAX; b++) {
      expect(fractionToByte(byteToFraction(b))).toBe(b);
    }
  });

  it('clamps out-of-range fractions instead of overflowing the byte', () => {
    expect(fractionToByte(-0.5)).toBe(0);
    expect(fractionToByte(2)).toBe(MOISTURE_BYTE_MAX);
    expect(fractionToByte(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(fractionToByte(Number.POSITIVE_INFINITY)).toBe(MOISTURE_BYTE_MAX);
  });

  it('lands the generator band (bytes 20..100) in a realistic dead-fuel range', () => {
    // terrain.ts writes 20..100 for burnable cells; under linear encoding that
    // is ~7.8%..39%, straddling typical moisture of extinction (0.12..0.40).
    expect(byteToFraction(20)).toBeCloseTo(0.078, 3);
    expect(byteToFraction(100)).toBeCloseTo(0.392, 3);
  });
});
