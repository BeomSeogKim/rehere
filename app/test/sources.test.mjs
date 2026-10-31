import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canUseSource, parseSourceMetadata, unknownSource } from '../sources.mjs';

function input(overrides = {}) {
  return {
    provider: 'Neighbour',
    origin: { kind: 'public', reference: 'https://example.org/photo' },
    permissions: { place: true, model: false, share: false },
    dates: { capturedOn: '2024-02-29', fileCreatedAt: null, fileModifiedAt: '2025-03-01T10:20:30.123Z', estimatedPeriod: 'Spring 2024' },
    ...overrides,
  };
}

const parse = (metadata, counts = { photoCount: 1, hasText: false, hasVoice: false }) =>
  parseSourceMetadata(metadata === null ? null : JSON.stringify(metadata), counts);

describe('source metadata', () => {
  it('defaults absent metadata, omitted groups and null entries to unknown with no permission', () => {
    const counts = { photoCount: 2, hasText: true, hasVoice: true };
    const expected = { photos: [unknownSource(), unknownSource()], text: unknownSource(), voice: unknownSource() };
    assert.deepEqual(parse(null, counts), expected);
    assert.deepEqual(parse({}, counts), expected);
    assert.deepEqual(parse({ text: null, voice: null }, counts), expected);
    assert.deepEqual(unknownSource().permissions, { place: false, model: false, share: false });
    assert.equal(unknownSource().provider, '');
  });

  it('keeps each permission independent and normalizes blank strings', () => {
    const parsed = parse({
      photos: [input({ provider: '   ', origin: { kind: 'own', reference: ' \n' }, dates: { ...input().dates, estimatedPeriod: '\t' } })],
    });
    assert.deepEqual(parsed.photos[0].permissions, { place: true, model: false, share: false });
    assert.equal(parsed.photos[0].provider, '');
    assert.equal(parsed.photos[0].origin.reference, '');
    assert.equal(parsed.photos[0].dates.estimatedPeriod, '');
  });

  it('accepts real dates and offset timestamps as submitted', () => {
    const dates = { capturedOn: '2000-02-29', fileCreatedAt: '2024-12-31T23:59:59+09:00', fileModifiedAt: '2024-01-01T00:00:00Z', estimatedPeriod: '' };
    assert.deepEqual(parse({ photos: [input({ dates })] }).photos[0].dates, dates);
  });

  it('rejects invalid shapes, types, cardinality and absent-item metadata', () => {
    const counts = { photoCount: 1, hasText: false, hasVoice: false };
    const invalid = [
      'not json',
      '[]',
      'null',
      JSON.stringify({ photos: [input()], extra: 1 }),
      JSON.stringify({ photos: [] }),
      JSON.stringify({ photos: [input(), input()] }),
      JSON.stringify({ photos: {} }),
      JSON.stringify({ photos: [input()], text: input() }),
      JSON.stringify({ photos: [input()], voice: input() }),
      JSON.stringify({ photos: [null] }),
      JSON.stringify({ photos: [{ ...input(), extra: true }] }),
      JSON.stringify({ photos: [{ provider: 'x', origin: input().origin, permissions: input().permissions }] }),
      JSON.stringify({ photos: [input({ provider: 7 })] }),
      JSON.stringify({ photos: [input({ provider: 'x'.repeat(121) })] }),
      JSON.stringify({ photos: [input({ origin: { kind: 'stolen', reference: '' } })] }),
      JSON.stringify({ photos: [input({ origin: { kind: 'own', reference: 'x'.repeat(2001) } })] }),
      JSON.stringify({ photos: [input({ origin: { kind: 'own' } })] }),
      JSON.stringify({ photos: [input({ permissions: { place: 'true', model: false, share: false } })] }),
      JSON.stringify({ photos: [input({ permissions: { place: true, model: false } })] }),
      JSON.stringify({ photos: [input({ permissions: { place: true, model: false, share: false, print: true } })] }),
    ];
    for (const raw of invalid) assert.equal(parseSourceMetadata(raw, counts), null, raw);
  });

  it('rejects impossible calendar dates and timestamps', () => {
    const base = input().dates;
    const badDates = [
      { capturedOn: '2023-02-29' },
      { capturedOn: '2024-13-01' },
      { capturedOn: '2024-04-31' },
      { capturedOn: '2024-1-1' },
      { capturedOn: '' },
      { capturedOn: 20240101 },
      { capturedOn: '2024-01-01T00:00:00Z' },
      { fileCreatedAt: '2024-02-30T00:00:00Z' },
      { fileCreatedAt: '2024-01-01T24:00:00Z' },
      { fileCreatedAt: '2024-01-01T12:60:00Z' },
      { fileCreatedAt: '2024-01-01T12:00:60Z' },
      { fileCreatedAt: '2024-01-01T12:00:00' },
      { fileModifiedAt: '2024-01-01T12:00:00+25:00' },
      { fileModifiedAt: 1700000000000 },
      { estimatedPeriod: 'x'.repeat(161) },
      { estimatedPeriod: null },
    ];
    for (const change of badDates) {
      assert.equal(parse({ photos: [input({ dates: { ...base, ...change } })] }), null, JSON.stringify(change));
    }
  });
});

describe('canUseSource', () => {
  const draft = {
    sources: [
      { id: 'a', permissions: { place: true, model: false, share: false } },
      { id: 'b', permissions: { place: 'true', model: 1, share: true } },
    ],
  };

  it('allows only explicit true grants for known purposes', () => {
    assert.equal(canUseSource(draft, 'a', 'place'), true);
    assert.equal(canUseSource(draft, 'a', 'model'), false);
    assert.equal(canUseSource(draft, 'a', 'share'), false);
    assert.equal(canUseSource(draft, 'b', 'place'), false);
    assert.equal(canUseSource(draft, 'b', 'model'), false);
    assert.equal(canUseSource(draft, 'b', 'share'), true);
  });

  it('denies unknown sources, purposes and legacy drafts', () => {
    assert.equal(canUseSource(draft, 'missing', 'place'), false);
    assert.equal(canUseSource(draft, 'a', 'print'), false);
    assert.equal(canUseSource(draft, 'a', 'hasOwnProperty'), false);
    assert.equal(canUseSource({ photos: [], text: 'old' }, 'a', 'place'), false);
    assert.equal(canUseSource(null, 'a', 'place'), false);
  });
});
