import { copyArrangement, objectState } from './arrangement.js';
import { isComposition, poseProblem } from './composition-scene.js';
import { editProblem } from './photo-scene.js';
import { modelEvidence, proposalTitle } from './memory-edit.js';

const ACTIVE = new Set(['queued', 'processing']);
const POLL_MS = 2000;
const TEXT_LIMIT = 2000;
const ORIGIN_WORDS = { public: 'Public source', own: 'Own source', other: 'Someone else’s source', unknown: 'Source type not specified' };
const SOURCE_REASONS = {
  unreadable: 'The written source could not be read.',
  source: 'This written source can no longer be used for the place.',
  checksum: 'The written source changed or could not be verified.',
};
// The place's written source exactly as the server resolved it, or null.
const writtenSourceOf = (value) => value && typeof value === 'object' && typeof value.sourceId === 'string' && typeof value.available === 'boolean' ? value : null;
// Who the words are attributed to, as the owner stated it; never verified.
const attributionLines = (attribution) => [
  attribution?.creator ? `Attributed to ${attribution.creator}` : 'Creator not given',
  ...(attribution?.reference ? [attribution.reference] : []),
  `${ORIGIN_WORDS[attribution?.originKind] ?? ORIGIN_WORDS.unknown}; attribution as given by the owner, not verified.`,
];
const taggedSource = (value) => value && typeof value.text === 'string'
  && ['contribution-text', 'story-captions'].includes(value.statementSource?.kind)
  && /^[a-f0-9]{64}$/.test(value.statementSource.sourceSha256 ?? '');
const sourceKey = (value) => JSON.stringify(value.statementSource);
const sourceTitle = (source) => `${source.statementSource.kind === 'story-captions' ? 'Reviewed story captions' : 'Contributor writing'} · ${source.attribution?.providerLabel || 'Provider not given'}`;
export function boundAttributionLines(attribution) {
  return [
    `Provided by ${attribution?.providerLabel || 'provider not given'}; attribution as recorded, not verified.`,
    ...(attribution?.creator ? [`Words attributed to ${attribution.creator}, as recorded; authorship is not verified.`] : []),
    ...(attribution?.kind === 'story-captions' ? [
      `Captions reviewed by ${attribution.captionAuthorLabel || 'reviewer not given'}; the caption reviewer is not automatically the speaker.`,
      ...(attribution.captionDraft ? [`Caption draft: ${attribution.captionDraft.label || attribution.captionDraft.model || 'model not recorded'}; reviewed by the owner.`] : []),
    ] : []),
    ...(attribution?.reference ? [attribution.reference] : []),
  ];
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hidden = (proposal) => proposal?.redacted === true || typeof proposal?.statement?.text !== 'string';
const statusText = (proposal) => ({ queued: 'Waiting to plan your instruction.', processing: 'Your instruction is being planned.', ready: 'A bounded change is proposed. Nothing has been saved.', clarify: 'More detail is needed. Nothing was saved.', applied: 'This proposal already created a saved alternative.', canceled: 'Planning canceled. No alternative was created.', interrupted: 'Planning was interrupted. No alternative was created.', stale: 'The parent or its time changed. Review it before planning again.', failed: 'A usable change could not be proposed. No alternative was created.' }[proposal?.status] ?? 'The proposal status could not be confirmed.');
function el(tag, props = {}, children = []) { const node = document.createElement(tag); Object.assign(node, props); node.append(...children); return node; }
async function request(url, body) {
  try {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    return { status: response.status, ok: response.ok, body: await response.json().catch(() => null) };
  } catch { return { status: 0, ok: false, body: null }; }
}
const unclear = (result) => result.status === 0 || result.status >= 500;
// A long written source scrolls in its own focusable region, so the
// attribution, status and actions after it stay within reach. The text is
// complete and unchanged.
function sourceText(text, label) {
  const node = el('p', { className: 'memory-text source-text', textContent: text, tabIndex: 0 });
  node.setAttribute('role', 'region');
  node.setAttribute('aria-label', label);
  return node;
}

// Movement of an estimated full object is checked only against the
// photographed background kept in the scene. The server says whether a pose
// passed; anything else is treated as held.
export const MOTION_LIMIT = 'This check only looks at whether the object would overlap the parts of the photo kept in the scene. It does not check the floor, hidden parts of the room, or the path the object would take, and it is not a safety check.';
export function heldMotion(motion) {
  if (motion?.status === 'checked' && motion.scope === 'retained-geometry-only') return null;
  return typeof motion?.reason === 'string' && motion.reason.trim() ? motion.reason.trim() : 'The movement could not be checked.';
}

// This panel has only alternative-scoped proposal routes. Main version editing
// and manual alternative revision keep their own controls and request shapes.
export function mountAlternativeMemory(container, bridge) {
  let disposed = false, busy = false, readable = false, selected = null, previewed = false, frontChecked = false;
  let readToken = 0, pollToken = 0, timer = null, reportedLock = false;
  let proposals = [], createAttempt = null, applyAttempt = null, cancelAttempt = null;
  let createUnknown = false, applyUnknown = false, requestedInspect = bridge.initialProposalId ?? null;
  const redacted = new Set();
  const text = el('textarea', { rows: 3, maxLength: TEXT_LIMIT });
  text.setAttribute('aria-label', 'Remembered instruction for this alternative');
  const consent = el('input', { type: 'checkbox' });
  // Legacy owner instruction, or the place's own written source sent whole.
  const useSource = el('input', { type: 'checkbox' });
  const sourceChoice = el('label', { hidden: true }, [useSource, ' Use this place’s written source (whole text) instead of writing an instruction']);
  const sourceView = el('div', { className: 'written-source', hidden: true });
  const sourceSelect = el('select');
  sourceSelect.setAttribute('aria-label', 'Saved memory source for this alternative');
  const sourceOptions = el('div', { className: 'memory-source-choices', hidden: true }, [
    el('label', {}, ['Or choose saved words', sourceSelect]),
  ]);
  const boundSourceView = el('div', { className: 'written-source', hidden: true });
  const sourceReviewed = el('input', { type: 'checkbox' });
  sourceReviewed.setAttribute('aria-label', 'I reviewed the selected saved words and attribution');
  const sourceReview = el('label', { className: 'memory-consent', hidden: true }, [sourceReviewed, ' I reviewed these exact saved words and their attribution; this does not verify historical truth']);
  let reviewedBinding = null;
  let sourcesUnavailable = false;
  const boundSources = () => sourcesUnavailable ? [] : (bridge.statementSources?.() ?? []).filter(taggedSource);
  const boundSource = () => boundSources().find((source) => sourceKey(source) === sourceSelect.value) ?? null;
  const plan = el('button', { type: 'button', textContent: 'Plan a change to this alternative' });
  const refresh = el('button', { type: 'button', className: 'secondary', textContent: 'Read saved alternative proposals' });
  const note = el('p', { className: 'form-message', role: 'status' });
  const list = el('ul', { className: 'memory-proposals' });
  const review = el('div', { className: 'alternative-memory-review' });
  review.setAttribute('data-kind', 'guessed');
  const locked = () => busy || Boolean(createAttempt || applyAttempt || cancelAttempt) || proposals.some((proposal) => ACTIVE.has(proposal.status));
  const validScope = (proposal) => proposal?.scope?.kind === 'variant' && proposal.scope.parentVariantId === bridge.parentId && Number.isInteger(proposal.scope.baseEraRevision) && ['unknown', 'reconfirm-parent'].includes(proposal.scope.timeMode);
  const current = () => proposals.find((proposal) => proposal.id === selected) ?? null;
  const stopPoll = () => { clearTimeout(timer); timer = null; pollToken += 1; };
  const clearPreview = () => { const drawn = previewed; previewed = false; frontChecked = false; if (drawn) bridge.clearPreview(); };
  const scrub = (proposal) => {
    if (hidden(proposal)) redacted.add(proposal.id);
    return redacted.has(proposal.id) ? { ...proposal, redacted: true, statement: { text: null }, result: null, candidate: null, question: null } : proposal;
  };
  const update = (proposal) => {
    if (!validScope(proposal) || typeof proposal.id !== 'string') return false;
    const old = proposals.find((item) => item.id === proposal.id);
    if (old && String(proposal.updatedAt ?? '') < String(old.updatedAt ?? '')) return true;
    const next = scrub(proposal);
    proposals = old ? proposals.map((item) => item.id === next.id ? next : item) : [next, ...proposals];
    if (selected === next.id && (hidden(next) || next.status !== 'ready')) clearPreview();
    return true;
  };
  function candidateProblem(proposal) {
    const binding = bridge.binding();
    if (!binding?.ready || !validScope(proposal) || hidden(proposal) || proposal.status !== 'ready' || !proposal.candidate || proposal.candidate.version !== null) return 'Review this parent, object and time choice before previewing.';
    if (binding.baseEraRevision !== proposal.scope.baseEraRevision || binding.targetId !== proposal.targetId || binding.timeMode !== proposal.scope.timeMode) return 'This stored proposal belongs to its displayed object and time choice. Choose those settings above to preview it; it is never retargeted.';
    const parent = binding.edit, candidate = proposal.candidate;
    try {
      if (parent.objects) {
        if (!candidate.objects || !same(copyArrangement({ ...candidate, objects: parent.objects }), copyArrangement({ ...parent, version: null }))) return 'The whole parent arrangement could not be verified.';
        const ids = parent.objects.map((object) => object.id);
        if (candidate.objects.length !== ids.length || !candidate.objects.every((object, index) => object.id === ids[index])) return 'The whole parent arrangement could not be verified.';
        for (const object of candidate.objects) {
          const before = objectState(parent, object.id);
          if (object.id !== proposal.targetId && !same(object, before)) return 'A proposal cannot change another object.';
          if (isComposition(parent) ? poseProblem(object) || object.scale !== before.scale : editProblem(object)) return 'The proposed pose is outside the supported bounds.';
        }
      } else if (editProblem(candidate)) return 'The proposed pose is outside the supported bounds.';
      if (parent.fullObject) {
        if (!same(candidate.fullObject, parent.fullObject)) return 'This proposal does not keep the same estimated object.';
        if (candidate.offset[1] !== parent.offset[1]) return 'Height changes are not supported for this estimated object.';
        const held = heldMotion(proposal.motion);
        if (held) return `This move cannot be saved yet: ${held} ${MOTION_LIMIT}`;
      }
    } catch { return 'The whole parent arrangement could not be verified.'; }
    return bridge.problem?.(candidate) ?? null;
  }
  function render() {
    if (disposed) return;
    const nowLocked = locked();
    if (nowLocked !== reportedLock) { reportedLock = nowLocked; bridge.setPending(nowLocked); }
    const binding = bridge.binding();
    const block = bridge.blocked?.() ?? null;
    const written = sourcesUnavailable ? null : writtenSourceOf(bridge.writtenSource?.());
    const choices = boundSources();
    const selectedSource = boundSource();
    if (sourceSelect.value && !selectedSource && !createAttempt) {
      consent.checked = false;
      note.textContent = 'The selected saved memory is no longer available. Choose and review current words before planning.';
    }
    if (reviewedBinding !== JSON.stringify(selectedSource)) {
      sourceReviewed.checked = false;
      reviewedBinding = JSON.stringify(selectedSource);
    }
    sourceOptions.hidden = !choices.length;
    sourceSelect.replaceChildren(el('option', { value: '', textContent: 'Use an owner instruction or the place’s written source' }),
      ...choices.map((source) => el('option', { value: sourceKey(source), textContent: `${sourceTitle(source)}${source.modelAllowed ? '' : ' (model use off)'}`, disabled: source.modelAllowed !== true })));
    sourceSelect.value = selectedSource ? sourceKey(selectedSource) : '';
    sourceSelect.disabled = nowLocked;
    boundSourceView.hidden = !selectedSource;
    boundSourceView.replaceChildren(...(selectedSource ? [sourceText(selectedSource.text, 'Selected saved memory, full text'),
      ...boundAttributionLines(selectedSource.attribution).map((line) => el('p', { className: 'hint', textContent: line })), sourceReview] : []));
    sourceReview.hidden = !selectedSource;
    sourceReviewed.disabled = nowLocked || selectedSource?.modelAllowed !== true;
    const sourceUsable = Boolean(written?.available && written.modelAllowed && /^[a-f0-9]{64}$/.test(written.sourceSha256 ?? ''));
    if (!written || (!sourceUsable && !createAttempt)) useSource.checked = false;
    sourceChoice.hidden = !written;
    useSource.disabled = nowLocked || !sourceUsable || Boolean(selectedSource);
    sourceView.hidden = !written || Boolean(selectedSource);
    sourceView.replaceChildren(...(!written ? [] : !written.available
      ? [el('p', { className: 'hint', textContent: SOURCE_REASONS[written.reason] ?? SOURCE_REASONS.unreadable })]
      : [sourceText(written.text, 'Written source, full text'),
        ...attributionLines(written.attribution).map((line) => el('p', { className: 'hint', textContent: line })),
        ...(written.modelAllowed ? [] : [el('p', { className: 'hint', textContent: 'Model use is off for this written source.' })])]));
    text.hidden = useSource.checked || Boolean(selectedSource);
    const ready = selectedSource ? selectedSource.modelAllowed === true && sourceReviewed.checked : useSource.checked ? sourceUsable : Boolean(text.value.trim()) && text.value.length <= TEXT_LIMIT;
    plan.disabled = busy || (!createAttempt && (!readable || nowLocked || Boolean(block) || !binding?.ready || !ready || !consent.checked));
    plan.textContent = createAttempt ? 'Retry the earlier alternative plan' : 'Plan a change to this alternative';
    text.disabled = consent.disabled = nowLocked;
    refresh.disabled = busy;
    list.replaceChildren(...proposals.map((proposal) => {
      const pick = el('button', { type: 'button', className: 'secondary', textContent: proposal.id === selected ? 'Reviewing alternative proposal' : 'Review alternative proposal', disabled: proposal.id === selected || busy || Boolean(createAttempt || applyAttempt || cancelAttempt) });
      pick.addEventListener('click', () => {
        clearPreview(); selected = proposal.id;
        bridge.selectScope?.(proposal);
        if (ACTIVE.has(proposal.status)) poll(proposal.id); else stopPoll();
        render();
      });
      const when = Number.isFinite(Date.parse(proposal.createdAt)) ? new Date(proposal.createdAt).toLocaleString('en-US') : 'Time not recorded';
      return el('li', {}, [el('p', { className: 'hint', textContent: `${when} · ${hidden(proposal) ? 'This proposal is no longer available under current uses.' : statusText(proposal)}` }), pick]);
    }));
    const proposal = current();
    if (!proposal) {
      const retry = applyAttempt ? el('button', { type: 'button', textContent: 'Retry saving the earlier alternative', disabled: busy }) : null;
      retry?.addEventListener('click', () => apply({ id: applyAttempt.id }));
      const cancel = cancelAttempt ? el('button', { type: 'button', textContent: 'Retry canceling the earlier plan', disabled: busy }) : null;
      cancel?.addEventListener('click', () => cancelPlan({ id: cancelAttempt.id }));
      review.replaceChildren(el('p', { className: 'hint', textContent: block || 'Choose a saved proposal to inspect it, or write a complete remembered instruction for a new plan.' }), ...(retry ? [retry] : []), ...(cancel ? [cancel] : [])); return;
    }
    if (hidden(proposal)) {
      const retry = applyAttempt ? el('button', { type: 'button', textContent: 'Retry saving the earlier alternative', disabled: busy }) : null;
      retry?.addEventListener('click', () => apply(proposal));
      const cancel = cancelAttempt ? el('button', { type: 'button', textContent: 'Retry canceling the earlier plan', disabled: busy }) : null;
      cancel?.addEventListener('click', () => cancelPlan(proposal));
      review.replaceChildren(el('p', { className: 'hint', textContent: 'This proposal is no longer available under current sources or supporting recollections.' }), ...(retry ? [retry] : []), ...(cancel ? [cancel] : [])); return;
    }
    const tagged = ['contribution-text', 'story-captions'].includes(proposal.statement.source?.kind);
    const nodes = [el('p', { className: 'hint', textContent: `Stored proposal for ${bridge.nameOf(proposal.targetId)}. New alternative time: ${proposal.scope.timeMode === 'unknown' ? 'unknown' : 'explicitly re-confirm the parent assertion'}. The current scene is not its target.` }), proposal.statement.source ? sourceText(proposal.statement.text, 'Proposal instruction from the saved source, full text') : el('p', { className: 'memory-text', textContent: proposal.statement.text }),
      ...(tagged ? [el('p', { className: 'hint', textContent: proposal.statement.source.kind === 'story-captions' ? 'From owner-reviewed saved story captions.' : 'From the contributor’s exact saved writing.' }),
        ...boundAttributionLines(proposal.statement.attribution).map((line) => el('p', { className: 'hint', textContent: line }))]
        : proposal.statement.source ? [el('p', { className: 'hint', textContent: 'From this place’s written source.' })] : []),
      el('p', { className: 'hint', textContent: statusText(proposal) })];
    const evidence = ['ready', 'clarify', 'applied'].includes(proposal.status) ? modelEvidence(proposal) : null;
    if (evidence) {
      const block = el('div', { className: 'model-evidence' }, [el('p', {}, [el('strong', { textContent: evidence.heading })]), ...evidence.lines.map((line) => el('p', { className: 'hint', textContent: line }))]);
      block.setAttribute('data-mode', evidence.mode);
      nodes.push(block);
    }
    if (proposal.result?.transform && ['ready', 'applied'].includes(proposal.status)) {
      nodes.push(el('p', {}, [el('strong', { textContent: proposal.mode === 'simulated' ? 'Proposal (SIMULATED, not from Meta): ' : 'Proposal (AI suggestion): ' }), `${proposalTitle(proposal.result)} (${bridge.nameOf(proposal.targetId)})`]));
      if (proposal.result.reason) nodes.push(el('p', { className: 'hint', textContent: `Reason given: ${proposal.result.reason}` }));
    }
    if (bridge.binding()?.edit?.fullObject && proposal.motion) {
      const held = heldMotion(proposal.motion);
      nodes.push(el('p', { className: 'hint', textContent: held ? `This move could not be confirmed: ${held} ${MOTION_LIMIT}` : `This move does not overlap what is kept from the photo. ${MOTION_LIMIT}` }));
    }
    if (ACTIVE.has(proposal.status) || cancelAttempt) {
      const cancel = el('button', { type: 'button', className: 'secondary', textContent: cancelAttempt ? 'Retry canceling the earlier plan' : 'Cancel this alternative plan', disabled: busy || (!cancelAttempt && Boolean(createAttempt || applyAttempt)) });
      cancel.addEventListener('click', () => cancelPlan(proposal)); nodes.push(cancel);
    }
    if (proposal.status === 'clarify') nodes.push(el('p', { textContent: proposal.question ?? proposal.result?.question ?? 'Write a more complete instruction, then plan again.' }), el('p', { className: 'hint', textContent: 'Answer with a complete revised instruction above. A new plan sends that instruction only, not a conversation or the parent’s time wording.' }));
    if (proposal.status === 'applied' && proposal.appliedVariantId) {
      const show = el('button', { type: 'button', className: 'secondary', textContent: 'Inspect the saved alternative', disabled: busy });
      show.addEventListener('click', () => bridge.showSaved(proposal.appliedVariantId)); nodes.push(show);
    }
    if (proposal.status === 'ready' || applyAttempt) {
      const problem = applyAttempt ? null : candidateProblem(proposal);
      const face = ['face_anchor', 'face_object'].includes(proposal.result?.action);
      const preview = el('button', { type: 'button', className: 'secondary', textContent: previewed ? 'Stop alternative proposal preview' : 'Preview alternative proposal', disabled: nowLocked || Boolean(block) || Boolean(problem) });
      preview.addEventListener('click', async () => {
        if (previewed) { clearPreview(); render(); return; }
        if (disposed || locked()) return;
        busy = true; render();
        const admitted = await bridge.admitParent();
        if (disposed) return;
        const fresh = admitted ? await request(`${bridge.proposalUrl}/${encodeURIComponent(proposal.id)}`) : null;
        if (disposed) return;
        busy = false;
        if (!fresh?.ok || fresh.body?.id !== proposal.id || !update(fresh.body)) { clearPreview(); note.textContent = 'The stored proposal could not be checked for preview. Read it again; nothing was saved.'; render(); return; }
        const checked = current();
        const held = candidateProblem(checked);
        if (!admitted || held || locked()) { clearPreview(); note.textContent = held || 'Resolve the pending work and check this parent before previewing.'; render(); return; }
        const result = bridge.preview(checked.candidate, checked.result, checked.targetId);
        previewed = Boolean(result?.drawn);
        frontChecked = false;
        if (face && (!result?.guide?.readable || !result.guide.aligned)) { clearPreview(); note.textContent = 'A readable, aligned direction in the actual 3D preview is required for this turn.'; }
        else note.textContent = previewed ? 'Preview only. Saving creates a new alternative; the current scene and parent stay unchanged.' : 'The 3D preview is not available. Nothing can be saved without inspecting it.';
        render();
      });
      nodes.push(preview);
      if (proposal.result?.action === 'face_anchor' && bridge.textureUrl && Array.isArray(proposal.result.anchor?.point)) {
        const marker = el('span', { className: 'anchor-marker' });
        marker.style.left = `${proposal.result.anchor.point[0] * 100}%`; marker.style.top = `${proposal.result.anchor.point[1] * 100}%`;
        nodes.push(el('figure', { className: 'anchor-figure' }, [el('div', { className: 'anchor-frame' }, [el('img', { src: bridge.textureUrl, alt: 'Source photo with the proposed point marked' }), marker]), el('figcaption', { className: 'hint', textContent: `${proposal.mode === 'simulated' ? 'The simulated answer' : 'The model'} proposed this point in the source photo. Its direction still relies on estimated depth; inspect the actual preview.` })]));
      }
      if (problem) nodes.push(el('p', { className: 'hint', textContent: problem }));
      if (previewed && face) {
        const front = el('input', { type: 'checkbox', checked: frontChecked });
        front.addEventListener('change', () => { frontChecked = front.checked === true; render(); });
        nodes.push(el('label', {}, [front, ' I choose this photographed side as the face to point and checked the direction in the preview; it is not an automatically identified front']));
      }
      const save = el('button', { type: 'button', textContent: applyAttempt ? 'Retry saving the earlier alternative' : 'Save proposal as a new alternative', disabled: busy || (!applyAttempt && (nowLocked || !previewed || Boolean(block) || Boolean(problem) || (face && !frontChecked))) });
      save.addEventListener('click', () => apply(proposal)); nodes.push(save);
    }
    review.replaceChildren(...nodes);
  }
  async function read() {
    const token = ++readToken;
    const result = await request(bridge.proposalUrl);
    if (disposed || token !== readToken) return;
    if (!result.ok || !Array.isArray(result.body) || result.body.some((proposal) => !validScope(proposal))) {
      readable = false; clearPreview(); note.textContent = 'Saved alternative proposals could not be read. Read them again before starting a new plan.'; render(); return;
    }
    readable = true;
    const old = proposals;
    proposals = result.body.map((proposal) => {
      const before = old.find((item) => item.id === proposal.id);
      return before && String(proposal.updatedAt ?? '') < String(before.updatedAt ?? '') ? before : scrub(proposal);
    });
    if (requestedInspect && proposals.some((proposal) => proposal.id === requestedInspect)) { selected = requestedInspect; requestedInspect = null; bridge.selectScope?.(current()); }
    if (!proposals.some((proposal) => proposal.id === selected)) { selected = null; clearPreview(); }
    if (current() && (hidden(current()) || current().status !== 'ready')) clearPreview();
    if (current() && ACTIVE.has(current().status)) poll(current().id);
    render();
  }
  function poll(id) {
    stopPoll(); const token = pollToken;
    const tick = async () => {
      const result = await request(`${bridge.proposalUrl}/${encodeURIComponent(id)}`);
      if (disposed || token !== pollToken || selected !== id) return;
      if (result.ok && result.body?.id === id && update(result.body)) {
        if (!ACTIVE.has(current()?.status)) { stopPoll(); render(); return; }
      } else { clearPreview(); note.textContent = 'The proposal could not be checked. No new alternative was saved.'; }
      render(); timer = setTimeout(tick, POLL_MS);
    };
    tick();
  }
  async function create() {
    if (plan.disabled || disposed) return;
    const binding = bridge.binding();
    const written = writtenSourceOf(bridge.writtenSource?.());
    // Only the server-resolved source identity is sent, never its words.
    if (!createAttempt) {
      const selectedSource = boundSource();
      const statement = selectedSource ? { statementSource: structuredClone(selectedSource.statementSource), sourceReviewed: true }
        : useSource.checked ? { statementSource: { sourceId: written.sourceId, sourceSha256: written.sourceSha256 } } : { text: text.value };
      createAttempt = { requestId: crypto.randomUUID(), baseEraRevision: binding.baseEraRevision, targetId: binding.targetId, timeMode: binding.timeMode, ...statement, consent: true };
    }
    busy = true; readToken += 1; clearPreview(); render();
    const result = await request(bridge.proposalUrl, createAttempt);
    if (disposed) return;
    busy = false;
    const matched = validScope(result.body) && typeof result.body.id === 'string' && result.body.id.length > 0 && result.body.requestId === createAttempt.requestId && result.body.targetId === createAttempt.targetId && result.body.scope.baseEraRevision === createAttempt.baseEraRevision && result.body.scope.timeMode === createAttempt.timeMode;
    if (unclear(result) || (result.ok && !matched)) { createUnknown = true; note.textContent = 'The plan outcome is unknown. Retry the earlier alternative plan with exactly the same instruction and choice.'; render(); return; }
    if (!result.ok || !update(result.body)) {
      if (!createUnknown || ![401, 403, 409].includes(result.status)) createAttempt = null;
      note.textContent = 'The alternative plan could not be confirmed under the current parent, time or permitted inputs. The manual revision remains separate.'; render(); return;
    }
    createAttempt = null; createUnknown = false; readable = true; selected = result.body.id;
    note.textContent = 'This proposal belongs only to the selected parent alternative. Planning and preview do not create a new alternative.';
    if (ACTIVE.has(result.body.status)) poll(result.body.id);
    render();
  }
  async function cancelPlan(proposal) {
    if (busy || disposed || (cancelAttempt && cancelAttempt.id !== proposal.id) || (!cancelAttempt && Boolean(createAttempt || applyAttempt))) return;
    cancelAttempt ??= { id: proposal.id, body: { requestId: crypto.randomUUID() } };
    busy = true; readToken += 1; clearPreview(); render();
    const result = await request(`${bridge.proposalUrl}/${encodeURIComponent(cancelAttempt.id)}/cancel`, cancelAttempt.body);
    if (disposed) return;
    busy = false;
    if (unclear(result) || (result.ok && (!validScope(result.body) || result.body.id !== cancelAttempt.id))) { note.textContent = 'The cancel outcome is unknown. Retry the same cancel request.'; render(); return; }
    if (!result.ok) { note.textContent = 'This cancel could not be checked. Retry it when access returns.'; render(); return; }
    cancelAttempt = null; update(result.body); stopPoll(); render();
  }
  async function apply(proposal) {
    if (busy || disposed || (applyAttempt && applyAttempt.id !== proposal.id)) return;
    if (!applyAttempt && (locked() || !previewed || candidateProblem(proposal) || bridge.blocked?.() || (['face_anchor', 'face_object'].includes(proposal.result?.action) && !frontChecked))) return;
    applyAttempt ??= { id: proposal.id, body: { requestId: crypto.randomUUID(), baseEraRevision: proposal.scope.baseEraRevision, frontConfirmed: ['face_anchor', 'face_object'].includes(proposal.result?.action) && frontChecked, confirmed: true } };
    busy = true; readToken += 1; render();
    // A frozen apply may already have committed. Its exact retry must reach the
    // receipt before any new frontend time/admission checks can reject it.
    const result = await request(`${bridge.proposalUrl}/${encodeURIComponent(applyAttempt.id)}/apply`, applyAttempt.body);
    if (disposed) return;
    busy = false;
    const accepted = result.ok && validScope(result.body?.proposal) && result.body.proposal.id === applyAttempt.id && result.body.proposal.status === 'applied' && result.body.variant?.revision?.parentVariantId === bridge.parentId && result.body.variant.revision.proposalId === applyAttempt.id && result.body.variant.edit?.version === null && typeof result.body.variant?.id === 'string' && result.body.proposal.appliedVariantId === result.body.variant.id;
    if (unclear(result) || (result.ok && !accepted)) { applyUnknown = true; note.textContent = 'The save outcome is unknown. Retry saving the earlier alternative; it sends the identical request and cannot create another child.'; render(); return; }
    if (!accepted) { if (!applyUnknown) applyAttempt = null; clearPreview(); note.textContent = applyUnknown ? 'The earlier save is still unconfirmed. Retry that exact request when current access can be checked.' : 'The proposal could not be saved under the current parent, time or permitted model uses. Review it again; no new alternative was confirmed.'; render(); return; }
    applyAttempt = null; applyUnknown = false; clearPreview(); update(result.body.proposal); render(); bridge.saved(result.body);
  }
  text.addEventListener('input', () => { clearPreview(); render(); });
  consent.addEventListener('change', () => { clearPreview(); render(); });
  useSource.addEventListener('change', () => { clearPreview(); render(); });
  sourceSelect.addEventListener('change', () => { clearPreview(); useSource.checked = false; sourceReviewed.checked = false; consent.checked = false; render(); });
  sourceReviewed.addEventListener('change', () => { clearPreview(); render(); });
  plan.addEventListener('click', create); refresh.addEventListener('click', read);
  const fullObjectNote = el('p', { className: 'hint', hidden: !bridge.binding()?.edit?.fullObject, textContent: 'For this estimated object, a plan can move it left or right, toward or away, or turn it. Its height stays as in the parent, and its front is not known, so a request to face something asks you for an explicit turn instead.' });
  container.replaceChildren(el('h4', { textContent: 'Revise this alternative from a remembered instruction' }), fullObjectNote,
    el('p', { className: 'hint', textContent: 'Plan sends your instruction or explicitly chosen saved words, the permitted source photo selections and this parent’s object layout to Meta. Parent time wording and recordings are not added. Dates in your message do not change the selected unknown or re-confirmed time. Use public or synthetic photos only. The model cannot choose another parent, change the time, or infer relative size.' }), sourceChoice, sourceView, sourceOptions, boundSourceView, text,
    el('label', {}, [consent, ' Send this instruction and the permitted photo/layout context to Meta to propose one change to this alternative']),
    el('div', { className: 'actions' }, [plan, refresh]), note, list, review);
  read();
  return {
    sync() { if (previewed && candidateProblem(current())) clearPreview(); render(); },
    invalidate(reason, unavailable = false) { clearPreview(); if (unavailable) { sourcesUnavailable = true; readable = false; proposals = proposals.map((proposal) => ({ ...proposal, statement: { text: null }, result: null, candidate: null, question: null })); } note.textContent = reason; render(); },
    inspect(id) { const proposal = proposals.find((item) => item.id === id); if (proposal) { selected = id; bridge.selectScope?.(proposal); if (ACTIVE.has(proposal.status)) poll(id); render(); } },
    hasPending: locked,
    dispose() { disposed = true; stopPoll(); readToken += 1; clearPreview(); container.replaceChildren(); },
  };
}
