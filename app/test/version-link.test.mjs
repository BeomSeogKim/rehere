import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pickViewButton } from '../public/version-link.js';

// The visitor page marks each saved-view button with a viewId property; other controls have none.
const view = (textContent, viewId) => ({ textContent, viewId });
const control = (textContent) => ({ textContent });
const page = () => [view('Saved version 2', 'a'), view('Alternative arrangement 1', 'b'), view(' Alternative arrangement 2 ', 'c'),
  control('Explore in 3D'), control('Back to the starting view'), control('Compare with the photograph'), control('Play'), control('Pause'), control('Stop')];

describe('version link', () => {
  it('opens the saved version it names, ignoring surrounding whitespace in the button text', () => {
    const buttons = page();
    assert.equal(pickViewButton(buttons, 'Alternative arrangement 2'), buttons[2]);
    assert.equal(pickViewButton(buttons, 'Saved version 2'), buttons[0]);
  });

  it('ignores an unknown or differently written label', () => {
    for (const label of ['Alternative arrangement 9', 'alternative arrangement 2', 'Alternative arrangement', '', ' ']) assert.equal(pickViewButton(page(), label), null, JSON.stringify(label));
  });

  it('never presses a control that is not a saved version, even when its label is requested', () => {
    for (const label of ['Play', 'Pause', 'Stop', 'Explore in 3D', 'Back to the starting view', 'Compare with the photograph']) assert.equal(pickViewButton(page(), label), null, label);
  });

  it('is not fooled by a non-view control or a non-string viewId that carries a version label', () => {
    const real = view('Alternative arrangement 2', 'c');
    assert.equal(pickViewButton([control('Alternative arrangement 2'), real], 'Alternative arrangement 2'), real);
    assert.equal(pickViewButton([{ textContent: 'Alternative arrangement 2', viewId: 7 }, { textContent: 'Alternative arrangement 2', viewId: '' }], 'Alternative arrangement 2'), null);
  });

  it('selects nothing when two saved views share the label', () => {
    assert.equal(pickViewButton([view('Saved version 2', 'a'), view('Saved version 2', 'b')], 'Saved version 2'), null);
  });

  it('is what the exported page uses, with no broader button search left', async () => {
    const source = await readFile(fileURLToPath(new URL('../public/static-entry.js', import.meta.url)), 'utf8');
    assert.match(source, /pickViewButton\(container\.querySelectorAll\('button'\), label\)/);
    assert.doesNotMatch(source, /\.find\(\(item\) => item\.textContent/);
  });
});
