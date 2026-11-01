// The owner's recorded stories for one ready scene: connect a saved recording
// of this memory to one exact saved view with human-written captions, list the
// stories and withdraw them. A story never changes after it is saved; a
// correction is a new story. Captions are written by the owner, not
// transcribed or checked.

import { viewChoices } from './shares.js';
import { createStoryPlayer, formatMs, formatPosition } from './story-player.js';

export const TITLE_LIMIT = 120;
export const CUE_LIMIT = 200;
// An excerpt must end within the five minutes a recording may last.
export const EXCERPT_LIMIT_MS = 300_000;
export const CUE_TEXT_LIMIT = 2000;
export const CUES_TOTAL_LIMIT = 20_000;
const TARGET_LABEL = 'Selected foreground object';

// "m:ss.s", "ss.s" or "ss" to whole milliseconds; NaN when unreadable.
export function parseTime(text) {
  const match = /^\s*(?:(\d+):)?(\d+(?:\.\d{1,3})?)\s*$/.exec(text);
  if (!match) return NaN;
  const minutes = Number(match[1] ?? 0);
  const seconds = Number(match[2]);
  if (match[1] !== undefined && seconds >= 60) return NaN;
  return Math.round((minutes * 60 + seconds) * 1000);
}

// excerptMs: the exact length of a chosen excerpt, which captions must fit;
// otherwise durationHintMs is the whole recording's approximate length.
export function cuesProblem(cues, durationHintMs = null, excerptMs = null) {
  if (cues.length < 1) return 'Add at least one caption.';
  if (cues.length > CUE_LIMIT) return `Use ${CUE_LIMIT} captions or fewer.`;
  let total = 0;
  let previousEnd = 0;
  for (const [index, cue] of cues.entries()) {
    const n = index + 1;
    if (!Number.isInteger(cue.startMs) || !Number.isInteger(cue.endMs) || cue.startMs < 0) return `Caption ${n}: enter its start and end as minutes:seconds, for example 0:04.5.`;
    if (cue.startMs >= cue.endMs) return `Caption ${n}: the end must come after the start.`;
    if (cue.startMs < previousEnd) return `Caption ${n}: captions must be in order and must not overlap.`;
    if (!cue.text.trim()) return `Caption ${n}: write what is heard.`;
    if (cue.text.length > CUE_TEXT_LIMIT) return `Caption ${n}: keep it to ${CUE_TEXT_LIMIT} characters or fewer.`;
    total += cue.text.length;
    previousEnd = cue.endMs;
  }
  if (total > CUES_TOTAL_LIMIT) return `Keep all captions together to ${CUES_TOTAL_LIMIT.toLocaleString('en-US')} characters or fewer.`;
  if (Number.isInteger(excerptMs) && previousEnd > excerptMs) {
    return `The last caption ends at ${formatMs(previousEnd)}, after the end of the excerpt at ${formatPosition(excerptMs)}. Caption times start at 0:00 of the excerpt.`;
  }
  if (!Number.isInteger(excerptMs) && Number.isFinite(durationHintMs) && previousEnd > durationHintMs) {
    return `The last caption ends at ${formatMs(previousEnd)}, after the recording’s end at about ${formatMs(durationHintMs)}.`;
  }
  return null;
}

// Recordings of this memory the owner can still use to build a story.
export function usableVoices(sources) {
  return sources.filter((record) => record.kind === 'voice' && record.policy?.stopped !== true && record.permissions?.place === true);
}

function el(tag, { onclick, ...props } = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  if (onclick) node.addEventListener('click', onclick);
  node.append(...children);
  return node;
}

let fieldCount = 0;
function field(labelText, input, hintText = '') {
  input.id = `story-field-${++fieldCount}`;
  const nodes = [el('label', { htmlFor: input.id, textContent: labelText }), input];
  if (hintText) nodes.push(el('p', { className: 'hint', textContent: hintText }));
  return el('div', { className: 'source-field' }, nodes);
}

async function request(url, options = {}) {
  try {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options });
    const body = await response.json().catch(() => null);
    return { status: response.status, ok: response.ok, body };
  } catch {
    return { status: 0, ok: false, body: null };
  }
}

const postJson = (url, payload) =>
  request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
const unclear = (result) => result.status === 0 || result.status >= 500;
const reasonOf = (result) => (typeof result.body?.error === 'string' ? result.body.error.trim() : '');
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const eraText = (era) => {
  if (!era || era.kind === 'unknown') return 'Time unknown';
  const when = { exact: era.start, range: `${era.start} to ${era.end}`, relative: era.label }[era.kind];
  return when ? `Owner’s assertion: ${when}` : 'Time unknown';
};

// bridge: { jobUrl, sources (this memory's source records), editor() ->
// { version }, durationHintMs(sourceId) -> number|null, onChanged() after a
// story is saved or withdrawn, objects? }. objects, only on two-object
// scenes: [{ id, name }]; the person then chooses the story's object, with
// nothing chosen by default, and the body carries its targetId.
export function mountStories(container, bridge) {
  let disposed = false;
  let readToken = 0;
  let choices = [];
  let stories = [];
  let createAttempt = null;
  const withdrawAttempts = new Map();
  const players = [];

  const voiceSelect = el('select');
  const viewSelect = el('select');
  const targetSelect = bridge.objects
    ? el('select', {}, [el('option', { value: '', textContent: 'Choose an object' }), ...bridge.objects.map((object) => el('option', { value: object.id, textContent: object.name }))])
    : null;
  if (targetSelect) targetSelect.value = '';
  const title = el('input', { type: 'text', maxLength: 200 });
  // Which part of the recording the story plays: the whole (default) or an
  // excerpt between two positions in the ORIGINAL recording.
  const partName = `story-part-${Math.random().toString(36).slice(2)}`;
  const whole = el('input', { type: 'radio', name: partName, value: 'whole', checked: true });
  const excerpt = el('input', { type: 'radio', name: partName, value: 'excerpt', checked: false });
  const rangeStart = el('input', { type: 'text', placeholder: '0:00' });
  const rangeEnd = el('input', { type: 'text' });
  const lengthHint = el('p', { className: 'hint' });
  const rangeFields = el('div', { hidden: true }, [
    field('Start in the original recording', rangeStart, 'Leave blank to start at 0:00.'),
    field('End in the original recording', rangeEnd, 'Required for an excerpt.'),
  ]);
  const cueRows = el('div', { className: 'story-cue-rows' });
  const addCue = el('button', { type: 'button', className: 'secondary', textContent: 'Add a caption' });
  const confirmed = el('input', { type: 'checkbox' });
  const save = el('button', { type: 'button', textContent: 'Save story' });
  const abandon = el('button', { type: 'button', className: 'secondary', textContent: 'Stop waiting for the earlier save', hidden: true });
  let unresolved = null;
  const message = el('p', { className: 'form-message', role: 'alert' });
  const status = el('p', { className: 'hint', role: 'status' });
  const list = el('ul', { className: 'collab-list' });
  // Owner navigation from one object's sources: the list can be narrowed to
  // stories about that object (story.target.id). List-only; it never plays,
  // selects or changes the form below.
  const objectFilter = el('div', { className: 'object-filter' });
  let filterId = null;
  let revealToken = 0;
  let revealNote = '';
  let filterHeading = null;
  // Whether the last list read succeeded: an empty list is only "no stories"
  // after a successful read.
  let listRead = 'unread';
  const nameOf = (id) => bridge.objects?.find((object) => object.id === id)?.name ?? 'this object';
  const voiceNote = el('p', { className: 'hint' });

  const panel = el('details', { className: 'source-details story-panel' });
  container.replaceChildren(panel);
  panel.append(...[
      el('summary', { textContent: 'Recorded stories' }),
      el('p', {
        className: 'hint',
        textContent:
          'A story connects one saved recording of this memory to one saved view of the scene and its selected object, with captions you write. The original recording is kept unchanged; listeners hear a converted playback copy of either its whole first audio track or one excerpt of it that you choose. An excerpt may leave out parts of what was said. A saved story cannot be edited; save a new one to correct it.',
      }),
      field('Recording', voiceSelect),
      voiceNote,
      field('Saved view', viewSelect, 'Choose the exact saved version or alternative this story belongs to. It stays with that view.'),
      targetSelect ? field('Object', targetSelect, 'The object this story is about. Listeners can pick an object to find its stories.') : el('p', { className: 'hint', textContent: `Object: ${TARGET_LABEL}` }),
      field('Story title', title),
      el('fieldset', { className: 'source-permissions' }, [
        el('legend', { textContent: 'Part of the recording' }),
        el('label', {}, [whole, ' The whole recording']),
        el('label', {}, [excerpt, ' An excerpt']),
        el('p', { className: 'hint', textContent: 'Excerpt positions are in the original recording. Captions start at 0:00 of the part you choose. An excerpt is a listening selection, not proof that the statement is complete or true.' }),
        rangeFields,
        lengthHint,
      ]),
      el('fieldset', { className: 'source-permissions' }, [
        el('legend', { textContent: 'Captions' }),
        el('p', { className: 'hint', textContent: 'Write what is heard, with start and end times as minutes:seconds from 0:00 of the part you chose (for example 0:04.5). Rehere does not transcribe or check them.' }),
        cueRows,
        el('div', { className: 'actions access-links' }, [addCue]),
      ]),
      el('label', { className: 'memory-consent' }, [confirmed, ' These captions, written by me, convey the meaningful audible content of the part chosen to play (the whole recording or the excerpt); they are not checked by Rehere']),
      el('div', { className: 'actions' }, [save, abandon]),
      message,
      status,
      objectFilter,
      list,
    ]);

  function addCueRow(values = { start: '', end: '', text: '' }) {
    const start = el('input', { type: 'text', value: values.start, inputMode: 'decimal' });
    const end = el('input', { type: 'text', value: values.end, inputMode: 'decimal' });
    const text = el('textarea', { rows: 2, maxLength: CUE_TEXT_LIMIT, value: values.text });
    const remove = el('button', { type: 'button', className: 'secondary', textContent: 'Remove caption' });
    const row = el('div', { className: 'story-cue-row' }, [field('Start', start), field('End', end), field('Caption', text), remove]);
    row.read = () => ({ startMs: parseTime(start.value), endMs: parseTime(end.value), text: text.value });
    remove.addEventListener('click', () => row.remove());
    cueRows.append(row);
  }

  const readCues = () => [...cueRows.children].filter((row) => row.read).map((row) => row.read());

  function renderVoices() {
    const voices = usableVoices(bridge.sources);
    const others = bridge.sources.filter((record) => record.kind === 'voice' && !voices.includes(record));
    voiceSelect.replaceChildren(...voices.map((record) => el('option', { value: record.id, textContent: `Recording by ${record.provider || 'an unnamed provider'}` })));
    voiceSelect.value = voices[0]?.id ?? '';
    voiceNote.textContent = voices.length
      ? others.length
        ? 'Recordings that may not be used to reconstruct this place, or whose use was stopped, are not offered.'
        : ''
      : 'No recording of this memory may be used for a story. Recordings that may not be used to reconstruct this place, or whose use was stopped, are not offered.';
    save.disabled = voices.length === 0;
  }

  function renderViews(keepKey = null) {
    viewSelect.replaceChildren(
      el('option', { value: '', textContent: 'Choose a saved view' }),
      ...choices.map((choice) => el('option', { value: choice.key, textContent: `${choice.label} · ${eraText(choice.era)}` })),
    );
    viewSelect.value = keepKey && choices.some((choice) => choice.key === keepKey) ? keepKey : '';
  }

  function renderList() {
    for (const player of players.splice(0)) player.dispose();
    renderFilter();
    list.replaceChildren(
      ...(filterId ? stories.filter((story) => story.target?.id === filterId) : stories).map((story) => {
        const item = el('li', {});
        if (story.status === 'withdrawn') {
          item.append(el('p', { className: 'hint', textContent: 'Withdrawn story. It is no longer played or shared; the original recording is kept.' }));
          return item;
        }
        if (!story.available) {
          item.append(el('p', { className: 'hint', textContent: `Not available: ${story.blockedReason || 'its recording, photo or saved view can no longer be used.'}` }));
          if (story.voice?.provider) item.append(el('p', { className: 'hint', textContent: `Recording by ${story.voice.provider}` }));
          item.append(withdrawControl(story));
          return item;
        }
        const player = createStoryPlayer({ story, fetchAudio: (signal) => fetch(`${bridge.jobUrl}/stories/${encodeURIComponent(story.id)}/audio.wav`, { credentials: 'same-origin', cache: 'no-store', signal }) });
        players.push(player);
        item.append(
          el('p', { className: 'space-choice-label', textContent: story.title }),
          el('p', { className: 'hint', textContent: `${story.view?.label ?? 'Saved view'} · ${eraText(story.view?.era)} · ${story.target?.label ?? TARGET_LABEL}` }),
          el('p', { className: 'hint', textContent: `Recording by ${story.voice?.provider || 'an unnamed provider'}. Captions written by ${story.captionAuthor?.displayName || 'the owner'}. ${Number.isFinite(story.durationMs) ? `Length ${formatMs(story.durationMs)}. ` : ''}You hear a converted playback copy; the original is unchanged.` }),
          player.element,
          withdrawControl(story),
        );
        return item;
      }),
    );
    status.textContent = listRead === 'failed' ? 'Recorded stories could not be read just now.' : listRead === 'ok' && !stories.length ? 'No recorded stories yet.' : '';
  }

  function withdrawControl(story) {
    const wrap = el('div', { className: 'actions' });
    const start = el('button', { type: 'button', className: 'secondary', textContent: 'Withdraw story' });
    start.addEventListener('click', () => {
      const confirm = el('button', { type: 'button', textContent: 'Withdraw this story' });
      const cancel = el('button', { type: 'button', className: 'secondary', textContent: 'Keep it', onclick: () => wrap.replaceChildren(start) });
      confirm.addEventListener('click', async () => {
        if (!withdrawAttempts.has(story.id)) withdrawAttempts.set(story.id, { requestId: crypto.randomUUID() });
        confirm.disabled = true;
        const result = await postJson(`${bridge.jobUrl}/stories/${encodeURIComponent(story.id)}/withdraw`, withdrawAttempts.get(story.id));
        if (disposed) return;
        confirm.disabled = false;
        if (unclear(result)) {
          message.textContent = `${reasonOf(result) ? `${reasonOf(result)} ` : ''}Rehere could not confirm the withdrawal. Pressing it again repeats the same request.`;
          return;
        }
        withdrawAttempts.delete(story.id);
        message.textContent = result.ok
          ? 'Withdrawn. The story is no longer played or shared, and shared links that included it stop working. Copies already saved on a device cannot be removed.'
          : reasonOf(result) || 'The story could not be withdrawn.';
        if (result.ok) bridge.onChanged?.();
        await load();
      });
      wrap.replaceChildren(el('p', { className: 'hint', textContent: 'The story stops being played and shared. The original recording is kept.' }), cancel, confirm);
    });
    wrap.append(start);
    return wrap;
  }

  // Every read goes through load(), so latestRead is always the newest one.
  // Resolves true or false for the stories read, or null when a newer read
  // replaced it.
  let latestRead = null;
  function load(options) {
    latestRead = readOnce(options);
    return latestRead;
  }
  async function readOnce({ keepView = true } = {}) {
    const token = ++readToken;
    const [listResult, historyResult, collabResult] = await Promise.all([request(`${bridge.jobUrl}/stories`), request(`${bridge.jobUrl}/history`), request(`${bridge.jobUrl}/collaboration`)]);
    if (disposed || token !== readToken) return null;
    const read = listResult.ok && Array.isArray(listResult.body?.stories);
    listRead = read ? 'ok' : 'failed';
    stories = read ? listResult.body.stories : stories;
    // Saved-view choices change only from a complete fresh read; a failed
    // history or recollection read keeps the earlier choices and selection.
    if (historyResult.ok && Array.isArray(historyResult.body) && collabResult.ok && Array.isArray(collabResult.body?.variants)) {
      choices = viewChoices({ history: historyResult.body, variants: collabResult.body.variants, currentVersion: bridge.editor().version });
      renderViews(keepView ? viewSelect.value : null);
    }
    renderList();
    return read;
  }

  function renderFilter() {
    if (!bridge.objects || (!filterId && !revealNote)) {
      objectFilter.replaceChildren();
      filterHeading = null;
      return;
    }
    const nodes = [];
    filterHeading = null;
    if (revealNote) nodes.push(el('p', { className: 'hint', role: 'status', textContent: revealNote }));
    if (filterId && revealNote) {
      // While a newer jump is reading or has failed, the list still shown is
      // the earlier one: say so, with no fresh count or "none".
      filterHeading = el('p', { className: 'hint', textContent: `Still showing the earlier results for ${nameOf(filterId)}.` });
      nodes.push(filterHeading);
    } else if (filterId) {
      const shown = stories.filter((story) => story.target?.id === filterId).length;
      const unassigned = stories.filter((story) => !bridge.objects.some((object) => object.id === story.target?.id)).length;
      filterHeading = el('p', { className: 'hint', textContent: shown ? `Showing recorded stories about ${nameOf(filterId)} (${shown}).` : `No recorded story is about ${nameOf(filterId)}.` });
      nodes.push(filterHeading, ...(unassigned ? [el('p', { className: 'hint', textContent: `${unassigned} without a recorded object ${unassigned === 1 ? 'is' : 'are'} under Show all.` })] : []));
    }
    const all = el('button', { type: 'button', className: 'secondary', textContent: 'Show all recorded stories' });
    all.addEventListener('click', showAll);
    nodes.push(el('div', { className: 'actions' }, [all]));
    objectFilter.replaceChildren(...nodes);
  }

  // Shows only stories about one object, after a fresh read. Nothing is
  // declared before that read succeeds; a failed read never becomes "none",
  // and a late answer for a newer jump, object or scene changes nothing.
  // Re-rendering stops playback; nothing plays or downloads until Play.
  async function revealForObject(objectId, isCurrent) {
    const mine = ++revealToken;
    panel.open = true;
    revealNote = `Reading recorded stories about ${nameOf(objectId)}…`;
    renderFilter();
    // Follow only a genuinely newer read. A write that invalidated this read
    // without starting another leaves nothing to follow: this jump ends
    // without declaring anything, and the write's own refresh follows.
    let read = load();
    let ok = await read;
    while (ok === null && !disposed && latestRead !== read) {
      read = latestRead;
      ok = await read;
    }
    if (disposed || mine !== revealToken) return 'stale';
    if (ok === null || !isCurrent()) {
      revealNote = '';
      renderFilter();
      return 'stale';
    }
    if (!ok) {
      revealNote = `Recorded stories could not be read just now, so nothing is shown as about ${nameOf(objectId)}. Try again.`;
      renderFilter();
      return 'failed';
    }
    revealNote = '';
    filterId = objectId;
    renderList();
    const target = list.children[0] ?? filterHeading ?? objectFilter;
    target.setAttribute?.('tabindex', '-1');
    target.focus?.();
    target.scrollIntoView?.({ block: 'nearest' });
    return 'shown';
  }

  function showAll() {
    revealToken += 1;
    revealNote = '';
    filterId = null;
    renderList();
  }

  function storyInput() {
    const choice = choices.find((entry) => entry.key === viewSelect.value);
    return {
      voiceSourceId: voiceSelect.value,
      view: choice ? { kind: choice.kind, version: choice.version, variantId: choice.variantId, eraRevision: choice.eraRevision } : null,
      ...(targetSelect ? { targetId: targetSelect.value } : {}),
      title: title.value,
      // Only an excerpt adds a range; the whole recording sends exactly the earlier request.
      ...(excerpt.checked ? { sourceRange: { startMs: rangeStart.value.trim() === '' ? 0 : parseTime(rangeStart.value), endMs: parseTime(rangeEnd.value) } } : {}),
      cues: readCues(),
      captionConfirmed: confirmed.checked === true,
    };
  }

  // A save whose outcome is unknown stays unresolved: until the server answers
  // it, the only save sent is that same original request. Newer edits stay in
  // the form for afterwards. A 409 on such a retry may mean the original is
  // still being prepared, so it stays unresolved too.

  function renderUnresolved() {
    save.textContent = unresolved ? 'Retry the earlier save' : 'Save story';
    if (!unresolved) abandon.hidden = true;
  }

  // The excerpt range as entered: no request is sent while it is unusable.
  function rangeProblem(range) {
    if (!range) return null;
    if (!Number.isInteger(range.startMs) || range.startMs < 0) return 'Enter where the excerpt starts in the original recording as minutes:seconds, for example 0:04.5, or leave it blank to start at 0:00.';
    if (rangeEnd.value.trim() === '') return 'Enter where the excerpt ends in the original recording.';
    if (!Number.isInteger(range.endMs)) return 'Enter where the excerpt ends as minutes:seconds, for example 0:12.0.';
    if (range.endMs <= range.startMs) return 'The excerpt must end after it starts.';
    if (range.endMs > EXCERPT_LIMIT_MS) return `An excerpt must end by ${formatMs(EXCERPT_LIMIT_MS)} in the original recording.`;
    return null;
  }

  function renderPart() {
    rangeFields.hidden = !excerpt.checked;
    const hint = bridge.durationHintMs?.(voiceSelect.value) ?? null;
    lengthHint.textContent = Number.isFinite(hint) ? `This recording is about ${formatMs(hint)} long. Rehere checks the exact length when saving.` : '';
  }

  // A different recording, part or range is different audible content, so the
  // caption confirmation must be given again.
  const contentChanged = () => {
    confirmed.checked = false;
    renderPart();
  };
  voiceSelect.addEventListener('change', contentChanged);
  whole.addEventListener('change', contentChanged);
  excerpt.addEventListener('change', contentChanged);
  rangeStart.addEventListener('input', contentChanged);
  rangeEnd.addEventListener('input', contentChanged);

  function resetForm() {
    title.value = '';
    if (targetSelect) targetSelect.value = '';
    confirmed.checked = false;
    whole.checked = true;
    excerpt.checked = false;
    rangeStart.value = '';
    rangeEnd.value = '';
    renderPart();
    cueRows.replaceChildren();
    addCueRow();
  }

  async function send(attempt, retrying) {
    save.disabled = true;
    message.textContent = '';
    status.textContent = 'Preparing the recording for playback. This can take up to half a minute.';
    const result = await postJson(`${bridge.jobUrl}/stories`, attempt.body);
    if (disposed) return;
    save.disabled = false;
    status.textContent = '';
    if (unclear(result) || (retrying && result.status === 409)) {
      unresolved = attempt;
      createAttempt = null;
      renderUnresolved();
      message.textContent = `${reasonOf(result) ? `${reasonOf(result)} ` : ''}Rehere could not confirm whether the story “${attempt.input.title}” was saved. Retrying sends exactly that request again; any newer changes in the form are kept for afterwards.`;
      if (retrying && result.status === 409) abandon.hidden = false;
      return;
    }
    // Access is checked before the server looks the request up, so a refusal on
    // a retry says nothing about whether the earlier save was kept.
    if (retrying && (result.status === 401 || result.status === 403)) {
      unresolved = attempt;
      renderUnresolved();
      message.textContent = `${reasonOf(result) ? `${reasonOf(result)} ` : ''}Rehere could not check whether the earlier story “${attempt.input.title}” was saved. Sign in again or check your access, then retry the earlier save or look for it in the saved stories.`;
      return;
    }
    if (result.status === 409) {
      // A conflict on a first try changed nothing. The prepared request stays
      // for an unchanged retry; a changed view must be chosen again.
      message.textContent = `${reasonOf(result) || 'The story could not be saved right now.'} If the saved view changed, choose it again after reviewing it; nothing was changed for you.`;
      await load({ keepView: false });
      return;
    }
    const wasUnresolved = unresolved === attempt;
    unresolved = null;
    createAttempt = null;
    renderUnresolved();
    if (!result.ok) {
      message.textContent = `${reasonOf(result) || 'The story could not be saved.'}${wasUnresolved ? ' The earlier save was not kept.' : ''}`;
      return;
    }
    // The form is cleared only if it still holds exactly what was sent; edits
    // made while the save was running stay.
    const formMatches = sameJson(storyInput(), attempt.input);
    if (formMatches) resetForm();
    message.textContent = formMatches
      ? 'Saved. The story is ready to play and can be included when sharing its view.'
      : `The earlier story “${attempt.input.title}” was saved${wasUnresolved ? '' : ' while you were editing'}. Your newer changes are still in the form; save them as a new story if you want.`;
    bridge.onChanged?.();
    await load();
  }

  save.addEventListener('click', async () => {
    if (unresolved) {
      await send(unresolved, true);
      return;
    }
    const input = storyInput();
    const problem = !input.voiceSourceId
      ? 'Choose a recording.'
      : !input.view
        ? 'Choose the saved view this story belongs to.'
        : targetSelect && !input.targetId
          ? 'Choose the object this story is about.'
          : !input.title.trim()
          ? 'Give the story a title.'
          : [...input.title].length > TITLE_LIMIT
            ? `Keep the title to ${TITLE_LIMIT} characters or fewer.`
            : rangeProblem(input.sourceRange) ??
              cuesProblem(input.cues, bridge.durationHintMs?.(input.voiceSourceId) ?? null, input.sourceRange ? input.sourceRange.endMs - input.sourceRange.startMs : null) ??
              (input.captionConfirmed ? null : 'Confirm that your captions convey what is heard.');
    if (problem) {
      message.textContent = problem;
      return;
    }
    if (!createAttempt || !sameJson(createAttempt.input, input)) createAttempt = { input, body: { requestId: crypto.randomUUID(), ...input } };
    await send(createAttempt, false);
  });
  abandon.addEventListener('click', () => {
    message.textContent = `Stopped waiting for “${unresolved?.input.title}”. If it was saved after all, it will appear in the list below.`;
    unresolved = null;
    renderUnresolved();
    load();
  });
  addCue.addEventListener('click', () => addCueRow());

  renderVoices();
  renderPart();
  addCueRow();
  load();
  return {
    refresh: () => load(),
    revealForObject,
    showAll,
    dispose() {
      disposed = true;
      readToken += 1;
      for (const player of players.splice(0)) player.dispose();
      container.replaceChildren();
    },
  };
}
