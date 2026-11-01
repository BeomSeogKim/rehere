// Plain-language relations for a two-object owner composition. Everything here
// describes the saved layout only: directions use the fixed owner frame
// (+X right, +Y up, +Z front), never the viewing camera, and nothing is
// measured, historical or an automatically known front.
import { COMPOSITION_OBJECT_IDS, poseProblem, rotateVector } from './composition-scene.js';

// An offset smaller than this is still stated, but as "slightly".
const READABLE = 0.05;
const LAYOUT = "In the owner's assumed layout";
const FALLBACK_NAMES = ['the first object', 'the second object'];

const AXES = [
  { gap: 'left/right', negative: 'left of', positive: 'right of', same: 'at the same left/right position as', moves: ['left', 'right'] },
  { gap: 'up/down', negative: 'below', positive: 'above', same: 'at the same height as', moves: ['down', 'up'] },
  { gap: 'front/back', negative: 'behind', positive: 'in front of', same: 'at the same front/back position as', moves: ['toward the back', 'toward the front'] },
];

function displayName(nameOf, index) {
  try {
    const name = nameOf(COMPOSITION_OBJECT_IDS[index]);
    if (typeof name === 'string' && name.trim()) return name.trim();
  } catch {
    // An unreadable name falls back to a neutral one.
  }
  return FALLBACK_NAMES[index];
}

const isReadable = (pose) => {
  try {
    return !poseProblem(pose) && [...pose.position, ...pose.quaternion, pose.scale].every(Number.isFinite);
  } catch {
    return false;
  }
};

// One pose per fixed object id, or null when it is missing, duplicated or unreadable.
function readPoses(arrangement) {
  const objects = arrangement?.frame === 'owner-composition' && Array.isArray(arrangement.objects) && arrangement.objects.length === 2
    ? arrangement.objects : [];
  return COMPOSITION_OBJECT_IDS.map((id) => {
    const matches = objects.filter((object) => object?.id === id);
    return matches.length === 1 && isReadable(matches[0]) ? matches[0] : null;
  });
}

const joinAnd = (items) => (items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`);
const subtract = (a, b) => a.map((n, i) => n - b[i]);
const sameVector = (a, b) => a.every((n, i) => n === b[i]);

// 0 is exactly no offset; +-1 is a nonzero offset below the readable tier; +-2 is clear.
const axisState = (value) => (value === 0 ? 0 : Math.sign(value) * (Math.abs(value) < READABLE ? 1 : 2));
const axisPhrase = (axis, state) => (state === 0 ? axis.same : `${Math.abs(state) === 1 ? 'slightly ' : ''}${state < 0 ? axis.negative : axis.positive}`);

// Where the photographed side (local +Z) of `from` points relative to `to`.
function pointing(from, to) {
  const delta = subtract(to.position, from.position);
  if (delta.every((n) => n === 0)) return { kind: 'undefined', near: false };
  const distance = Math.hypot(...delta);
  const forward = rotateVector([0, 0, 1], from.quaternion);
  const cosine = delta.reduce((sum, n, i) => sum + n * forward[i], 0) / distance;
  const kind = cosine >= 0.87 ? 'toward' : cosine >= 0.5 ? 'partly' : cosine > -0.5 ? 'side' : 'away';
  return { kind, near: distance < READABLE };
}
const direction = (kind, ref) => ({ toward: `toward ${ref}`, partly: `partly toward ${ref}`, side: `to the side of ${ref}`, away: `away from ${ref}` })[kind];

export function describeComposition(arrangement, nameOf) {
  const names = [0, 1].map((index) => displayName(nameOf, index));
  const poses = readPoses(arrangement);
  const unreadable = names.filter((_, index) => !poses[index]);
  if (unreadable.length) return `The relationship between ${names[0]} and ${names[1]} is unavailable: the saved pose for ${unreadable.join(' and ')} is missing or unreadable.`;

  const [first, second] = poses;
  const states = subtract(first.position, second.position).map(axisState);
  const present = AXES.map((axis, index) => ({ axis, state: states[index] })).filter(({ state }) => state !== 0);
  const absent = AXES.filter((_, index) => states[index] === 0).map((axis) => axis.gap);
  const lead = `${LAYOUT}, not the viewing camera,`;
  const placement = present.length
    ? `${lead} ${names[0]} is ${joinAnd(present.map(({ axis, state }, n) => `${axisPhrase(axis, state)} ${n === 0 ? names[1] : 'it'}`))}${absent.length ? `, with no ${absent.join(' or ')} offset` : ''}.`
    : `${lead} ${names[0]} and ${names[1]} are at the same position.`;

  const toSecond = pointing(first, second);
  const toFirst = pointing(second, first);
  let facing;
  if (toSecond.kind === 'undefined') {
    facing = 'The two centres coincide, so which way each photographed side points relative to the other is undefined.';
  } else {
    const near = toSecond.near;
    facing = `${near ? 'At nearly coincident centres, ' : ''}${names[0]}'s photographed side ${near ? 'approximately points' : 'points'} ${direction(toSecond.kind, names[1])}, and ${names[1]}'s photographed side ${near ? 'approximately points' : 'points'} ${direction(toFirst.kind, names[0])}.`;
  }

  // Each scale multiplies its own source mesh, whose native extent depends on that
  // photograph's depth and field of view. Without geometry, only the two settings
  // can be compared, never which object is bigger.
  const [sizeFirst, sizeSecond] = [first.scale, second.scale];
  let size = `${names[0]} and ${names[1]} have the same assumed relative-size setting; the settings do not show whether the objects match in size.`;
  if (sizeFirst !== sizeSecond) {
    const ratio = Math.max(sizeFirst / sizeSecond, sizeSecond / sizeFirst);
    const degree = ratio - 1 < READABLE ? 'slightly ' : ratio >= 2 ? 'much ' : '';
    size = `${names[0]} has a ${degree}${sizeFirst > sizeSecond ? 'larger' : 'smaller'} assumed relative-size setting than ${names[1]}; the settings do not show which object is bigger.`;
  }
  return [placement, facing, size].join(' ');
}

// Every nonzero axis is named; clear movement comes first and a small one is
// marked "slightly", so no changed coordinate is dropped.
function movementSentence(name, before, after) {
  const delta = subtract(after.position, before.position);
  const words = AXES.flatMap((axis, index) => (delta[index] === 0 ? [] : [{ word: axis.moves[delta[index] > 0 ? 1 : 0], slight: Math.abs(delta[index]) < READABLE }]));
  const ordered = [...words.filter(({ slight }) => !slight), ...words.filter(({ slight }) => slight)];
  return `${name} moved ${joinAnd(ordered.map(({ word, slight }) => (slight ? `slightly ${word}` : word)))}.`;
}

function relationSentence(relationBefore, relationAfter, ref, moved) {
  if (sameVector(relationBefore, relationAfter)) return moved ? `Its position relative to ${ref} is unchanged.` : null;
  const statesBefore = relationBefore.map(axisState);
  const statesAfter = relationAfter.map(axisState);
  const changed = [0, 1, 2].filter((index) => statesBefore[index] !== statesAfter[index]);
  // An axis whose offset changed without leaving its tier stays visible beside one that did.
  const kept = [0, 1, 2].filter((index) => statesBefore[index] === statesAfter[index] && relationBefore[index] !== relationAfter[index]);
  const stillPhrases = (first) => kept.map((index, n) => `${axisPhrase(AXES[index], statesAfter[index])} ${first && n === 0 ? ref : 'it'}`);
  if (!changed.length) return `It is still ${joinAnd(stillPhrases(true))}.`;
  const parts = changed.map((index, n) => {
    const target = n === 0 ? ref : 'it';
    return `${axisPhrase(AXES[index], statesAfter[index])} ${target} (rather than ${axisPhrase(AXES[index], statesBefore[index])} ${target})`;
  });
  return `It is now ${joinAnd(parts)}${kept.length ? `, and still ${joinAnd(stillPhrases(false))}` : ''}.`;
}

function pointingSentence(before, after, ref) {
  if (before.kind === after.kind) return null;
  if (after.kind === 'undefined') return `Because the centres now coincide, its photographed side has no defined direction relative to ${ref} rather than pointing ${direction(before.kind, ref)}.`;
  const now = `${after.near ? 'approximately points' : 'points'} ${direction(after.kind, ref)}`;
  if (before.kind === 'undefined') return `Its photographed side now ${now}; before, the coincident centres left its direction undefined.`;
  return `Its photographed side now ${now} rather than ${direction(before.kind, ref)}${before.near ? ' (at nearly coincident centres)' : ''}.`;
}

// Opposite quaternion signs are one orientation. The angle comes from the
// delta quaternion's vector part so a tiny rotation stays visible.
function orientationSentence(before, after) {
  if (sameVector(before, after) || before.every((n, i) => n === -after[i])) return null;
  const [ax, ay, az, aw] = after;
  const [bx, by, bz, bw] = before;
  const w = aw * bw + ax * bx + ay * by + az * bz;
  const v = [
    bw * ax - aw * bx - (ay * bz - az * by),
    bw * ay - aw * by - (az * bx - ax * bz),
    bw * az - aw * bz - (ax * by - ay * bx),
  ];
  const degrees = (2 * Math.atan2(Math.hypot(...v), Math.abs(w)) * 180) / Math.PI;
  return degrees < 3 ? 'Its orientation changed slightly.' : `Its orientation changed by about ${Math.min(180, Math.round(degrees / 5) * 5)}° overall.`;
}

function sizeSentence(before, after) {
  if (before === after) return null;
  const ratio = Math.max(after / before, before / after);
  const degree = ratio - 1 < READABLE ? 'slightly ' : ratio >= 2 ? 'much ' : '';
  return `Its assumed relative size is now ${degree}${after > before ? 'larger' : 'smaller'}.`;
}

function describeChange(index, names, before, after) {
  const other = 1 - index;
  const [pastSelf, nowSelf] = [before[index], after[index]];
  if (!pastSelf || !nowSelf) return `${LAYOUT}, a change for ${names[index]} cannot be described because its saved pose is missing or unreadable in one of the compared views.`;

  const moved = !sameVector(pastSelf.position, nowSelf.position);
  const unchanged = [];
  const sentences = [];
  if (moved) sentences.push(movementSentence(names[index], pastSelf, nowSelf)); else unchanged.push('position');

  const ref = names[other];
  if (before[other] && after[other]) {
    const relation = relationSentence(subtract(pastSelf.position, before[other].position), subtract(nowSelf.position, after[other].position), ref, moved);
    const facing = pointingSentence(pointing(pastSelf, before[other]), pointing(nowSelf, after[other]), ref);
    sentences.push(...[relation, facing].filter(Boolean));
  } else {
    sentences.push(`Its relationship to ${ref} cannot be described because that object's saved pose is missing or unreadable in one of the compared views.`);
  }

  const orientation = orientationSentence(pastSelf.quaternion, nowSelf.quaternion);
  if (orientation) sentences.push(orientation); else unchanged.push('orientation');
  const size = sizeSentence(pastSelf.scale, nowSelf.scale);
  if (size) sentences.push(size); else unchanged.push('assumed relative size');

  if (unchanged.length) {
    const leads = unchanged[0] === 'position';
    const sentence = `${leads ? `${names[index]}'s` : 'Its'} saved ${joinAnd(unchanged)} ${unchanged.length === 1 ? 'is' : 'are'} unchanged.`;
    if (leads) sentences.unshift(sentence); else sentences.push(sentence);
  }
  return `${LAYOUT}, ${sentences.join(' ')}`;
}

export function compositionDifference(before, after, nameOf) {
  const names = [0, 1].map((index) => displayName(nameOf, index));
  const [poseBefore, poseAfter] = [readPoses(before), readPoses(after)];
  return COMPOSITION_OBJECT_IDS.map((objectId, index) => ({ objectId, text: describeChange(index, names, poseBefore, poseAfter) }));
}
