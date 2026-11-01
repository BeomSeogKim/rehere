import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeArrangement } from '../public/arrangement.js';
import { compositionDifference, describeComposition } from '../public/composition-description.js';
import { quaternionFromEuler } from '../public/composition-scene.js';

const A = 'A: Armchair';
const B = 'B: Lamp';
const nameOf = (id) => (id === 'object-1' ? A : id === 'object-2' ? B : 'an object');
const yaw = (degrees) => quaternionFromEuler([0, (degrees * Math.PI) / 180, 0]);
const pose = (position, quaternion = [0, 0, 0, 1], scale = 1) => ({ position, quaternion, scale });
const arrangement = (first, second, relationship = null) => ({
  frame: 'owner-composition',
  objects: [{ id: 'object-1', ...first }, { id: 'object-2', ...second }],
  relationship,
});
const deepFreeze = (value) => {
  if (value && typeof value === 'object') Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};
const entry = (before, after, id) => compositionDifference(before, after, nameOf).find((item) => item.objectId === id).text;
const describe1 = (first, second) => describeComposition(arrangement(first, second), nameOf);

// Side-by-side objects facing each other along the owner X axis.
const facing = arrangement(pose([-1, 0, 0], yaw(90)), pose([1, 0, 0], yaw(-90)));

function assertPlainLanguage(text) {
  assert.doesNotMatch(text, /\bwas\b|\bwere\b|metre|meter|\bcm\b|\b1[0-9]{3}\b|\b20[0-9]{2}\b|quaternion|vector|\[|\]/i);
}

describe('describeComposition', () => {
  it('states fixed-axis relations and the layout assumption once', () => {
    const text = describe1(pose([-1, -0.5, -0.5]), pose([1, 0.5, 0.5]));
    assert.match(text, /^In the owner's assumed layout, not the viewing camera, A: Armchair is left of B: Lamp, below it, and behind it\./);
    assert.equal(text.match(/assumed layout/g).length, 1);
    assertPlainLanguage(text);
    assert.doesNotMatch(text, /\d/);
  });

  it('keeps left/right, above/below and front/behind independent of orientation', () => {
    const cases = [
      [[1, 0, 0], /right of B: Lamp/], [[-1, 0, 0], /left of B: Lamp/],
      [[0, 1, 0], /above B: Lamp/], [[0, -1, 0], /below B: Lamp/],
      [[0, 0, 1], /in front of B: Lamp/], [[0, 0, -1], /behind B: Lamp/],
    ];
    for (const quaternion of [[0, 0, 0, 1], yaw(137), quaternionFromEuler([0.4, 1.1, -0.7])]) {
      for (const [offset, expected] of cases) {
        assert.match(describe1(pose(offset, quaternion), pose([0, 0, 0], yaw(20))), expected);
      }
    }
  });

  it('separates exact no offset from a slight offset and a clear one', () => {
    assert.match(describe1(pose([-1, 0, 0]), pose([0, 0, 0])), /left of B: Lamp, with no up\/down or front\/back offset\./);
    const slight = describe1(pose([0.01, 0, 0]), pose([0, 0, 0]));
    assert.match(slight, /slightly right of B: Lamp, with no up\/down or front\/back offset/);
    assert.doesNotMatch(slight, /uncertain|unknown|roughly|about/);
    assert.match(describe1(pose([-1, 0.01, 0]), pose([0, 0, 0])), /left of B: Lamp and slightly above it, with no front\/back offset/);
    assert.doesNotMatch(describe1(pose([1, 1, 1]), pose([0, 0, 0])), /no .* offset/);
  });

  it('describes where each photographed side points', () => {
    const at = (degrees) => describe1(pose([-1, 0, 0], yaw(degrees)), pose([1, 0, 0], yaw(-90)));
    assert.match(at(90), /A: Armchair's photographed side points toward B: Lamp/);
    assert.match(at(45), /A: Armchair's photographed side points partly toward B: Lamp/);
    assert.match(at(0), /A: Armchair's photographed side points to the side of B: Lamp/);
    assert.match(at(-90), /A: Armchair's photographed side points away from B: Lamp/);
    assert.match(at(90), /B: Lamp's photographed side points toward A: Armchair/);
    assert.doesNotMatch(at(90), /semantic|true front|natural front/);
  });

  it('leaves pointing undefined only at exactly coincident centres', () => {
    const coincident = describe1(pose([0.3, 0.2, 0.1]), pose([0.3, 0.2, 0.1]));
    assert.match(coincident, /are at the same position/);
    assert.match(coincident, /undefined/);
    assert.doesNotMatch(coincident, /points (toward|away|partly|to the side)/);

    const near = describe1(pose([0.01, 0, 0], yaw(90)), pose([0, 0, 0], yaw(-90)));
    assert.match(near, /At nearly coincident centres, A: Armchair's photographed side approximately points away from B: Lamp/);
    assert.doesNotMatch(near, /undefined/);
  });

  it('compares the two relative-size settings, never which object is bigger', () => {
    const bigger = describe1(pose([0, 0, 1], undefined, 1.5), pose([0, 0, 0]));
    assert.match(bigger, /A: Armchair has a larger assumed relative-size setting than B: Lamp; the settings do not show which object is bigger\./);
    assert.match(describe1(pose([0, 0, 1], undefined, 1), pose([0, 0, 0], undefined, 1.02)), /has a slightly smaller assumed relative-size setting/);
    assert.match(describe1(pose([0, 0, 1], undefined, 3), pose([0, 0, 0])), /has a much larger assumed relative-size setting/);
    assert.match(describe1(pose([0, 0, 1], undefined, 2), pose([0, 0, 0], undefined, 2)), /have the same assumed relative-size setting; the settings do not show whether the objects match in size/);
    // Different source meshes have unrelated native extents, so a larger setting is no size ordering.
    for (const text of [bigger, describe1(pose([0, 0, 1], undefined, 0.5), pose([0, 0, 0], undefined, 4))]) {
      assert.doesNotMatch(text, /relative size than|physically|actual size/);
      assert.doesNotMatch(text.replace(/the settings do not show which object is bigger/, ''), /\bbigger\b/);
    }
  });

  it('stays free of coordinates, measurements and historical claims', () => {
    for (const first of [pose([2.5, -3.25, 0.125], yaw(33), 0.75), pose([0, 0, 0]), pose([0.01, 0, 0])]) {
      const text = describe1(first, pose([0, 0, 0], yaw(-10), 1.25));
      assertPlainLanguage(text);
      assert.doesNotMatch(text, /\d/);
    }
  });

  it('gives a name fallback when the name lookup is unusable', () => {
    for (const lookup of [() => { throw new Error('no name'); }, () => '', () => 42, undefined]) {
      const text = describeComposition(facing, lookup);
      assert.match(text, /the first object is left of the second object/);
    }
  });

  it('reads objects by id, not array position', () => {
    const swapped = { ...facing, objects: [...facing.objects].reverse() };
    assert.equal(describeComposition(swapped, nameOf), describeComposition(facing, nameOf));
  });

  it('does not mutate its input', () => {
    const frozen = deepFreeze(structuredClone(facing));
    assert.doesNotThrow(() => describeComposition(frozen, nameOf));
  });
});

describe('unreadable arrangements', () => {
  const good = () => structuredClone(facing);
  const mutate = (change) => { const value = good(); change(value); return value; };
  const broken = {
    missing: undefined,
    null: null,
    empty: {},
    legacy: { objects: [{ id: 'object-1', offset: [0, 0, 0], yaw: 0 }, { id: 'object-2', offset: [1, 0, 0], yaw: 0 }] },
    'one object': mutate((value) => value.objects.pop()),
    'three objects': mutate((value) => value.objects.push({ id: 'object-3', ...pose([0, 0, 0]) })),
    'duplicate id': mutate((value) => { value.objects[1].id = 'object-1'; }),
    'wrong id': mutate((value) => { value.objects[1].id = 'other'; }),
    'not an array': mutate((value) => { value.objects = 'objects'; }),
    'nan position': mutate((value) => { value.objects[0].position[0] = Number.NaN; }),
    'infinite position': mutate((value) => { value.objects[0].position[1] = Infinity; }),
    'short position': mutate((value) => { value.objects[0].position = [0, 0]; }),
    'sparse position': mutate((value) => { value.objects[0].position = [1, , 3]; }),
    'string position': mutate((value) => { value.objects[0].position = ['1', '0', '0']; }),
    'distant position': mutate((value) => { value.objects[0].position = [11, 0, 0]; }),
    'non-unit quaternion': mutate((value) => { value.objects[0].quaternion = [0, 0, 0, 2]; }),
    'zero quaternion': mutate((value) => { value.objects[0].quaternion = [0, 0, 0, 0]; }),
    'missing quaternion': mutate((value) => { delete value.objects[0].quaternion; }),
    'zero scale': mutate((value) => { value.objects[0].scale = 0; }),
    'huge scale': mutate((value) => { value.objects[0].scale = 6; }),
    'nan scale': mutate((value) => { value.objects[0].scale = Number.NaN; }),
  };

  for (const [label, value] of Object.entries(broken)) {
    it(`says the relation is unavailable for ${label}`, () => {
      const text = describeComposition(value, nameOf);
      assert.match(text, /^The relationship between A: Armchair and B: Lamp is unavailable: /);
      assert.doesNotMatch(text, /left of|right of|above|below|behind|in front of|points|larger|smaller|same|unchanged/);
      for (const [before, after] of [[value, good()], [good(), value], [value, value]]) {
        const lines = compositionDifference(before, after, nameOf);
        assert.deepEqual(lines.map((line) => line.objectId), ['object-1', 'object-2']);
        for (const line of lines) {
          assert.match(line.text, /cannot be described/);
          assert.doesNotMatch(line.text, /It is (now|still)|Its position relative|photographed side now/);
          if (line.text.includes('a change for')) assert.doesNotMatch(line.text, /unchanged|moved/);
        }
      }
    });
  }

  it('keeps independent facts when only the other object is unreadable', () => {
    const before = arrangement(pose([-1, 0, 0], yaw(0)), pose([1, 0, 0]));
    const after = arrangement(pose([-1, 0, 0], yaw(90)), { id: 'object-2', position: [Number.NaN, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 });
    after.objects[1] = { ...after.objects[1] };
    const [first, second] = compositionDifference(before, after, nameOf);
    assert.match(first.text, /Its relationship to B: Lamp cannot be described/);
    assert.match(first.text, /Its orientation changed by about 90° overall\./);
    assert.match(first.text, /A: Armchair's saved position and assumed relative size are unchanged\./);
    assert.match(second.text, /a change for B: Lamp cannot be described/);
  });
});

describe('compositionDifference', () => {
  it('reports exact unchanged values as unchanged, in fixed order', () => {
    const lines = compositionDifference(facing, structuredClone(facing), nameOf);
    assert.deepEqual(lines.map((line) => line.objectId), ['object-1', 'object-2']);
    assert.equal(lines[0].text, "In the owner's assumed layout, A: Armchair's saved position, orientation, and assumed relative size are unchanged.");
    assert.equal(lines[1].text, "In the owner's assumed layout, B: Lamp's saved position, orientation, and assumed relative size are unchanged.");
    const swapped = { ...facing, objects: [...facing.objects].reverse() };
    assert.deepEqual(compositionDifference(swapped, facing, nameOf), lines);
  });

  it('carries the layout assumption once in every independent entry', () => {
    const after = arrangement(pose([-3, 1, 0], yaw(10), 2), pose([1, 0, 0], yaw(-90)));
    for (const line of compositionDifference(facing, after, nameOf)) {
      assert.equal(line.text.match(/assumed layout/g).length, 1);
      assert.match(line.text, /^In the owner's assumed layout, /);
      assertPlainLanguage(line.text);
    }
  });

  it('still describes a move that keeps the axis ordering', () => {
    const after = arrangement(pose([-2, 0, 0], yaw(90)), pose([1, 0, 0], yaw(-90)));
    const first = entry(facing, after, 'object-1');
    assert.match(first, /A: Armchair moved left\. It is still left of B: Lamp\./);
    assert.doesNotMatch(first, /rather than/);
    const second = entry(facing, after, 'object-2');
    assert.match(second, /B: Lamp's saved position, orientation, and assumed relative size are unchanged\. It is still right of A: Armchair\./);
  });

  it('reports a reversed axis ordering for both objects', () => {
    const after = arrangement(pose([2, 0, 0], yaw(90)), pose([1, 0, 0], yaw(-90)));
    assert.match(entry(facing, after, 'object-1'), /A: Armchair moved right\. It is now right of B: Lamp \(rather than left of B: Lamp\)\./);
    assert.match(entry(facing, after, 'object-2'), /It is now left of A: Armchair \(rather than right of A: Armchair\)\./);
  });

  it('names the axis that changed when an offset becomes none', () => {
    const after = arrangement(pose([-1, 1, 0], yaw(90)), pose([1, 1, 0], yaw(-90)));
    const text = entry(facing, after, 'object-1');
    assert.match(text, /moved up\. Its position relative to B: Lamp is unchanged\./);
    const level = arrangement(pose([-1, 1, 0], yaw(90)), pose([1, 0, 0], yaw(-90)));
    assert.match(entry(arrangement(pose([-1, 0, 0], yaw(90)), pose([1, 0, 0], yaw(-90))), level, 'object-1'), /It is now above B: Lamp \(rather than at the same height as B: Lamp\)/);
  });

  it('does not call two translating objects unchanged', () => {
    const after = arrangement(pose([-0.5, 0, 0], yaw(90)), pose([1.5, 0, 0], yaw(-90)));
    for (const id of ['object-1', 'object-2']) {
      const text = entry(facing, after, id);
      assert.match(text, /moved right\. Its position relative to .* is unchanged\./);
      assert.doesNotMatch(text, /saved position/);
    }
  });

  it('keeps a nonzero difference visible instead of rounding it away', () => {
    const tiny = 1e-12;
    const moved = arrangement(pose([-1 + tiny, 0, 0], yaw(90)), pose([1, 0, 0], yaw(-90)));
    const position = entry(facing, moved, 'object-1');
    assert.match(position, /A: Armchair moved slightly right\. It is still left of B: Lamp\./);
    assert.doesNotMatch(position, /saved position/);

    const turned = arrangement(pose([-1, 0, 0], [tiny, 0, 0, 1]), pose([1, 0, 0]));
    const base = arrangement(pose([-1, 0, 0]), pose([1, 0, 0]));
    assert.match(entry(base, turned, 'object-1'), /Its orientation changed slightly\./);
    assert.doesNotMatch(entry(base, turned, 'object-1'), /orientation[^.]*unchanged/);

    const resized = arrangement(pose([-1, 0, 0], undefined, 1 + tiny), pose([1, 0, 0]));
    assert.match(entry(base, resized, 'object-1'), /Its assumed relative size is now slightly larger\./);
  });

  it('keeps a small axis visible beside a clear one in the same move', () => {
    const tiny = 1e-12;
    const after = arrangement(pose([-1 + tiny, 1, 0], yaw(90)), pose([1, 0, 0], yaw(-90)));
    const first = entry(facing, after, 'object-1');
    assert.match(first, /A: Armchair moved up and slightly right\./);
    assert.match(first, /It is now above B: Lamp \(rather than at the same height as B: Lamp\), and still left of it\./);
    assert.match(entry(facing, after, 'object-2'), /B: Lamp's saved position, orientation, and assumed relative size are unchanged\. It is now below A: Armchair \(rather than at the same height as A: Armchair\), and still right of it\./);

    const three = arrangement(pose([-0.5, 0.01, tiny], yaw(90)), pose([1, 0, 0], yaw(-90)));
    assert.match(entry(facing, three, 'object-1'), /A: Armchair moved right, slightly up, and slightly toward the front\./);
    const smallThenClear = arrangement(pose([-1 - 0.01, 0, 2], yaw(90)), pose([1, 0, 0], yaw(-90)));
    assert.match(entry(facing, smallThenClear, 'object-1'), /A: Armchair moved toward the front and slightly left\. It is now in front of B: Lamp \(rather than at the same front\/back position as B: Lamp\), and still left of it\./);
  });

  it('keeps both a slight vertical move and the other object\'s vertical relation when another axis crosses a tier', () => {
    const before = arrangement(pose([-0.01, 1, 0]), pose([0, 0, 0]));
    const after = arrangement(pose([0.1, 1.00001, 0]), pose([0, 0, 0]));
    assert.match(entry(before, after, 'object-1'), /A: Armchair moved right and slightly up\. It is now right of B: Lamp \(rather than slightly left of B: Lamp\), and still above it\./);
    assert.match(entry(before, after, 'object-2'), /B: Lamp's saved position, orientation, and assumed relative size are unchanged\. It is now left of A: Armchair \(rather than slightly right of A: Armchair\), and still below it\./);
  });

  it('treats opposite quaternion signs as the same orientation', () => {
    const flipped = structuredClone(facing);
    flipped.objects[0].quaternion = flipped.objects[0].quaternion.map((n) => -n);
    assert.match(entry(facing, flipped, 'object-1'), /position, orientation, and assumed relative size are unchanged/);
    const turned = structuredClone(flipped);
    turned.objects[0].quaternion = yaw(-90).map((n) => -n);
    assert.match(entry(facing, turned, 'object-1'), /orientation changed by about 180° overall/);
  });

  it('describes the whole orientation change with bounded degrees', () => {
    const from = arrangement(pose([-1, 0, 0]), pose([1, 0, 0]));
    const to = (quaternion) => arrangement(pose([-1, 0, 0], quaternion), pose([1, 0, 0]));
    assert.match(entry(from, to(yaw(90)), 'object-1'), /changed by about 90° overall/);
    assert.match(entry(from, to(yaw(30)), 'object-1'), /changed by about 30° overall/);
    assert.match(entry(from, to(yaw(2)), 'object-1'), /Its orientation changed slightly\./);
    assert.match(entry(from, to(yaw(180)), 'object-1'), /changed by about 180° overall/);

    const mixed = quaternionFromEuler([0.5, 0.4, 0.3]);
    const expected = (2 * Math.acos(Math.abs(mixed[3])) * 180) / Math.PI;
    const text = entry(from, to(mixed), 'object-1');
    const reported = Number(text.match(/about (\d+)°/)[1]);
    assert.ok(Math.abs(reported - expected) <= 2.5, `${reported} vs ${expected}`);
    assert.doesNotMatch(text, /vertical|upright|turned|yaw|axis/i);
  });

  it('reports a change of which way the photographed side points', () => {
    const after = arrangement(pose([-1, 0, 0], yaw(-90)), pose([1, 0, 0], yaw(-90)));
    assert.match(entry(facing, after, 'object-1'), /Its photographed side now points away from B: Lamp rather than toward B: Lamp\./);
    assert.match(entry(facing, after, 'object-1'), /orientation changed by about 180° overall/);
    assert.doesNotMatch(entry(facing, after, 'object-2'), /photographed side now/);
  });

  it('keeps pointing honest when centres begin or stop coinciding', () => {
    const joined = arrangement(pose([0, 0, 0], yaw(90)), pose([0, 0, 0], yaw(-90)));
    assert.match(entry(facing, joined, 'object-1'), /Because the centres now coincide, its photographed side has no defined direction relative to B: Lamp rather than pointing toward B: Lamp\./);
    assert.match(entry(joined, facing, 'object-1'), /now points toward B: Lamp; before, the coincident centres left its direction undefined\./);
  });

  it('describes assumed relative size changes per object', () => {
    const scaled = (value) => arrangement(pose([-1, 0, 0], yaw(90), value), pose([1, 0, 0], yaw(-90)));
    assert.match(entry(facing, scaled(1.5), 'object-1'), /Its assumed relative size is now larger\./);
    assert.match(entry(facing, scaled(0.7), 'object-1'), /Its assumed relative size is now smaller\./);
    assert.match(entry(facing, scaled(1.02), 'object-1'), /now slightly larger\./);
    assert.match(entry(facing, scaled(3), 'object-1'), /now much larger\./);
    assert.match(entry(facing, scaled(0.5), 'object-1'), /now much smaller\./);
    assert.doesNotMatch(entry(facing, scaled(1.5), 'object-2'), /relative size is now/);
    assert.doesNotMatch(entry(facing, scaled(1.5), 'object-1'), /physical|real size/i);
  });

  it('does not mutate its inputs', () => {
    const before = deepFreeze(structuredClone(facing));
    const after = deepFreeze(arrangement(pose([-2, 1, 0], yaw(10), 2), pose([1, 0, 0])));
    assert.doesNotThrow(() => compositionDifference(before, after, nameOf));
  });
});

describe('describeArrangement', () => {
  it('keeps the legacy wording byte for byte', () => {
    const legacy = {
      objects: [
        { id: 'object-1', offset: [0.5, 0, -0.25], yaw: Math.PI / 2 },
        { id: 'object-2', offset: [-1, 1.5, 0], yaw: -Math.PI / 4 },
      ],
      relationship: { kind: 'left-of', leftId: 'object-1', rightId: 'object-2' },
    };
    assert.equal(
      describeArrangement(legacy, nameOf),
      'A: Armchair left/right 0.50, down/up 0.00, away/toward -0.25, turn 90°; B: Lamp left/right -1.00, down/up 1.50, away/toward 0.00, turn -45°; rule: A: Armchair stays left of B: Lamp from the original photo',
    );
    assert.equal(describeArrangement(null, nameOf), '; rule: No rule');
  });

  it('describes an owner composition in words followed by the rule', () => {
    const rule = { kind: 'left-of', leftId: 'object-1', rightId: 'object-2', frame: 'owner-composition' };
    const owner = { ...facing, relationship: rule };
    const text = describeArrangement(owner, nameOf);
    assert.equal(text, `${describeComposition(owner, nameOf)} Rule: A: Armchair stays left of B: Lamp in the owner composition frame`);
    assert.doesNotMatch(text, /owner position|orientation \d|assumed relative scale/);
    assert.match(describeArrangement(facing, nameOf), / Rule: No rule$/);
  });

  it('does not throw for an unreadable owner composition', () => {
    const broken = { frame: 'owner-composition', objects: [{ id: 'object-1' }], relationship: null };
    assert.match(describeArrangement(broken, nameOf), /^The relationship between A: Armchair and B: Lamp is unavailable: .* Rule: No rule$/);
  });
});
