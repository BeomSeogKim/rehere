// Memory-driven change proposals for one ready reconstruction. A person's
// statement goes to the server, which asks Meta for a proposal; the proposal is
// shown as a preview and changes the saved scene only through an explicit
// Apply that the server confirms. The browser never computes a transform.

import { isComposition } from './composition-scene.js';
import { compositionDifference, describeComposition } from './composition-description.js';
import { withObject } from './arrangement.js';
import { OBJECT_IDS } from './photo-scene.js';

export const TEXT_LIMIT = 2000;
const POLL_MS = 2000;
const ACTIVE = new Set(['queued', 'processing']);

// Hosted planning needs both grants and, in this development stage, a source
// marked public.
export function proposalBlockedReason(source) {
  if (!source) return 'This photo has no source details, so no uses were granted and it cannot be sent to Meta.';
  if (source.permissions?.place !== true || source.permissions?.model !== true) {
    return 'Planning from a memory needs “Use to reconstruct this place” and “Use for model processing” for this photo.';
  }
  if (source.origin?.kind !== 'public') {
    return 'In this development version, only photos saved as a public source can be sent to Meta.';
  }
  return null;
}

const GRANTS = [['place', '“Use to reconstruct this place”'], ['model', '“Use for model processing”']];

// The facts behind one blocked photo, from its own record only.
function blockedFacts(source) {
  if (!source) return 'Its source details are not available here, so no specific recommendation can be made.';
  const off = GRANTS.filter(([key]) => source.permissions?.[key] !== true).map(([, name]) => name);
  const facts = [];
  if (off.length) facts.push(`Not currently allowed: ${off.join(' and ')}.`);
  if (source.origin?.kind !== 'public') facts.push('Its saved origin is not recorded as a public source.');
  return facts.join(' ');
}

// Shown once after the per-photo list. A public label creates no rights.
const RECOVERY = 'A saved use can only be narrowed, never broadened, and a public label creates no rights and does not make a photo public. If you genuinely have different material whose provider can truthfully allow the needed uses and whose actual origin is public, you may save it as a new memory with those uses allowed, then build a scene there. That is a separate place: this place’s scene, recollections, stories and visitor links are not moved or unblocked, and photos from the new place cannot be combined with photos here.';

// The object a two-object proposal was planned for: the stored request's
// target, or the plan's own when only that is given.
const targetOf = (proposal) => proposal?.targetId ?? proposal?.result?.targetId ?? null;

export function formatTransform(transform) {
  if (transform.position) return `owner position ${transform.position.map((n) => n.toFixed(2)).join(', ')}, orientation ${transform.quaternion.map((n) => n.toFixed(3)).join(', ')}, assumed relative scale ${transform.scale.toFixed(2)}`;
  const { offset, yaw } = transform;
  const [x, y, z] = offset.map((value) => value.toFixed(2));
  return `left/right ${x}, down/up ${y}, away/toward ${z}, turn ${Math.round((yaw * 180) / Math.PI)}°`;
}

export function proposalTitle(result) {
  switch (result?.action) {
    case 'translate':
      return 'Move the selected object';
    case 'rotate':
      return 'Turn the selected object';
    case 'face_object':
      return 'Turn the chosen photographed side toward the other object in the owner composition';
    case 'face_anchor':
      return `Turn the side of the selected object seen in the photo toward “${result.anchor?.label ?? ''}”`;
    default:
      return 'No change proposed';
  }
}

export function proposalStatusText(proposal) {
  switch (proposal.status) {
    case 'queued':
      return 'Waiting to send your memory to Meta.';
    case 'processing':
      return 'Meta is reading your memory and the photo.';
    case 'ready':
      return 'A change is proposed. Nothing has changed yet.';
    case 'clarify':
      return 'Meta needs more detail before proposing a change.';
    case 'failed':
      return `No change was proposed. ${proposal.error || 'The request did not finish.'}`;
    case 'canceled':
      return 'Canceled. Nothing was changed.';
    case 'stale':
      return 'This proposal was made for an older saved version and can no longer be applied. Plan again.';
    case 'applied':
      return `This proposal was applied as version ${proposal.appliedVersion}.`;
    case 'interrupted':
      return 'Interrupted before it finished. Nothing was changed; any cost already counted remains counted.';
    default:
      return 'Status unknown.';
  }
}

// The server redacts a proposal whose scene can no longer be used (for
// example it depends on a withdrawn or unavailable recollection): its words,
// result and question are no longer available.
export const isRedacted = (proposal) => proposal.redacted === true || typeof proposal.statement?.text !== 'string';
export const REDACTED_TEXT = 'This saved proposal is no longer shown, because the scene it was made for can no longer be used.';

const STATUS_SHORT = {
  queued: 'Waiting to send',
  processing: 'Being planned',
  ready: 'Proposed change',
  clarify: 'Needs more detail',
  failed: 'No change proposed',
  canceled: 'Canceled',
  stale: 'For an older version',
  interrupted: 'Interrupted',
};
const shortStatus = (proposal) => (proposal.status === 'applied' ? `Applied as version ${proposal.appliedVersion}` : STATUS_SHORT[proposal.status] ?? 'Status unknown');
const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const timeText = (value) => (validTime(value) ? new Date(value).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : 'Time unknown');
// A short start of the person's own words, cut at a word boundary.
function excerpt(text) {
  const words = text.replace(/\s+/g, ' ').trim();
  if (words.length <= 60) return words;
  const cut = words.slice(0, 60);
  return `${(cut.lastIndexOf(' ') > 30 ? cut.slice(0, cut.lastIndexOf(' ')) : cut).trimEnd()}…`;
}

export function historyLabel(entry) {
  if (entry.kind === 'initial') return isComposition(entry) ? 'Initial owner-assumed layout' : 'Original position';
  if (entry.kind === 'manual') return 'Manual change';
  if (entry.kind === 'proposal') return 'Change from a memory';
  if (entry.kind === 'contribution') return 'Change from a recollection';
  if (entry.kind === 'undo') return `Return to version ${entry.targetVersion}`;
  return 'Change';
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

async function request(url, options) {
  try {
    const response = await fetch(url, options);
    const body = await response.json().catch(() => null);
    return { status: response.status, ok: response.ok, body };
  } catch {
    return { status: 0, ok: false, body: null };
  }
}

const postJson = (url, payload) =>
  request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
const unclear = (result) => result.status === 0 || result.status >= 500;
const serverError = (result, fallback) => (typeof result.body?.error === 'string' ? result.body.error : fallback);
// A 5xx keeps replay protection because the outcome may still be unknown, but
// a reason the server did give (for example that planning is not set up) is
// shown ahead of the generic note.
const reasonOf = (result) => (typeof result.body?.error === 'string' ? result.body.error.trim() : '');
const withReason = (result, note) => (reasonOf(result) ? `${reasonOf(result)} ${note}` : note);

// bridge: { jobUrl, textureUrl, source, editor(), showTransform(edit|null),
// setLocked(boolean), saved(edit), unconfirmed(), conflict(), targets?,
// surfaceProblem? }. surfaceProblem(candidate) -> null | text, given only on
// two-object scenes, is the photographed-surface check for what an apply or a
// return would save (a target transform or a whole arrangement).
// editor(targetId?) returns { version, offset, yaw, clean, relationship? } for the
// manual editor's state (on two-object scenes, the saved transform of the
// object named, or of the selected one when none is named). targets, given only for two-object scenes: { selected() -> id |
// null, nameOf(id), describe(arrangement) -> text, anchorRegion([u, v]) ->
// region number | null, ruleText(rule) -> text }.
export function mountMemoryEdit(container, bridge) {
  let disposed = false;
  let current = null;
  let proposals = [];
  let history = [];
  let pollTimer = null;
  let pollingId = null;
  // Bumped whenever polling stops, so a read already in flight is dropped.
  let pollToken = 0;
  let busy = false;
  let previewing = false;
  let comparing = false;
  let comparisonView = null;
  let comparisonReadCertain = false;
  let comparisonProposal = null;
  let comparisonTrigger = null;
  let frontChecked = false;
  // The facing relation the 3D preview actually drew, or null if none.
  let guide = null;
  // Kept only while an outcome is unknown, so a retry repeats the same request.
  let planAttempt = null;
  let applyAttempt = null;
  let cancelAttempt = null;
  let undoAttempt = null;
  // Which proposal is reviewed: 'unset' until one is shown (the newest
  // planning, else the newest not applied), 'kept' while one is shown, and
  // 'removed' once the shown one left the list; nothing is then chosen for
  // the person again.
  let selection = 'unset';
  // A proposal seen redacted stays redacted here, whatever a later read says.
  const redactedIds = new Set();
  // A reviewed proposal that left a fresh list stays out of this panel, so no
  // later or late answer can bring its words or controls back.
  const removedIds = new Set();
  const hidden = (id) => redactedIds.has(id) || removedIds.has(id);
  // updatedAt only moves forward; an older answer never replaces a newer one.
  const older = (next, than) => Boolean(than) && String(next.updatedAt ?? '') < String(than.updatedAt ?? '');
  const composition = isComposition(bridge);
  const sources = bridge.geometrySources;
  // Scene-local A/B only when the bridge names the object at that position
  // with the matching letter; its free-text label and any other value are ignored.
  const sourceLabel = (index) => {
    let named;
    try {
      named = bridge.targets?.nameOf?.(OBJECT_IDS[index]);
    } catch {
      named = null;
    }
    return typeof named === 'string' && /^[AB](?::|$)/.test(named) && named[0] === 'AB'[index] ? `Source photo for object ${named[0]}` : 'A scene source photo';
  };
  const blocked = composition ? (!Array.isArray(sources) || sources.length !== 2 ? 'Both photo source records are required before planning.' : sources.map(proposalBlockedReason).find(Boolean)) : proposalBlockedReason(bridge.source);

  function blockedNotes() {
    const wellFormed = !composition || (Array.isArray(sources) && sources.length === 2);
    if (!wellFormed) return el('p', { className: 'hint', textContent: `${blocked} Which photo is affected cannot be told from what is available, so no specific recommendation can be made.` });
    const entries = composition ? sources.map((source, index) => [sourceLabel(index), source]) : [['This scene photo', bridge.source]];
    const items = entries
      .filter(([, source]) => proposalBlockedReason(source))
      .map(([name, source]) => el('li', { textContent: `${name}: ${proposalBlockedReason(source)} ${blockedFacts(source)}` }));
    const advice = entries.some(([, source]) => source && proposalBlockedReason(source));
    return el('div', {}, [
      el('p', { className: 'hint', textContent: composition ? 'Planning stays off until both source photos qualify.' : 'Planning stays off for this photo.' }),
      el('ul', { className: 'memory-blocked' }, items),
      ...(advice ? [el('p', { className: 'hint', textContent: RECOVERY })] : []),
    ]);
  }

  const text = el('textarea', { rows: 3, maxLength: TEXT_LIMIT });
  text.id = `memory-text-${Math.random().toString(36).slice(2)}`;
  const count = el('span', { textContent: '0' });
  const consent = el('input', { type: 'checkbox' });
  const plan = el('button', { type: 'button', textContent: 'Plan a change' });
  // The version whose return would change the two-object rule, once asked.
  let ruleUndoVersion = null;
  const hint = el('p', { className: 'hint' });
  const status = el('p', { className: 'hint', role: 'status' });
  status.setAttribute('aria-live', 'polite');
  const message = el('p', { className: 'form-message', role: 'alert' });
  const review = el('div', { className: 'memory-review' });
  const chooserSummary = el('summary', { textContent: 'Saved proposals' });
  const chooserNote = el('p', { className: 'hint' });
  const chooser = el('ul', { className: 'memory-proposals' });
  const chooserBox = el('details', { className: 'source-details' }, [chooserSummary, chooserNote]);
  // Owner navigation from one object's sources: the saved-proposal list can be
  // narrowed to proposals requested for that object (the exact stored request
  // target). List-only; it never chooses, previews or applies a proposal.
  const objectFilter = el('div', { className: 'object-filter' });
  chooserBox.append(objectFilter, chooser);
  let filterId = null;
  let revealToken = 0;
  let revealNote = '';
  let filterHeading = null;
  const historyList = el('ol', { className: 'memory-history', reversed: true });

  const label = el('label', { htmlFor: text.id, textContent: 'What do you remember about this object?' });
  container.replaceChildren(
    el('h4', { textContent: 'Change it from a memory' }),
    el('p', {
      className: 'hint',
      textContent:
        composition ? 'Use only public or synthetic material in this development version. Plan sends your message and metadata-free copies of both source photos to Meta. It may propose one object pose change; relative scale stays as saved. Nothing changes until you apply it.' : 'Use only public or synthetic material in this development version. When you press Plan, your message and a small copy of this photo without file metadata are sent to Meta, which proposes one change to the selected object. Nothing changes until you apply it.',
    }),
    ...(blocked
      ? [blockedNotes()]
      : [
          label,
          text,
          el('p', { className: 'hint' }, [count, ` / ${TEXT_LIMIT.toLocaleString('en-US')} characters`]),
          el('label', { className: 'memory-consent' }, [consent, composition ? ' Send this message and both source photos to Meta to propose a change' : ' Send this message and the photo to Meta to propose a change']),
          el('div', { className: 'actions' }, [plan]),
          hint,
        ]),
    status,
    message,
    chooserBox,
    review,
    el('details', { className: 'source-details' }, [el('summary', { textContent: 'Saved versions' }), historyList]),
  );

  const editorReady = () => bridge.editor().clean && !busy;

  function setPreview(on) {
    previewing = on;
    const anchor = on && current.result.action === 'face_object' ? current.result.faceObjectId : on && current.result.action === 'face_anchor' ? current.result.anchor.point : null;
    guide = bridge.showTransform(on ? current.result.transform : null, anchor, targetOf(current)) ?? null;
    if (!on) frontChecked = false;
    bridge.setLocked(on || busy || comparing);
  }

  function endComparison({ explicit = false } = {}) {
    if (!comparing) return;
    comparing = false;
    comparisonView = null;
    comparisonProposal = null;
    bridge.comparison.close({ focusHidden: !explicit && !disposed });
    if (previewing) setPreview(false);
    else bridge.setLocked(busy);
  }

  function stopPolling() {
    clearTimeout(pollTimer);
    pollTimer = null;
    pollingId = null;
    pollToken += 1;
  }

  // A replayed receipt can describe a version older than the one now saved.
  // It is reported but never adopted, so the editor cannot move backwards.
  function adopt(edit) {
    const { version } = bridge.editor();
    if (edit.version < version) {
      message.textContent = `That change was already saved as version ${edit.version}; the saved position is now version ${version}. Nothing else was changed.`;
      return false;
    }
    bridge.saved(edit);
    return true;
  }

  // Reuse a stored request only while the saved version it was built on is
  // still the saved version; after a reload or another save it is settled.
  const reusable = (attempt) => attempt && attempt.body.baseVersion === bridge.editor().version;

  const anyActive = () => Boolean(current && ACTIVE.has(current.status)) || proposals.some((proposal) => ACTIVE.has(proposal.status));
  // An unknown plan, cancel, apply or undo outcome; apply and undo only while
  // their request can still be repeated.
  const unsettled = () => Boolean(planAttempt || cancelAttempt || (applyAttempt && reusable(applyAttempt)) || (undoAttempt && reusable(undoAttempt)));
  const comparisonSource = () => bridge.comparison?.source ? bridge.comparison.source() : bridge.source;
  const singleProposalForScene = () => current?.result?.targetId === 'selected-foreground' &&
    current.result.sourceId === bridge.sourceId && current.result.baseVersion === current.baseVersion &&
    ['translate', 'rotate', 'face_anchor'].includes(current.result.action);
  const comparable = () => Boolean(bridge.comparison && !composition && !bridge.targets && !proposalBlockedReason(comparisonSource()) &&
    comparisonReadCertain && !busy && !unsettled() && bridge.comparison.available() && current &&
    (!comparing || current === comparisonProposal) &&
    current.status === 'ready' && !isRedacted(current) && current.result?.transform &&
    singleProposalForScene() &&
    current.baseVersion === bridge.editor().version && bridge.editor().clean);

  function beginComparison() {
    if (!comparable()) return;
    if (previewing) setPreview(false);
    comparing = true;
    comparisonView = 'saved';
    comparisonProposal = current;
    const opened = bridge.comparison.open({
      statement: current.statement.text,
      action: proposalTitle(current.result),
      select(view) {
        if (!comparing) return false;
        if (!comparable()) {
          endComparison();
          sync();
          return false;
        }
        comparisonView = view;
        setPreview(view === 'proposed');
        sync();
        return true;
      },
      exit() {
        endComparison({ explicit: true });
        sync();
        comparisonTrigger?.focus();
      },
    });
    if (!opened) {
      comparing = false;
      comparisonView = null;
      comparisonProposal = null;
      return;
    }
    bridge.setLocked(true);
    sync();
  }
  // Why another proposal cannot be reviewed now, or ''. Planning in progress
  // stays reachable: only planning proposals can be chosen then.
  function switchBlock(target) {
    if (busy) return 'Wait for the current action to finish before reviewing another proposal.';
    if (unsettled()) return 'Rehere could not confirm an earlier request. Repeat it, or load the saved version, before reviewing another proposal.';
    if (anyActive() && !(target && ACTIVE.has(target.status))) return 'A memory is being planned. Until it finishes or is canceled, only that planning can be reviewed.';
    return '';
  }

  // Shown with the record from the newest read; redacted ones never return.
  function guard(proposal) {
    if (isRedacted(proposal)) {
      redactedIds.add(proposal.id);
      return proposal;
    }
    if (!redactedIds.has(proposal.id)) return proposal;
    return { ...proposal, statement: { ...proposal.statement, text: null }, result: null, question: null, error: null, model: null, usage: null, redacted: true };
  }

  // Choosing is local: no request, no preview. A preview of the previous one
  // ends, so its guide and front check go with it.
  function choose(id) {
    const target = proposals.find((proposal) => proposal.id === id);
    if (!target || target.id === current?.id || switchBlock(target)) return;
    if (comparing) endComparison();
    if (previewing) setPreview(false);
    frontChecked = false;
    if (pollingId && pollingId !== id) stopPolling();
    current = target;
    selection = 'kept';
    message.textContent = '';
    status.textContent = '';
    if (ACTIVE.has(target.status)) poll(id);
    sync();
  }

  // The reviewed proposal is gone from a fresh list: nothing is reviewed and
  // nothing else is chosen in its place.
  function dropSelection() {
    removedIds.add(current.id);
    if (comparing) endComparison();
    if (previewing) setPreview(false);
    if (pollingId === current?.id) stopPolling();
    current = null;
    selection = 'removed';
    status.textContent = 'The proposal you were reviewing is no longer listed. Choose another one from the saved proposals.';
  }

  function renderChooser() {
    chooserSummary.textContent = `Saved proposals (${proposals.length})`;
    chooserNote.textContent = switchBlock(null);
    renderFilter();
    chooser.replaceChildren(
      ...(filterId ? proposals.filter((proposal) => proposal.targetId === filterId) : proposals).map((proposal) => {
        const target = bridge.targets && targetOf(proposal) ? `${bridge.targets.nameOf(targetOf(proposal)) ?? 'An object'} · ` : '';
        const label = isRedacted(proposal)
          ? `${target}${timeText(proposal.createdAt)} · ${REDACTED_TEXT}`
          : `${target}${timeText(proposal.createdAt)} · ${shortStatus(proposal)} · “${excerpt(proposal.statement.text)}”`;
        const selected = proposal.id === current?.id;
        const pick = el('button', { type: 'button', className: 'secondary', textContent: selected ? 'Reviewing' : 'Review this proposal', disabled: selected || Boolean(switchBlock(proposal)) });
        pick.setAttribute('aria-pressed', String(selected));
        pick.addEventListener('click', () => choose(proposal.id));
        return el('li', {}, [el('span', { className: 'space-choice-label', textContent: label }), pick]);
      }),
    );
  }

  function sync() {
    if (disposed) return;
    if (comparing && !comparable()) endComparison();
    // Only a shown, unredacted ready proposal can stay on the scene, whatever
    // status a record claims: a redaction ends its guide, front check and lock.
    if (previewing && (!current || current.status !== 'ready' || isRedacted(current) || !current.result?.transform)) setPreview(false);
    const editor = bridge.editor();
    const raw = text.value;
    count.textContent = raw.length.toLocaleString('en-US');
    const active = anyActive();
    const needsTarget = bridge.targets && !bridge.targets.selected();
    hint.textContent = planAttempt
      ? 'Pressing Plan repeats the earlier unconfirmed request exactly, as it was sent. Anything you changed since stays here for a new plan once that one is settled.'
      : active
      ? 'A memory is being planned. Wait for it to finish, or cancel it, before planning another.'
      : needsTarget
      ? 'Choose the object this memory is about before planning.'
      : !editor.clean
      ? 'Save or revert your manual change, or load the saved version, before planning from a memory.'
      : !raw.trim()
        ? 'Write what you remember to plan a change.'
        : !consent.checked
          ? 'Tick the box to allow sending this message and the photo to Meta.'
          : '';
    // Repeating an unconfirmed plan is always possible; it is not a new plan.
    plan.disabled = planAttempt
      ? Boolean(blocked) || busy
      : Boolean(blocked) || busy || active || needsTarget || !editorReady() || !raw.trim() || raw.length > TEXT_LIMIT || !consent.checked;
    renderChooser();
    renderReview();
    renderHistory();
  }

  function renderReview() {
    if (!current) {
      review.replaceChildren();
      return;
    }
    if (isRedacted(current)) {
      review.replaceChildren(el('p', { className: 'memory-status', textContent: REDACTED_TEXT }));
      return;
    }
    // Compared with the saved state of the plan's own object, never the one
    // chosen now; the version is the scene's.
    const editor = bridge.editor(bridge.targets ? targetOf(current) : undefined);
    // An applied proposal is a receipt: it says which version it made and, once
    // the scene has moved on, which version is saved now.
    const moved = current.status === 'applied' && current.appliedVersion !== editor.version ? ` The saved scene is now version ${editor.version}.` : '';
    const nodes = [el('p', { className: 'memory-status', textContent: `${proposalStatusText(current)}${moved}` })];
    // A stored response is reviewed as it was saved; nothing is sent again.
    if (current.status === 'ready' || current.status === 'clarify') {
      const when = validTime(current.createdAt) ? `on ${timeText(current.createdAt)}` : 'at an unknown time';
      nodes.push(el('p', { className: 'hint', textContent: `Saved response from ${current.model ?? 'an unknown model'}, requested ${when}. It was stored then; reviewing it sends nothing new.` }));
    }
    nodes.push(el('p', { className: 'memory-statement' }, [el('strong', { textContent: 'Your memory: ' }), `“${current.statement.text}”`]));
    // A plan stays with the object it was made for, whatever is chosen now.
    if (bridge.targets && targetOf(current)) nodes.push(el('p', { className: 'hint', textContent: `Planned for ${bridge.targets.nameOf(targetOf(current))}.` }));

    if (ACTIVE.has(current.status)) {
      const cancel = el('button', { type: 'button', className: 'secondary', textContent: 'Cancel planning', disabled: busy });
      cancel.addEventListener('click', cancelProposal);
      nodes.push(el('div', { className: 'actions' }, [cancel]));
    }
    const question = current.question ?? current.result?.question;
    if (current.status === 'clarify' && question) {
      nodes.push(el('p', {}, [el('strong', { textContent: 'Meta asks: ' }), question]));
      nodes.push(el('p', { className: 'hint', textContent: 'Add the missing detail to your message above and plan again.' }));
    }
    if (current.status === 'ready' && current.result?.transform) {
      const { result } = current;
      nodes.push(
        el('p', {}, [el('strong', { textContent: 'Proposal (AI suggestion): ' }), proposalTitle(result)]),
        el('p', { className: 'hint', textContent: `Reason given: ${result.reason}` }),
      );
      if (bridge.targets || composition) nodes.push(el('p', { className: 'hint', textContent: 'Photo, Saved and Proposed comparison is available only for a single-photo scene with one object.' }));
      if (composition) {
        const before = editor.arrangement;
        const after = before ? withObject(before, targetOf(current), result.transform) : null;
        nodes.push(
          el('p', { className: 'hint', textContent: `Saved now (version ${editor.version}): ${describeComposition(before, bridge.targets?.nameOf)}` }),
          ...compositionDifference(before, after, bridge.targets?.nameOf).map((entry) => el('p', { className: 'hint', textContent: `After this change: ${entry.text}` })),
        );
      } else nodes.push(
        el('p', { className: 'hint', textContent: `Saved now (version ${editor.version}): ${formatTransform(editor)}` }),
        el('p', { className: 'hint', textContent: `After this change: ${formatTransform(result.transform)}` }),
      );
      if (current.model || current.usage) {
        const cost = current.usage ? ` · estimated cost $${current.usage.estimatedUsd.toFixed(4)} (an estimate, not the bill)` : '';
        nodes.push(el('p', { className: 'hint', textContent: `Model: ${current.model ?? 'unknown'}${cost}` }));
      }
      let front = null;
      if (result.action === 'face_anchor' && result.anchor) {
        const [u, v] = result.anchor.point;
        const marker = el('span', { className: 'anchor-marker' });
        marker.style.left = `${u * 100}%`;
        marker.style.top = `${v * 100}%`;
        nodes.push(
          el('figure', { className: 'anchor-figure' }, [
            el('div', { className: 'anchor-frame' }, [
              el('img', { src: bridge.textureUrl, alt: `The photo with the proposed point “${result.anchor.label}” marked` }),
              marker,
            ]),
            el('figcaption', {
              className: 'hint',
              textContent: `Proposed point: “${result.anchor.label}”. Meta picked this point in the photo; it is a candidate, not a confirmed observation.`,
            }),
          ]),
          el('p', {
            className: 'hint',
            textContent:
              'This turns the side of the object that faced the camera in the photo. That side is not necessarily the object’s real front, especially in a photo taken at an angle.',
          }),
        );
        // On a two-object scene only a point on the background can be faced.
        const offBackground = bridge.targets && bridge.targets.anchorRegion(result.anchor.point) !== 0;
        if (offBackground) {
          nodes.push(el('p', { className: 'form-message is-error', textContent: 'The marked point is on one of the objects or on an area left unknown, so turning toward it is not supported. Refine your message instead of applying.' }));
        } else if (previewing) {
          const problem = !guide
            ? 'The 3D preview is not available, so this direction cannot be checked here and cannot be applied.'
            : !guide.readable
              ? 'The marked point is too close to the object to show a clear direction. Refine your message instead of applying.'
              : !guide.aligned
                ? 'The proposed turn does not point at the marked point. Do not apply it; refine your message instead.'
                : null;
          if (problem) nodes.push(el('p', { className: 'form-message is-error', textContent: problem }));
          else {
            front = el('input', { type: 'checkbox', checked: frontChecked });
            nodes.push(
              el('p', {
                className: 'hint',
                textContent:
                  'On the scene, the yellow arrow shows the side that faced the camera. The object only turns around its upright axis, so the blue line stays level with the object and ends directly above or below the marked point; a grey line joins it to the marked point.',
              }),
              el('label', { className: 'memory-consent' }, [front, ' I checked the scene: the yellow arrow points along the level blue line, which ends straight above or below the marked point, and this is the change I mean']),
            );
          }
        }
      }
      if (result.action === 'face_object') {
        nodes.push(el('p', { className: 'hint', textContent: 'This points the photographed side toward the other object in your assumed layout. It does not identify the object’s semantic front, infer alignment, or change relative scale.' }));
        if (previewing && guide?.readable && guide?.aligned) {
          front = el('input', { type: 'checkbox', checked: frontChecked });
          nodes.push(el('label', {}, [front, ' I choose this photographed side as the face to point, and checked the direction in the preview']));
        } else if (previewing) nodes.push(el('p', { className: 'form-message', textContent: 'A usable, aligned direction and 3D preview are required before applying this turn.' }));
      }
      const needsFront = ['face_anchor', 'face_object'].includes(result.action);
      if (current.baseVersion !== editor.version) {
        nodes.push(el('p', { className: 'hint', textContent: `This proposal was made for version ${current.baseVersion}, but the saved position is now version ${editor.version}. Plan again to use it.` }));
      } else {
        const singleCompare = Boolean(bridge.comparison && !bridge.targets && !composition);
        const reviewed = current;
        const held = () => singleCompare && (!bridge.comparison.available() || Boolean(proposalBlockedReason(comparisonSource())) || !singleProposalForScene() || unsettled() || !comparisonReadCertain);
        const canApply = () => !busy && previewing && (!needsFront || (front && frontChecked)) &&
          (!singleCompare || (!held() && current === reviewed && current.status === 'ready' && !isRedacted(current) &&
            current.baseVersion === bridge.editor().version && bridge.editor().clean &&
            (!comparing || comparisonView === 'proposed')));
        const toggle = el('button', { type: 'button', className: 'secondary', textContent: previewing ? 'Stop preview' : 'Preview on the scene', disabled: busy || comparing || held() || (!previewing && !editor.clean) });
        toggle.addEventListener('click', () => {
          if (singleCompare && (busy || comparing || held() || current !== reviewed || (!previewing && !bridge.editor().clean))) return;
          setPreview(!previewing);
          sync();
        });
        const apply = el('button', { type: 'button', textContent: 'Apply and save this proposal', disabled: !canApply() });
        apply.addEventListener('click', () => {
          if (!canApply()) {
            sync();
            return;
          }
          applyProposal(needsFront && Boolean(front) && frontChecked);
        });
        front?.addEventListener('change', () => {
          frontChecked = front.checked;
          apply.disabled = !canApply();
        });
        if (previewing) nodes.push(el('p', { className: 'hint', textContent: 'Showing the proposed position on the scene. It is not saved.' }));
        const actions = comparing ? [apply] : [toggle, apply];
        if (singleCompare) {
          if (!bridge.comparison.available()) nodes.push(el('p', { className: 'hint', textContent: 'The 3D preview is not available or its photo source could not be confirmed, so a new proposal cannot be applied here.' }));
          else if (!singleProposalForScene()) nodes.push(el('p', { className: 'hint', textContent: 'This proposal does not identify this scene’s photo and selected object, so it cannot be compared or applied here.' }));
          if (!comparing) {
            const compare = el('button', { type: 'button', className: 'secondary', textContent: 'Compare photo, saved and proposal', disabled: !comparable() });
            comparisonTrigger = compare;
            compare.addEventListener('click', beginComparison);
            actions.unshift(compare);
          }
          if (applyAttempt && reusable(applyAttempt) && applyAttempt.id === current.id && singleProposalForScene() && !proposalBlockedReason(comparisonSource())) {
            const retry = el('button', { type: 'button', className: 'secondary', textContent: 'Retry the unconfirmed apply', disabled: busy });
            retry.addEventListener('click', () => {
              if (busy || current !== reviewed || isRedacted(current) || current.status !== 'ready' ||
                  !applyAttempt || !reusable(applyAttempt) || applyAttempt.id !== current.id ||
                  !singleProposalForScene() || proposalBlockedReason(comparisonSource())) return;
              applyProposal(applyAttempt.body.frontConfirmed);
            });
            actions.push(retry);
            nodes.push(el('p', { className: 'hint', textContent: 'This repeats the same unconfirmed request; it does not create a new apply request.' }));
          }
        }
        nodes.push(el('div', { className: 'actions' }, actions));
      }
    }
    review.replaceChildren(...nodes);
  }

  function renderHistory() {
    const editor = bridge.editor();
    const byId = new Map(proposals.map((proposal) => [proposal.id, proposal]));
    historyList.replaceChildren(
      ...[...history]
        .sort((a, b) => b.version - a.version)
        .map((entry) => {
          const isCurrent = entry.version === editor.version;
          const item = el('li', {}, [
            el('span', { className: 'space-choice-label', textContent: `Version ${entry.version}${isCurrent ? ' (current)' : ''}: ${historyLabel(entry)}` }),
            el('span', { className: 'hint', textContent: entry.objects && bridge.targets ? bridge.targets.describe(entry) : formatTransform(entry) }),
          ]);
          const source = entry.proposalId ? byId.get(entry.proposalId) : null;
          if (source && isRedacted(source)) {
            item.append(el('span', { className: 'hint', textContent: 'The memory for this change is no longer shown.' }));
          } else if (source) {
            item.append(
              el('span', { className: 'hint', textContent: `Your memory: “${source.statement.text}”` }),
              el('span', { className: 'hint', textContent: `AI suggestion: ${source.result?.reason ?? 'not available'}` }),
            );
          }
          if (!isCurrent) {
            const undo = el('button', { type: 'button', className: 'secondary', textContent: `Return to version ${entry.version}` });
            undo.disabled = busy || previewing || !editor.clean;
            // On two-object scenes a different rule must be confirmed first.
            const ruleChanges = Boolean(bridge.targets) && JSON.stringify(entry.relationship ?? null) !== JSON.stringify(editor.relationship ?? null);
            undo.addEventListener('click', () => {
              if (!ruleChanges) {
                undoTo(entry.version, false);
                return;
              }
              ruleUndoVersion = entry.version;
              sync();
            });
            item.append(undo);
            if (ruleChanges && ruleUndoVersion === entry.version) {
              const confirm = el('button', { type: 'button', textContent: `Return to version ${entry.version} and change the rule`, disabled: undo.disabled });
              confirm.addEventListener('click', () => undoTo(entry.version, true));
              item.append(
                el('p', { className: 'hint', textContent: `This also changes the rule from “${bridge.targets.ruleText(editor.relationship)}” to “${bridge.targets.ruleText(entry.relationship)}”.` }),
                confirm,
              );
            }
          }
          return item;
        }),
    );
  }

  // A read started before a proposal action may describe the state before it,
  // so every action invalidates outstanding reads and then reads again.
  let readToken = 0;
  // Resolves true when both lists were read, false otherwise, and null when a
  // newer read replaced it (that read's own promise is latestRead).
  let latestRead = null;
  function refresh() {
    if (bridge.comparison) {
      comparisonReadCertain = false;
      if (comparing) endComparison();
      sync();
    }
    latestRead = readOnce();
    return latestRead;
  }
  async function readOnce() {
    const token = ++readToken;
    const [list, versions] = await Promise.all([request(`${bridge.jobUrl}/proposals`), request(`${bridge.jobUrl}/history`)]);
    if (disposed || token !== readToken) return null;
    const version = bridge.editor().version;
    const historyVersions = Array.isArray(versions.body) ? versions.body.map((entry) => entry?.version) : [];
    const newerSavedVersion = historyVersions.some((saved) => saved > version);
    comparisonReadCertain = Boolean(list.ok && versions.ok && Array.isArray(list.body) && Array.isArray(versions.body) &&
      historyVersions.every(Number.isInteger) && historyVersions.includes(version) && !newerSavedVersion);
    if (bridge.comparison && versions.ok && newerSavedVersion) bridge.conflict();
    if (list.ok && Array.isArray(list.body)) {
      proposals = list.body.filter((proposal) => !removedIds.has(proposal?.id)).map(guard);
      if (current) {
        const fresh = proposals.find((proposal) => proposal.id === current.id);
        // A newer answer already shown (from polling or an action) is kept
        // over an older listed record; a redacted one always wins.
        if (!fresh) dropSelection();
        else if (!isRedacted(fresh) && !isRedacted(current) && String(current.updatedAt ?? '') > String(fresh.updatedAt ?? '')) {
          proposals = proposals.map((proposal) => (proposal.id === current.id ? current : proposal));
        } else current = fresh;
      } else if (selection === 'unset') {
        current = proposals.find((proposal) => ACTIVE.has(proposal.status)) ?? proposals.find((proposal) => proposal.status !== 'applied') ?? null;
        if (current) selection = 'kept';
      }
      // A poll for a proposal this list shows finished, or no longer reviewed,
      // is obsolete; its answer is dropped.
      if (pollingId && (pollingId !== current?.id || !ACTIVE.has(current.status))) stopPolling();
      if (current && ACTIVE.has(current.status) && pollingId !== current.id) poll(current.id);
    }
    if (versions.ok && Array.isArray(versions.body)) history = versions.body;
    if (!list.ok || !versions.ok) status.textContent = 'Saved proposals or versions could not be loaded. Reload the page to try again.';
    else if (bridge.comparison && !comparisonReadCertain) status.textContent = 'The current saved version could not be confirmed. Load the saved version or reload the page.';
    else if (status.textContent === 'The current saved version could not be confirmed. Load the saved version or reload the page.') status.textContent = '';
    sync();
    return list.ok && versions.ok && Array.isArray(list.body);
  }

  const known = (id) => OBJECT_IDS.includes(id);
  function renderFilter() {
    if (!bridge.targets || (!filterId && !revealNote)) {
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
      filterHeading = el('p', { className: 'hint', textContent: `Still showing the earlier results for ${bridge.targets.nameOf(filterId)}.` });
      nodes.push(filterHeading);
    } else if (filterId) {
      const shown = proposals.filter((proposal) => proposal.targetId === filterId).length;
      const unassigned = proposals.filter((proposal) => !known(proposal.targetId)).length;
      const name = bridge.targets.nameOf(filterId);
      filterHeading = el('p', { className: 'hint', textContent: shown ? `Showing saved proposals for ${name} (${shown}).` : `No saved proposal is recorded for ${name}.` });
      nodes.push(filterHeading, ...(unassigned ? [el('p', { className: 'hint', textContent: `${unassigned} without a recorded object ${unassigned === 1 ? 'is' : 'are'} under Show all.` })] : []));
    }
    const all = el('button', { type: 'button', className: 'secondary', textContent: 'Show all saved proposals' });
    all.addEventListener('click', showAll);
    nodes.push(el('div', { className: 'actions' }, [all]));
    objectFilter.replaceChildren(...nodes);
  }

  // Shows only proposals requested for one object, after a fresh read. Nothing
  // is declared before that read succeeds, and a late answer for a newer jump,
  // object or scene changes nothing. The reviewed proposal stays as it is.
  async function revealForObject(objectId, isCurrent) {
    const mine = ++revealToken;
    chooserBox.open = true;
    revealNote = `Reading saved proposals for ${bridge.targets?.nameOf(objectId) ?? 'this object'}…`;
    renderFilter();
    // Follow only a genuinely newer read. A write that invalidated this read
    // without starting another leaves nothing to follow: this jump ends
    // without declaring anything, and the write's own refresh follows.
    let read = refresh();
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
      revealNote = `Saved proposals could not be read just now, so nothing is shown as being for ${bridge.targets?.nameOf(objectId) ?? 'this object'}. Try again.`;
      renderFilter();
      return 'failed';
    }
    revealNote = '';
    filterId = objectId;
    renderChooser();
    const target = chooser.children[0] ?? filterHeading ?? objectFilter;
    target.setAttribute?.('tabindex', '-1');
    target.focus?.();
    target.scrollIntoView?.({ block: 'nearest' });
    return 'shown';
  }

  function showAll() {
    revealToken += 1;
    revealNote = '';
    filterId = null;
    renderChooser();
  }

  function poll(id) {
    stopPolling();
    pollingId = id;
    const token = pollToken;
    const tick = async () => {
      const result = await request(`${bridge.jobUrl}/proposals/${id}`);
      if (disposed || token !== pollToken) return;
      // Only the proposal still reviewed is updated by its poll.
      if (current?.id !== id || removedIds.has(id)) {
        stopPolling();
        return;
      }
      if (result.ok && result.body?.id === id && older(result.body, current)) {
        // An answer older than what is shown changes nothing. Polling goes on
        // while what is shown is still planning, and ends once it finished.
        if (ACTIVE.has(current.status)) pollTimer = setTimeout(tick, POLL_MS);
        else stopPolling();
        return;
      }
      if (result.ok && result.body?.id === id) {
        current = guard(result.body);
        proposals = proposals.map((proposal) => (proposal.id === id ? current : proposal));
        status.textContent = '';
        if (!ACTIVE.has(current.status)) {
          stopPolling();
          sync();
          return;
        }
      } else {
        status.textContent = 'Checking the proposal again…';
      }
      sync();
      pollTimer = setTimeout(tick, POLL_MS);
    };
    tick();
  }

  // Runs one server mutation at a time with the manual editor locked.
  async function mutate(run) {
    busy = true;
    if (comparing) endComparison();
    readToken += 1;
    message.textContent = '';
    bridge.setLocked(true);
    sync();
    try {
      await run();
    } finally {
      if (!disposed) {
        busy = false;
        bridge.setLocked(previewing);
        sync();
        refresh();
      }
    }
  }

  plan.addEventListener('click', () =>
    mutate(async () => {
      const raw = text.value;
      const { version } = bridge.editor();
      const targetId = bridge.targets ? bridge.targets.selected() : undefined;
      // An unconfirmed plan is repeated exactly until the server answers it;
      // only then can newer text start a new plan.
      if (!planAttempt) {
        if (bridge.targets && !targetId) return;
        planAttempt = { requestId: crypto.randomUUID(), baseVersion: version, text: raw, consent: true, ...(bridge.targets ? { targetId } : {}) };
      }
      const result = await postJson(`${bridge.jobUrl}/proposals`, planAttempt);
      if (disposed) return;
      if (unclear(result) || (result.ok && !result.body?.id)) {
        message.textContent = withReason(
          result,
          reasonOf(result)
            ? 'Pressing Plan again with the same message repeats the same request and will not send it twice.'
            : 'Rehere could not confirm whether your memory was received. Pressing Plan again with the same message is safe and will not send it twice.',
        );
        return;
      }
      planAttempt = null;
      if (!result.ok) {
        message.textContent = serverError(result, 'The change could not be planned.');
        return;
      }
      if (previewing) setPreview(false);
      frontChecked = false;
      if (pollingId) stopPolling();
      current = guard(result.body);
      selection = 'kept';
      proposals = [current, ...proposals.filter((proposal) => proposal.id !== current.id)];
      if (ACTIVE.has(current.status)) poll(current.id);
    }),
  );

  function cancelProposal() {
    const target = current;
    mutate(async () => {
      if (!cancelAttempt || cancelAttempt.id !== target.id) cancelAttempt = { id: target.id, requestId: crypto.randomUUID() };
      const result = await postJson(`${bridge.jobUrl}/proposals/${target.id}/cancel`, { requestId: cancelAttempt.requestId });
      if (disposed) return;
      if (unclear(result)) {
        message.textContent = withReason(result, 'Rehere could not confirm the cancel. The request may still finish, but nothing is applied unless you apply it.');
        return;
      }
      cancelAttempt = null;
      if (!result.ok) {
        message.textContent = serverError(result, 'The planning could not be canceled.');
        return;
      }
      if (current?.id === target.id && !removedIds.has(target.id) && !older(result.body, current)) {
        current = guard(result.body);
        proposals = proposals.map((proposal) => (proposal.id === current.id ? current : proposal));
        if (!ACTIVE.has(current.status)) stopPolling();
      }
    });
  }

  function applyProposal(frontConfirmed) {
    const target = current;
    // A hold sends nothing and keeps the proposal and its preview.
    const held = bridge.surfaceProblem?.({ targetId: targetOf(target), ...target.result.transform }) ?? null;
    if (held) {
      message.textContent = `${held} The saved arrangement is still version ${bridge.editor().version}; the proposal is kept.`;
      return;
    }
    mutate(async () => {
      if (!reusable(applyAttempt) || applyAttempt.id !== target.id) {
        applyAttempt = { id: target.id, body: { requestId: crypto.randomUUID(), baseVersion: bridge.editor().version, frontConfirmed } };
      }
      const result = await postJson(`${bridge.jobUrl}/proposals/${target.id}/apply`, applyAttempt.body);
      if (disposed) return;
      if (unclear(result) || (result.ok && !Number.isInteger(result.body?.edit?.version))) {
        setPreview(false);
        bridge.unconfirmed();
        message.textContent = withReason(result, 'Rehere could not confirm whether the proposal was applied. Load the saved version to check; applying again repeats the same request.');
        return;
      }
      applyAttempt = null;
      if (!result.ok) {
        message.textContent = `${serverError(result, 'The proposal could not be applied.')} Nothing was changed by this attempt.`;
        if (result.status === 409) bridge.conflict();
        setPreview(false);
        return;
      }
      setPreview(false);
      // The receipt itself may carry the proposal redacted (for example a
      // replay after its source stopped): that is recorded first.
      if (result.body.proposal?.id === target.id) guard(result.body.proposal);
      // The proposal was redacted (now or while this was on its way) or left the list:
      // its words are not shown again and its edit is not taken into the
      // editor here; the saved version is loaded explicitly instead. What is
      // shown is scrubbed at once, without waiting for another read.
      if (hidden(target.id)) {
        proposals = proposals.filter((proposal) => !removedIds.has(proposal.id)).map(guard);
        if (current?.id === target.id) current = removedIds.has(target.id) ? null : guard(current);
        message.textContent = `Rehere saved this change as version ${result.body.edit.version}, but its proposal is no longer shown here. Load the saved version to see the scene as saved.`;
        bridge.conflict();
        return;
      }
      if (current?.id === target.id && result.body.proposal?.id === target.id) {
        current = guard(result.body.proposal);
        proposals = proposals.map((proposal) => (proposal.id === current.id ? current : proposal));
      }
      if (adopt(result.body.edit)) status.textContent = `Saved new arrangement version ${result.body.edit.version}.`;
    });
  }

  function undoTo(targetVersion, ruleChangeConfirmed = false) {
    ruleUndoVersion = null;
    const entry = history.find((item) => item.version === targetVersion);
    const held = bridge.surfaceProblem && entry?.objects ? bridge.surfaceProblem(entry) : null;
    if (held) {
      message.textContent = `${held} The saved arrangement is still version ${bridge.editor().version}; version ${targetVersion} stays in the history.`;
      sync();
      return;
    }
    mutate(async () => {
      const extra = bridge.targets ? { ruleChangeConfirmed } : {};
      if (!reusable(undoAttempt) || undoAttempt.body.targetVersion !== targetVersion || undoAttempt.body.ruleChangeConfirmed !== extra.ruleChangeConfirmed) {
        undoAttempt = { body: { requestId: crypto.randomUUID(), baseVersion: bridge.editor().version, targetVersion, ...extra } };
      }
      const result = await postJson(`${bridge.jobUrl}/undo`, undoAttempt.body);
      if (disposed) return;
      if (unclear(result) || (result.ok && !Number.isInteger(result.body?.version))) {
        bridge.unconfirmed();
        message.textContent = withReason(result, `Rehere could not confirm the return to version ${targetVersion}. Load the saved version to check; trying again repeats the same request.`);
        return;
      }
      undoAttempt = null;
      if (!result.ok) {
        message.textContent = `${serverError(result, 'The earlier version could not be restored.')} Nothing was changed by this attempt.`;
        if (result.status === 409) bridge.conflict();
        return;
      }
      if (adopt(result.body)) {
        status.textContent = `Returned to the position of version ${targetVersion}, saved as version ${result.body.version}. Earlier versions are kept.`;
      }
    });
  }

  text.addEventListener('input', sync);
  consent.addEventListener('change', sync);
  refresh();

  return {
    sync,
    refresh,
    revealForObject,
    showAll,
    dispose() {
      disposed = true;
      if (comparing) endComparison();
      stopPolling();
    },
  };
}
