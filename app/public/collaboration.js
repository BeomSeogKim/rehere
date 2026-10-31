// Written recollections from invited contributors, the owner's manual review
// of them, saved alternatives with owner time assertions, and invitations.
// Nothing here reads meaning from a recollection: any change to the scene is
// a transform the owner sets by hand, previews on the real viewer and saves
// explicitly. Recollections, photos and model reconstructions stay separate
// kinds of evidence; none of them is shown as verified history.

import { isCalendarDate } from './source-details.js';

export const TEXT_LIMIT = 10_000;
export const PERIOD_LIMIT = 300;
export const REASON_LIMIT = 1000;
export const ERA_LABEL_LIMIT = 300;
export const ERA_STATEMENT_LIMIT = 2000;
export const OFFSET_LIMIT = 2;
export const DECISIONS = Object.freeze(['reviewing', 'adopt', 'alternative', 'hold', 'reject']);
export const CONFLICTS = Object.freeze({
  unknown: 'Not known',
  viewpoint: 'Different viewpoint',
  time: 'Different time',
  memory: 'Memories differ',
  recognition: 'Different object recognised',
});
const DECISION_LABELS = {
  reviewing: 'Mark as being reviewed',
  adopt: 'Adopt into the current scene',
  alternative: 'Keep as a separate alternative',
  hold: 'Hold for now',
  reject: 'Do not use',
};
const PERMISSION_LABELS = {
  place: 'Use to reconstruct this place',
  model: 'Use for model processing',
  share: 'Share with others',
};
const FINAL = new Set(['adopted', 'alternative', 'rejected', 'withdrawn']);

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function invitationToken(crypto = globalThis.crypto) {
  return `rhi_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export function contributionStatusText(contribution) {
  switch (contribution.status) {
    case 'submitted':
      return 'Received. The owner has not reviewed it yet.';
    case 'reviewing':
      return 'The owner is reviewing it.';
    case 'held':
      return 'The owner is holding it for now.';
    case 'adopted':
      return 'The owner used it to adjust the current scene.';
    case 'alternative':
      return 'The owner kept it as a separate alternative scene.';
    case 'rejected':
      return 'The owner decided not to use it.';
    case 'withdrawn':
      return 'Withdrawn. Rehere no longer shows or uses these words.';
    default:
      return 'Status unknown.';
  }
}

export function submissionProblem({ text, periodClaim }) {
  if (!text.trim()) return 'Write your recollection before sending it.';
  if (text.length > TEXT_LIMIT) return `Keep your recollection to ${TEXT_LIMIT.toLocaleString('en-US')} characters or fewer.`;
  if (periodClaim.length > PERIOD_LIMIT) return `Keep the time as you remember it to ${PERIOD_LIMIT} characters or fewer.`;
  return null;
}

export function transformProblem(transform) {
  if (!transform) return 'Set the candidate position first.';
  const { offset, yaw } = transform;
  if (!Array.isArray(offset) || offset.length !== 3 || !offset.every(Number.isFinite)) return 'Each position value must be a number.';
  if (offset.some((value) => Math.abs(value) > OFFSET_LIMIT)) return `Each position value must be between -${OFFSET_LIMIT} and ${OFFSET_LIMIT}.`;
  if (!Number.isFinite(yaw) || Math.abs(yaw) > Math.PI) return 'The turn must be between -180 and 180 degrees.';
  return null;
}

export function eraProblem(era) {
  const { kind, label, start, end, relation, relativeToVariantId, statement, confirmed } = era;
  if (label.length > ERA_LABEL_LIMIT) return `Keep the label to ${ERA_LABEL_LIMIT} characters or fewer.`;
  if (statement.length > ERA_STATEMENT_LIMIT) return `Keep the statement to ${ERA_STATEMENT_LIMIT} characters or fewer.`;
  if (kind === 'unknown') return null;
  if (!statement.trim()) return 'Write what the time is based on.';
  if (!confirmed) return 'Confirm that this is your own assertion.';
  if (kind === 'exact' && !isCalendarDate(start ?? '')) return 'Enter a real calendar date.';
  if (kind === 'range') {
    if (!isCalendarDate(start ?? '') || !isCalendarDate(end ?? '')) return 'Enter real calendar dates for both ends.';
    if (start > end) return 'The range must start before it ends.';
  }
  if (kind === 'relative') {
    if (!label.trim()) return 'Describe the time, for example “before the renovation”.';
    if (Boolean(relation) !== Boolean(relativeToVariantId)) return 'Choose both the relation and the other scene, or neither.';
  }
  return null;
}

// The owner's assertion, phrased as an assertion. A missing or unknown era is
// shown as unknown; no year is ever inferred.
export function describeEra(era, labelFor = () => 'another scene') {
  if (!era || era.kind === 'unknown') return 'Time unknown';
  const relation = era.relation ? ` (${era.relation === 'same-time' ? 'same time as' : era.relation} ${labelFor(era.relativeToVariantId)})` : '';
  const when = { exact: era.start, range: `${era.start} to ${era.end}`, relative: era.label }[era.kind];
  return `Owner’s assertion: ${when}${era.kind !== 'relative' && era.label ? ` · ${era.label}` : ''}${relation}`;
}

// The provider's display name as recorded when they wrote it.
const providerName = (entry) => entry.provider?.displayName || 'Someone';

const formatTransform = ({ offset, yaw }) =>
  `left/right ${offset[0].toFixed(2)}, down/up ${offset[1].toFixed(2)}, away/toward ${offset[2].toFixed(2)}, turn ${Math.round((yaw * 180) / Math.PI)}°`;

function el(tag, { onclick, ...props } = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  if (onclick) node.addEventListener('click', onclick);
  node.append(...children);
  return node;
}

let fieldCount = 0;
function field(labelText, input, hintText = '') {
  input.id = `collab-field-${++fieldCount}`;
  const nodes = [el('label', { htmlFor: input.id, textContent: labelText }), input];
  if (hintText) nodes.push(el('p', { className: 'hint', textContent: hintText }));
  return el('div', { className: 'source-field' }, nodes);
}

function select(options, value) {
  const node = el('select');
  for (const [optionValue, text] of options) node.append(el('option', { value: optionValue, textContent: text }));
  node.value = value;
  return node;
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
const withReason = (result, note) => (reasonOf(result) ? `${reasonOf(result)} ${note}` : note);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Keeps one prepared request per action. It is reused only after an unknown
// outcome and only while the input is unchanged; any server answer clears it.
function attempts() {
  let held = null;
  return {
    prepare(key, input, build) {
      if (!held || held.key !== key || !sameJson(held.input, input)) held = { key, input, body: build() };
      return held.body;
    },
    settle() {
      held = null;
    },
  };
}

// A withdrawn recollection keeps its original grants on the server, but none of
// them applies any more.
const usesText = (entry) => (entry.status === 'withdrawn' ? 'All further use withdrawn.' : grantsText(entry.permissions));

function grantsText(permissions) {
  const allowed = Object.entries(PERMISSION_LABELS).filter(([key]) => permissions?.[key] === true);
  return allowed.length ? `Allowed: ${allowed.map(([, label]) => label.toLowerCase()).join('; ')}.` : 'No uses allowed.';
}

// ---------------------------------------------------------------- contributor

// A contributor's own screen: choose a place, send a written recollection, see
// what happened to it and withdraw it. No scene, photo, microphone or other
// people's words are requested.
export function mountContributor(container) {
  let disposed = false;
  let place = null;
  let generation = 0;
  // Each read of the own list carries a token; a write or a newer read makes
  // older reads stale, so a slow older answer cannot bring back withdrawn words.
  let readToken = 0;
  const submitAttempt = attempts();
  const withdrawAttempt = attempts();

  const placeSelect = el('select');
  const text = el('textarea', { rows: 6, maxLength: TEXT_LIMIT });
  const period = el('input', { type: 'text', maxLength: PERIOD_LIMIT });
  const grants = Object.fromEntries(Object.keys(PERMISSION_LABELS).map((key) => [key, el('input', { type: 'checkbox' })]));
  const send = el('button', { type: 'button', textContent: 'Send recollection' });
  const message = el('p', { className: 'form-message', role: 'alert' });
  const status = el('p', { className: 'hint', role: 'status' });
  const own = el('ul', { className: 'collab-list' });
  const form = el('div', { hidden: true }, [
    field('What you remember about this place', text, 'Your words are kept exactly as you write them. The owner may use them to adjust the scene by hand; nothing reads meaning from them automatically, and nothing here is checked as historical fact.'),
    field('When this was, as you remember it (optional)', period, 'Kept as your own words. It is not turned into a date.'),
    el('fieldset', { className: 'source-permissions' }, [
      el('legend', { textContent: 'Allowed uses' }),
      ...Object.entries(PERMISSION_LABELS).map(([key, label]) => el('label', {}, [grants[key], ` ${label}`])),
    ]),
    el('div', { className: 'actions' }, [send]),
    message,
    el('h2', { textContent: 'What you have sent' }),
    el('p', { className: 'hint', textContent: 'You see what happened to each recollection. The owner’s private review notes are not shared with you.' }),
    status,
    own,
  ]);

  container.replaceChildren(
    el('section', { className: 'panel collab' }, [
      el('h1', { textContent: 'Add your recollection' }),
      field('Place', placeSelect),
      form,
    ]),
  );

  const scope = () => `/api/drafts/${place.draftId}/reconstructions/${place.jobId}`;

  function renderOwn(contributions) {
    own.replaceChildren(
      ...contributions.map((contribution) => {
        const item = el('li', {}, [
          el('p', { className: 'collab-status', textContent: contributionStatusText(contribution) }),
          contribution.text === null
            ? el('p', { className: 'hint', textContent: 'The text is no longer shown.' })
            : el('p', { className: 'memory-text', textContent: contribution.text }),
        ]);
        if (contribution.periodClaim) item.append(el('p', { className: 'hint', textContent: `Time as you remember it: ${contribution.periodClaim}` }));
        item.append(el('p', { className: 'hint', textContent: usesText(contribution) }));
        if (contribution.status !== 'withdrawn') item.append(withdrawControl(contribution));
        return item;
      }),
    );
    status.textContent = contributions.length ? '' : 'Nothing sent yet.';
  }

  // Withdrawal takes two presses: it hides the words and blocks every scene
  // that used them.
  function withdrawControl(contribution) {
    const wrap = el('div', { className: 'actions' });
    const start = el('button', { type: 'button', className: 'secondary', textContent: 'Withdraw' });
    start.addEventListener('click', () => {
      const confirm = el('button', { type: 'button', textContent: 'Withdraw this recollection' });
      const cancel = el('button', { type: 'button', className: 'secondary', textContent: 'Keep it' });
      cancel.addEventListener('click', () => wrap.replaceChildren(start));
      confirm.addEventListener('click', () => withdraw(contribution, confirm));
      wrap.replaceChildren(
        el('p', {
          className: 'hint',
          textContent:
            'Rehere will stop showing and using these words, and any scene that depends on them will be blocked. Copies someone already saved outside Rehere cannot be removed from here.',
        }),
        cancel,
        confirm,
      );
    });
    wrap.append(start);
    return wrap;
  }

  async function withdraw(contribution, button) {
    const mine = generation;
    const target = place;
    readToken += 1;
    const body = withdrawAttempt.prepare(contribution.id, {}, () => ({ requestId: crypto.randomUUID() }));
    button.disabled = true;
    const result = await postJson(`${scope()}/contributions/${contribution.id}/withdraw`, body);
    if (disposed || mine !== generation || place !== target) return;
    button.disabled = false;
    if (unclear(result)) {
      message.textContent = withReason(result, 'Rehere could not confirm the withdrawal. Pressing it again repeats the same request.');
      return;
    }
    withdrawAttempt.settle();
    message.textContent = result.ok
      ? 'Withdrawn. Rehere no longer shows or uses these words, and scenes that depended on them are blocked.'
      : reasonOf(result) || 'The recollection could not be withdrawn.';
    await loadOwn();
  }

  async function loadOwn() {
    const mine = generation;
    const target = place;
    const token = ++readToken;
    const result = await request(`${scope()}/collaboration`);
    if (disposed || mine !== generation || place !== target || token !== readToken) return;
    if (!result.ok || !Array.isArray(result.body?.contributions)) {
      status.textContent = 'Your recollections could not be loaded. Try again later.';
      return;
    }
    renderOwn(result.body.contributions);
  }

  function choose(next) {
    generation += 1;
    place = next;
    // A send still pending for the previous place no longer holds this form.
    send.disabled = false;
    message.textContent = '';
    form.hidden = !place;
    own.replaceChildren();
    if (place) loadOwn();
  }

  placeSelect.addEventListener('change', () => choose(placesById.get(placeSelect.value) ?? null));
  send.addEventListener('click', async () => {
    if (!place) return;
    const input = {
      text: text.value,
      periodClaim: period.value,
      permissions: Object.fromEntries(Object.entries(grants).map(([key, box]) => [key, box.checked === true])),
    };
    const problem = submissionProblem(input);
    if (problem) {
      message.textContent = problem;
      return;
    }
    const mine = generation;
    const target = place;
    const body = submitAttempt.prepare(`${target.draftId}/${target.jobId}`, input, () => ({ requestId: crypto.randomUUID(), ...input }));
    send.disabled = true;
    readToken += 1;
    const result = await postJson(`${scope()}/contributions`, body);
    if (disposed || mine !== generation || place !== target) return;
    send.disabled = false;
    if (unclear(result)) {
      message.textContent = withReason(result, 'Rehere could not confirm whether it arrived. Your text is still here; sending again repeats the same request.');
      return;
    }
    submitAttempt.settle();
    if (!result.ok) {
      message.textContent = reasonOf(result) || 'The recollection could not be sent.';
      return;
    }
    text.value = '';
    period.value = '';
    for (const box of Object.values(grants)) box.checked = false;
    message.textContent = 'Sent. The owner decides whether and how to use it.';
    await loadOwn();
  });

  const placesById = new Map();
  (async () => {
    const result = await request('/api/contributor/places');
    if (disposed) return;
    if (!result.ok || !Array.isArray(result.body)) {
      placeSelect.replaceChildren(el('option', { value: '', textContent: 'Places could not be loaded' }));
      return;
    }
    for (const entry of result.body) placesById.set(`${entry.draftId}/${entry.jobId}`, entry);
    placeSelect.replaceChildren(
      el('option', { value: '', textContent: result.body.length ? 'Choose a place' : 'No scene is ready yet' }),
      ...result.body.map((entry) => el('option', { value: `${entry.draftId}/${entry.jobId}`, textContent: entry.label })),
    );
    if (result.body.length === 1) {
      placeSelect.value = `${result.body[0].draftId}/${result.body[0].jobId}`;
      choose(result.body[0]);
    }
  })();

  return {
    dispose() {
      disposed = true;
      generation += 1;
      container.replaceChildren();
    },
  };
}

// ---------------------------------------------------------------- invitations

// Owner-only invitations for one place. The one-use code is generated here and
// kept in memory until the owner closes it; it never goes into a URL or
// storage.
export function mountInvitations(container, { draftId }) {
  let disposed = false;
  const createAttempt = attempts();
  const list = el('ul', { className: 'collab-list' });
  const hours = select([[1, '1 hour'], [24, '1 day'], [72, '3 days']].map(([value, text]) => [String(value), text]), '24');
  const create = el('button', { type: 'button', className: 'secondary', textContent: 'Create an invitation' });
  const issued = el('div');
  const message = el('p', { className: 'form-message', role: 'alert' });

  container.replaceChildren(
    el('details', { className: 'source-details collab-invitations' }, [
      el('summary', { textContent: 'Invite someone to add a recollection' }),
      el('p', {
        className: 'hint',
        textContent:
          'An invitation lets one person join once and add written recollections to this place only. Share the code privately. It works only for someone who can reach this computer’s Rehere address; nothing is published on the internet.',
      }),
      field('Expires after', hours),
      el('div', { className: 'actions' }, [create]),
      issued,
      message,
      list,
    ]),
  );

  async function loadList() {
    const result = await request('/api/invitations');
    if (disposed) return;
    if (!result.ok || !Array.isArray(result.body)) {
      message.textContent = 'Invitations could not be loaded.';
      return;
    }
    list.replaceChildren(
      ...result.body
        .filter((invite) => invite.draftId === draftId)
        .map((invite) => {
          const when = new Date(invite.expiresAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
          const item = el('li', {}, [el('span', { textContent: `${{ active: 'Unused', redeemed: 'Used', revoked: 'Revoked', expired: 'Expired' }[invite.status] ?? invite.status} · expires ${when}` })]);
          if (invite.status === 'active') {
            const revoke = el('button', { type: 'button', className: 'secondary', textContent: 'Revoke' });
            revoke.addEventListener('click', async () => {
              revoke.disabled = true;
              const result = await postJson(`/api/invitations/${invite.id}/revoke`, {});
              if (disposed) return;
              revoke.disabled = false;
              message.textContent = result.ok
                ? 'Revoked. Anyone who already joined keeps their own recollections and can still withdraw them.'
                : withReason(result, 'The invitation could not be revoked.');
              await loadList();
            });
            item.append(revoke);
          }
          return item;
        }),
    );
  }

  create.addEventListener('click', async () => {
    const input = { expiresInHours: Number(hours.value) };
    const body = createAttempt.prepare(draftId, input, () => ({ requestId: crypto.randomUUID(), draftId, ...input, token: invitationToken() }));
    hours.disabled = true;
    create.disabled = true;
    const result = await postJson('/api/invitations', body);
    if (disposed) return;
    create.disabled = false;
    if (unclear(result)) {
      message.textContent = withReason(result, 'Rehere could not confirm the invitation. Pressing Create again repeats the same request with the same code.');
      return;
    }
    createAttempt.settle();
    hours.disabled = false;
    if (!result.ok) {
      message.textContent = reasonOf(result) || 'The invitation could not be created.';
      return;
    }
    message.textContent = '';
    const done = el('button', { type: 'button', className: 'secondary', textContent: 'I have shared it' });
    done.addEventListener('click', () => issued.replaceChildren());
    issued.replaceChildren(
      el('div', { className: 'access-keys' }, [
        el('p', { textContent: 'Invitation code. It is shown only now and works once:' }),
        el('div', { className: 'access-key' }, [el('code', { textContent: body.token })]),
        done,
      ]),
    );
    await loadList();
  });

  loadList();
  return {
    dispose() {
      disposed = true;
      container.replaceChildren();
    },
  };
}

// ---------------------------------------------------------------- owner review

// The owner's panel inside a ready scene. bridge: { jobUrl, editor(),
// showTransform(transform|null) -> boolean (true only when the 3D view drew
// it), setLocked(boolean), saved(edit), unconfirmed(), conflict(), blocked() }.
// blocked() is called once when a refresh finds the current scene blocked, so
// the scene that depends on a withdrawn recollection stops being shown.
export function mountCollaboration(container, bridge) {
  let disposed = false;
  let state = null;
  let readToken = 0;
  let selectedId = null;
  let busy = false;
  // What the viewer is temporarily showing: a review candidate or a saved
  // alternative. Only one at a time; cleared before anything else is shown.
  let showing = null;
  let blockedReported = false;
  const reviewAttempt = attempts();
  const eraAttempt = attempts();
  // Forms are kept while their record is unchanged, so typed input and a
  // prepared retry survive refreshes and editor state changes.
  let reviewForm = null;
  const eraForms = new Map();

  const status = el('p', { className: 'hint', role: 'status' });
  const message = el('p', { className: 'form-message', role: 'alert' });
  const list = el('ul', { className: 'collab-list' });
  const review = el('div', { className: 'collab-review' });
  const compare = el('div', { className: 'collab-compare' });
  const refreshButton = el('button', { type: 'button', className: 'secondary', textContent: 'Refresh', onclick: () => refresh() });

  container.replaceChildren(
    el('h4', { textContent: 'Recollections from others' }),
    el('p', {
      className: 'hint',
      textContent:
        'These are people’s own recollections, kept as written. They are separate from what the photo shows and from the model’s reconstruction, and none of them is checked as historical fact. Any change to the scene is one you set by hand.',
    }),
    el('div', { className: 'actions access-links' }, [refreshButton]),
    status,
    message,
    list,
    review,
    el('h4', { textContent: 'Compare saved scenes' }),
    compare,
  );

  function stopShowing() {
    if (!showing) return;
    showing = null;
    bridge.showTransform(null);
    bridge.setLocked(busy);
    if (state) renderCompare();
  }

  function show(kind, id, transform) {
    stopShowing();
    const drawn = bridge.showTransform(transform);
    showing = { kind, id, transform, drawn };
    bridge.setLocked(true);
    if (state) renderCompare();
    return drawn;
  }

  const contribution = () => state?.contributions.find((entry) => entry.id === selectedId) ?? null;
  const variantLabel = (id) => state?.variants.find((variant) => variant.id === id)?.label ?? 'another scene';

  function render() {
    if (disposed || !state) return;
    list.replaceChildren(
      ...state.contributions.map((entry) => {
        const pick = el('button', { type: 'button', className: 'secondary', textContent: entry.id === selectedId ? 'Selected' : 'Review', disabled: entry.id === selectedId });
        pick.addEventListener('click', () => {
          stopShowing();
          selectedId = entry.id;
          message.textContent = '';
          render();
        });
        const item = el('li', {}, [
          el('p', { className: 'collab-status' }, [el('strong', { textContent: providerName(entry) }), ` · ${contributionStatusText(entry)}`]),
          entry.text === null
            ? el('p', { className: 'hint', textContent: 'Withdrawn by the person who wrote it. The text is no longer shown or used.' })
            : el('p', { className: 'memory-text', textContent: entry.text }),
        ]);
        if (entry.periodClaim && entry.text !== null) item.append(el('p', { className: 'hint', textContent: `Time as they remember it (their words, not checked): ${entry.periodClaim}` }));
        item.append(el('p', { className: 'hint', textContent: usesText(entry) }));
        // Only what the owner actually recorded; nothing for a withdrawn entry.
        const notes = [];
        if (entry.status !== 'withdrawn' && entry.review?.reason) notes.push(`Your note: ${entry.review.reason}`);
        if (entry.status !== 'withdrawn' && CONFLICTS[entry.review?.conflict]) notes.push(`Possible reason for a difference: ${CONFLICTS[entry.review.conflict]}`);
        if (notes.length) item.append(el('p', { className: 'hint', textContent: notes.join(' · ') }));
        if (!FINAL.has(entry.status)) item.append(pick);
        return item;
      }),
    );
    status.textContent = state.contributions.length ? '' : 'No recollections yet.';
    renderReview();
    renderCompare();
  }

  function renderReview() {
    const entry = contribution();
    if (!entry || FINAL.has(entry.status)) {
      reviewForm = null;
      review.replaceChildren();
      return;
    }
    if (reviewForm && reviewForm.id === entry.id && reviewForm.revision === entry.revision && reviewForm.status === entry.status) {
      reviewForm.refreshControls();
      return;
    }
    const editor = bridge.editor();
    const decision = select(DECISIONS.map((value) => [value, DECISION_LABELS[value]]), 'reviewing');
    const reason = el('textarea', { rows: 2, maxLength: REASON_LIMIT });
    const conflict = select(Object.entries(CONFLICTS), 'unknown');
    const axes = ['Left / right', 'Down / up', 'Away / toward', 'Turn (degrees)'];
    const values = [...editor.offset, Math.round((editor.yaw * 180) / Math.PI)];
    const inputs = axes.map((name, i) => {
      const input = el('input', { type: 'number', step: i === 3 ? 1 : 0.01, min: i === 3 ? -180 : -OFFSET_LIMIT, max: i === 3 ? 180 : OFFSET_LIMIT, value: String(values[i]) });
      input.setAttribute('aria-label', `Candidate ${name}`);
      return input;
    });
    const candidateBox = el('fieldset', { className: 'space-edit', hidden: true }, [
      el('legend', { textContent: 'Candidate position, set by hand' }),
      el('p', { className: 'hint', textContent: 'Set where the object would be if this recollection is right. Rehere does not read a position from the words.' }),
      ...inputs.map((input, i) => el('div', { className: 'space-axis' }, [el('span', { textContent: axes[i] }), input])),
    ]);
    const preview = el('button', { type: 'button', className: 'secondary', textContent: 'Preview candidate on the scene' });
    const save = el('button', { type: 'button', textContent: 'Save decision' });
    const note = el('p', { className: 'hint' });

    const candidate = () => {
      const numbers = inputs.map((input) => (input.value.trim() === '' ? NaN : Number(input.value)));
      return { offset: numbers.slice(0, 3), yaw: (numbers[3] * Math.PI) / 180 };
    };
    const geometry = () => decision.value === 'adopt' || decision.value === 'alternative';
    const previewed = () => showing?.kind === 'candidate' && showing.drawn && sameJson(showing.transform, candidate());
    const refreshControls = () => {
      const editorNow = bridge.editor();
      candidateBox.hidden = !geometry();
      preview.hidden = !geometry();
      let reasonText = '';
      if (geometry()) {
        if (entry.permissions?.place !== true) reasonText = 'This recollection does not allow use to reconstruct the place, so it cannot change the scene. You can hold or decline it.';
        else if (state.blocked) reasonText = 'The current scene depends on a withdrawn recollection. Restore an unaffected saved version first.';
        else if (!editorNow.clean && !showing) reasonText = 'Save or revert your manual change, or finish the memory proposal, first.';
        else if (transformProblem(candidate())) reasonText = transformProblem(candidate());
        else if (!previewed()) reasonText = showing?.kind === 'candidate' && !showing.drawn
          ? 'The 3D view is not available, so the candidate could not be previewed. Without a preview it cannot be adopted or kept; you can hold or decline it.'
          : 'Preview the candidate on the scene before saving it.';
      }
      note.textContent = reasonText;
      preview.disabled = busy || entry.permissions?.place !== true || Boolean(state.blocked) || Boolean(transformProblem(candidate())) || (!editorNow.clean && showing?.kind !== 'candidate');
      save.disabled = busy || (geometry() && Boolean(reasonText));
    };

    decision.addEventListener('change', () => {
      if (!geometry()) stopShowing();
      refreshControls();
    });
    for (const input of inputs) {
      input.addEventListener('input', () => {
        if (showing?.kind === 'candidate' && !transformProblem(candidate())) show('candidate', entry.id, candidate());
        refreshControls();
      });
    }
    preview.addEventListener('click', () => {
      show('candidate', entry.id, candidate());
      refreshControls();
    });
    save.addEventListener('click', async () => {
      const input = {
        decision: decision.value,
        reason: reason.value,
        conflict: conflict.value,
        transform: geometry() ? candidate() : null,
        baseVersion: bridge.editor().version,
        baseRevision: entry.revision,
      };
      if (reason.value.length > REASON_LIMIT) {
        message.textContent = `Keep the note to ${REASON_LIMIT} characters or fewer.`;
        return;
      }
      const body = reviewAttempt.prepare(entry.id, input, () => ({ requestId: crypto.randomUUID(), ...input }));
      await mutate(async () => {
        const result = await postJson(`${bridge.jobUrl}/contributions/${entry.id}/review`, body);
        if (disposed) return;
        if (unclear(result)) {
          if (input.decision === 'adopt') bridge.unconfirmed();
          message.textContent = withReason(result, 'Rehere could not confirm the decision. Saving again repeats the same request.');
          return;
        }
        reviewAttempt.settle();
        if (!result.ok) {
          if (result.status === 409 && input.decision === 'adopt') bridge.conflict();
          message.textContent = `${reasonOf(result) || 'The decision could not be saved.'} Nothing was changed by this attempt.`;
          return;
        }
        stopShowing();
        if (result.body?.edit) bridge.saved(result.body.edit);
        message.textContent = {
          adopt: 'Adopted. The current scene was saved as a new version that depends on this recollection.',
          alternative: 'Kept as a separate alternative. The current scene did not change.',
        }[input.decision] ?? 'Decision saved. The scene did not change.';
      });
    });

    review.replaceChildren(
      el('h4', { textContent: `Review ${providerName(entry)}’s recollection` }),
      field('Decision', decision),
      field('Your note (optional)', reason),
      field('Possible reason for a difference', conflict, 'A label for your own review. It does not decide which account is right or set a time.'),
      candidateBox,
      note,
      el('div', { className: 'actions' }, [preview, save]),
    );
    reviewForm = { id: entry.id, revision: entry.revision, status: entry.status, refreshControls };
    refreshControls();
  }

  function renderCompare() {
    const editor = bridge.editor();
    const choices = el('ul', { className: 'collab-list' });
    // Says exactly what the viewer draws: the saved scene only when nothing
    // temporary is shown.
    const shownNow = !showing
      ? null
      : showing.kind === 'candidate'
        ? 'a review candidate set by hand. It is not saved.'
        : `“${variantLabel(showing.id)}”. The current saved scene is unchanged.`;
    const current = el('li', {}, [
      el('span', { textContent: `Current saved scene, version ${editor.version}${showing ? ' (not shown)' : ' (shown)'}` }),
    ]);
    if (shownNow && showing.drawn) current.append(el('span', { className: 'hint', textContent: `Shown on the scene now: ${shownNow}` }));
    if (showing?.kind === 'variant') current.append(el('button', { type: 'button', className: 'secondary', textContent: 'Back to the current scene', onclick: () => { stopShowing(); render(); } }));
    choices.append(current);
    for (const variant of state.variants) {
      const item = el('li', {}, [el('span', { className: 'space-choice-label', textContent: variant.label })]);
      // A blocked alternative's details are redacted by the server; only its
      // label and the reason it cannot be used are shown.
      if (variant.blocked) {
        item.append(
          el('span', { className: 'hint', textContent: 'Blocked: it depends on a withdrawn recollection or a use that is not allowed.' }),
          el('span', { className: 'hint', textContent: 'Time details withheld after withdrawal.' }),
        );
      }
      else {
        item.append(el('span', { className: 'hint', textContent: `${describeEra(variant.era, variantLabel)} · ${formatTransform(variant.edit)}` }));
        const isShown = showing?.kind === 'variant' && showing.id === variant.id;
        const view = el('button', { type: 'button', className: 'secondary', textContent: isShown ? 'Shown' : 'Show on the scene', disabled: isShown || busy || (!bridge.editor().clean && !showing) });
        view.addEventListener('click', () => {
          if (!bridge.editor().clean && !showing) return;
          const drawn = show('variant', variant.id, variant.edit);
          message.textContent = drawn ? `Showing “${variant.label}”. The saved scene is unchanged.` : 'The 3D view is not available, so this alternative cannot be shown here.';
          render();
        });
        const cached = eraForms.get(variant.id);
        const form = cached?.eraRevision === variant.eraRevision ? cached.node : eraControl(variant);
        eraForms.set(variant.id, { eraRevision: variant.eraRevision, node: form });
        item.append(view, form);
      }
      choices.append(item);
    }
    compare.replaceChildren(choices);
  }

  function eraControl(variant) {
    const wrap = el('details', { className: 'source-details' }, [el('summary', { textContent: 'Record when this was' })]);
    const kind = select([['unknown', 'Unknown'], ['exact', 'A date'], ['range', 'A date range'], ['relative', 'Relative to something']], variant.era?.kind ?? 'unknown');
    const label = el('input', { type: 'text', maxLength: ERA_LABEL_LIMIT, value: variant.era?.label ?? '' });
    const start = el('input', { type: 'date', value: variant.era?.start ?? '' });
    const end = el('input', { type: 'date', value: variant.era?.end ?? '' });
    const others = state.variants.filter((other) => other.id !== variant.id);
    const relation = select([['', 'No comparison'], ['before', 'Before'], ['after', 'After'], ['same-time', 'Same time as']], variant.era?.relation ?? '');
    const relativeTo = select([['', 'Choose a scene'], ...others.map((other) => [other.id, other.label])], variant.era?.relativeToVariantId ?? '');
    const statement = el('textarea', { rows: 2, maxLength: ERA_STATEMENT_LIMIT });
    const confirmed = el('input', { type: 'checkbox' });
    const save = el('button', { type: 'button', textContent: 'Save time assertion' });
    const note = el('p', { className: 'form-message', role: 'alert' });
    save.addEventListener('click', async () => {
      const value = {
        kind: kind.value,
        label: kind.value === 'unknown' ? '' : label.value,
        start: ['exact', 'range'].includes(kind.value) ? start.value : null,
        end: kind.value === 'range' ? end.value : kind.value === 'exact' ? start.value : null,
        relation: kind.value === 'relative' && relation.value ? relation.value : null,
        relativeToVariantId: kind.value === 'relative' && relation.value ? relativeTo.value || null : null,
        statement: statement.value,
        confirmed: kind.value === 'unknown' ? false : confirmed.checked,
      };
      const problem = eraProblem(value);
      if (problem) {
        note.textContent = problem;
        return;
      }
      const input = { ...value, baseRevision: variant.eraRevision };
      const body = eraAttempt.prepare(variant.id, input, () => ({ requestId: crypto.randomUUID(), ...input }));
      await mutate(async () => {
        const result = await postJson(`${bridge.jobUrl}/variants/${variant.id}/era`, body);
        if (disposed) return;
        if (unclear(result)) {
          note.textContent = withReason(result, 'Rehere could not confirm this. Saving again repeats the same request.');
          return;
        }
        eraAttempt.settle();
        note.textContent = result.ok ? '' : reasonOf(result) || 'The time could not be saved.';
        if (result.ok) message.textContent = 'Saved as your assertion. Earlier assertions are kept, and no order between scenes was inferred.';
      });
    });
    wrap.append(
      el('p', { className: 'hint', textContent: 'This is your own assertion as the owner, kept separately from what contributors wrote. Same-time alternatives stay side by side; no order is inferred.' }),
      field('Kind', kind),
      field('Description', label),
      field('Date, or start of the range', start),
      field('End of the range', end),
      field('Compared with another scene', relation),
      field('Other scene', relativeTo),
      field('What this is based on', statement),
      el('label', { className: 'memory-consent' }, [confirmed, ' I assert this time myself; it is not verified']),
      el('div', { className: 'actions' }, [save]),
      note,
    );
    return wrap;
  }

  // Runs one write with the manual editor locked; reads started before it are
  // dropped and a fresh read follows.
  async function mutate(run) {
    busy = true;
    readToken += 1;
    bridge.setLocked(true);
    reviewForm?.refreshControls();
    try {
      await run();
    } finally {
      if (!disposed) {
        busy = false;
        bridge.setLocked(Boolean(showing));
        refresh();
      }
    }
  }

  async function refresh() {
    const token = ++readToken;
    const result = await request(`${bridge.jobUrl}/collaboration`);
    if (disposed || token !== readToken) return;
    if (!result.ok || !Array.isArray(result.body?.contributions) || !Array.isArray(result.body?.variants)) {
      status.textContent = 'Recollections could not be loaded. Try Refresh.';
      return;
    }
    state = result.body;
    if (showing?.kind === 'variant' && !state.variants.some((variant) => variant.id === showing.id && !variant.blocked)) stopShowing();
    const candidateSource = showing?.kind === 'candidate' ? state.contributions.find((entry) => entry.id === showing.id) : null;
    if (showing?.kind === 'candidate' && (!candidateSource || FINAL.has(candidateSource.status))) stopShowing();
    if (state.blocked) {
      stopShowing();
      if (!blockedReported) {
        blockedReported = true;
        bridge.blocked?.();
        if (disposed) return;
      }
    }
    render();
  }

  refresh();
  return {
    refresh,
    // Re-renders controls that depend on the manual editor's state.
    sync() {
      reviewForm?.refreshControls();
    },
    dispose() {
      disposed = true;
      readToken += 1;
      if (showing) {
        showing = null;
        bridge.showTransform(null);
        bridge.setLocked(false);
      }
      container.replaceChildren();
    },
  };
}

// ---------------------------------------------------------------- blocked scene

// Shown instead of a scene whose current version depends on a withdrawn
// recollection. The only way forward offered is restoring a saved version that
// does not depend on it; that saves a new version.
export function mountBlockedScene(container, { jobUrl, currentVersion, onRestored }) {
  let disposed = false;
  const restoreAttempt = attempts();
  const message = el('p', { className: 'form-message', role: 'alert' });
  const list = el('ul', { className: 'collab-list' });
  container.replaceChildren(
    el('p', {
      textContent:
        'This scene depends on a recollection that was withdrawn, or on a use that is no longer allowed, so it is not shown. Its saved history is kept. Restore a saved version that does not depend on it to continue.',
    }),
    list,
    message,
  );

  (async () => {
    const result = await request(`${jobUrl}/history`);
    if (disposed) return;
    if (!result.ok || !Array.isArray(result.body)) {
      message.textContent = 'The saved versions could not be loaded.';
      return;
    }
    const usable = result.body.filter((entry) => entry.version !== currentVersion && entry.blocked === false).sort((a, b) => b.version - a.version);
    if (!usable.length) message.textContent = 'No saved version without this dependency was found.';
    list.replaceChildren(
      ...usable.map((entry) => {
        const restore = el('button', { type: 'button', className: 'secondary', textContent: `Restore version ${entry.version}` });
        restore.addEventListener('click', async () => {
          const body = restoreAttempt.prepare(entry.version, { targetVersion: entry.version }, () => ({ requestId: crypto.randomUUID(), baseVersion: currentVersion, targetVersion: entry.version }));
          restore.disabled = true;
          const outcome = await postJson(`${jobUrl}/undo`, body);
          if (disposed) return;
          restore.disabled = false;
          if (unclear(outcome)) {
            message.textContent = withReason(outcome, 'Rehere could not confirm the restore. Pressing it again repeats the same request.');
            return;
          }
          restoreAttempt.settle();
          if (!outcome.ok) {
            message.textContent = reasonOf(outcome) || 'That version could not be restored.';
            return;
          }
          onRestored();
        });
        return el('li', {}, [el('span', { textContent: `Version ${entry.version}: ${formatTransform(entry)}` }), restore]);
      }),
    );
  })();

  return {
    dispose() {
      disposed = true;
      container.replaceChildren();
    },
  };
}
