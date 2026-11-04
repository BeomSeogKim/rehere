import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cropPixels } from '../evaluation/evidence/crops.mjs';

describe('evidence evaluation crops', () => {
  it('turns a fractional crop into a pixel rectangle inside the photo', () => {
    assert.deepEqual(cropPixels(1000, 800, [0.25, 0.5, 0.75, 1]), { left: 250, top: 400, width: 500, height: 400 });
  });
  it('clamps a crop that leaves the photo and keeps at least one pixel', () => {
    assert.deepEqual(cropPixels(100, 100, [-0.2, 0.9, 1.4, 1.2]), { left: 0, top: 90, width: 100, height: 10 });
    assert.deepEqual(cropPixels(100, 100, [0.5, 0.5, 0.5, 0.5]), { left: 50, top: 50, width: 1, height: 1 });
  });
});
