import { copyArrangement, objectState } from './arrangement.js';
import { isComposition, poseProblem } from './composition-scene.js';
import { editProblem } from './photo-scene.js';

const ACTIVE = new Set(['queued', 'processing']);
const POLL_MS = 2000;
const TEXT_LIMIT = 2000;
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
  const plan = el('button', { type: 'button', textContent: 'Plan a change to this alternative' });
  const refresh = el('button', { type: 'button', className: 'secondary', textContent: 'Read saved alternative proposals' });
  const note = el('p', { className: 'form-message', role: 'status' });
  const list = el('ul', { className: 'memory-proposals' });
  const review = el('div', { className: 'alternative-memory-review' });
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
    } catch { return 'The whole parent arrangement could not be verified.'; }
    return bridge.problem?.(candidate) ?? null;
  }
  function render() {
    if (disposed) return;
    const nowLocked = locked();
    if (nowLocked !== reportedLock) { reportedLock = nowLocked; bridge.setPending(nowLocked); }
    const binding = bridge.binding();
    const block = bridge.blocked?.() ?? null;
    plan.disabled = busy || (!createAttempt && (!readable || nowLocked || Boolean(block) || !binding?.ready || !text.value.trim() || text.value.length > TEXT_LIMIT || !consent.checked));
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
    const nodes = [el('p', { className: 'hint', textContent: `Stored proposal for ${bridge.nameOf(proposal.targetId)}. New alternative time: ${proposal.scope.timeMode === 'unknown' ? 'unknown' : 'explicitly re-confirm the parent assertion'}. The current scene is not its target.` }), el('p', { className: 'memory-text', textContent: proposal.statement.text }), el('p', { className: 'hint', textContent: statusText(proposal) })];
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
        nodes.push(el('figure', { className: 'anchor-figure' }, [el('div', { className: 'anchor-frame' }, [el('img', { src: bridge.textureUrl, alt: 'Source photo with the proposed point marked' }), marker]), el('figcaption', { className: 'hint', textContent: 'The model proposed this point in the source photo. Its direction still relies on estimated depth; inspect the actual preview.' })]));
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
    createAttempt ??= { requestId: crypto.randomUUID(), baseEraRevision: binding.baseEraRevision, targetId: binding.targetId, timeMode: binding.timeMode, text: text.value, consent: true };
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
  plan.addEventListener('click', create); refresh.addEventListener('click', read);
  container.replaceChildren(el('h4', { textContent: 'Revise this alternative from a remembered instruction' }),
    el('p', { className: 'hint', textContent: 'Plan sends your instruction, the permitted source photo selections and this parent’s object layout to Meta. Parent time wording, contributors’ words and recordings are not added. Dates in your message do not change the selected unknown or re-confirmed time. Use public or synthetic photos only. The model cannot choose another parent, change the time, or infer relative size.' }), text,
    el('label', {}, [consent, ' Send this instruction and the permitted photo/layout context to Meta to propose one change to this alternative']),
    el('div', { className: 'actions' }, [plan, refresh]), note, list, review);
  read();
  return {
    sync() { if (previewed && candidateProblem(current())) clearPreview(); render(); },
    invalidate(reason, unavailable = false) { clearPreview(); if (unavailable) proposals = proposals.map((proposal) => ({ ...proposal, statement: { text: null }, result: null, candidate: null, question: null })); note.textContent = reason; render(); },
    inspect(id) { const proposal = proposals.find((item) => item.id === id); if (proposal) { selected = id; bridge.selectScope?.(proposal); if (ACTIVE.has(proposal.status)) poll(id); render(); } },
    hasPending: locked,
    dispose() { disposed = true; stopPoll(); readToken += 1; clearPreview(); container.replaceChildren(); },
  };
}
