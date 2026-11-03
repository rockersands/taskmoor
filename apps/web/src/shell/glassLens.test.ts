import { afterEach, describe, expect, it } from 'vitest';
import { lensAvailable, rimDisplacement, startGlassLens } from './glassLens';

describe('the glass lens (ADR-114)', () => {
  it('bends nothing in the middle of a slab and most at its rim, into the slab', () => {
    expect(rimDisplacement(200, 100, 400, 200, 24, 18)).toEqual([0, 0]);
    const [leftX, leftY] = rimDisplacement(0.5, 100, 400, 200, 24, 18);
    expect(leftX).toBeGreaterThan(0.9);
    expect(Math.abs(leftY)).toBeLessThan(1e-9);
    const [rightX] = rimDisplacement(399.5, 100, 400, 200, 24, 18);
    expect(rightX).toBeLessThan(-0.9);
    const [, bottomY] = rimDisplacement(200, 199.5, 400, 200, 24, 18);
    expect(bottomY).toBeLessThan(-0.9);
  });

  it('follows the curve at a rounded corner', () => {
    const [x, y] = rimDisplacement(8, 8, 400, 200, 24, 18);
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(0);
    expect(x).toBeCloseTo(y, 5);
    // Outside the bending band there is none, even near a corner.
    expect(rimDisplacement(40, 40, 400, 200, 24, 10)).toEqual([0, 0]);
  });

  const chromium = [{ brand: 'Chromium' }];
  const none = () => false;
  const yes = () => true;

  it('[NFR-005] runs only in Chromium, where a backdrop can carry the filter', () => {
    expect(lensAvailable(chromium, none, yes)).toBe(true);
    expect(lensAvailable(undefined, none, yes)).toBe(false);
    expect(lensAvailable([{ brand: 'Firefox' }], none, yes)).toBe(false);
    expect(lensAvailable(chromium, none, none)).toBe(false);
  });

  it('[NFR-005] stays off when a person asked for less transparency or forced colours', () => {
    const asks = (wanted: string) => (query: string) => query.includes(wanted);
    expect(lensAvailable(chromium, asks('reduced-transparency'), yes)).toBe(false);
    expect(lensAvailable(chromium, asks('forced-colors'), yes)).toBe(false);
  });

  describe('where it is unavailable', () => {
    afterEach(() => {
      document.body.innerHTML = '';
    });

    it('leaves surfaces on their blur and sheen', () => {
      document.body.innerHTML = '<header class="shell-topbar"></header>';
      const stop = startGlassLens();
      const bar = document.querySelector<HTMLElement>('.shell-topbar');
      expect(bar?.style.getPropertyValue('--glass-lens')).toBe('');
      expect(document.querySelector('svg filter')).toBeNull();
      stop();
    });
  });
});
