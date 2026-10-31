// Memory-driven change proposals for one ready reconstruction. A person's
// statement goes to the server, which asks Meta for a proposal; the proposal is
// shown as a preview and changes the saved scene only through an explicit
// Apply that the server confirms. The browser never computes a transform.

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

// The object a two-object proposal was planned for: the stored request's
// target, or the plan's own when only that is given.
const targetOf = (proposal) => proposal?.targetId ?? proposal?.result?.targetId ?? null;

export function formatTransform({ offset, yaw }) {
  const [x, y, z] = offset.map((value) => value.toFixed(2));
  return `left/right ${x}, down/up ${y}, away/toward ${z}, turn ${Math.round((yaw * 180) / Math.PI)}°`;
}

export function proposalTitle(result) {
  switch (result?.action) {
    case 'translate':
      return 'Move the selected object';
    case 'rotate':
      return 'Turn the selected object';
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
      return `Applied and saved as version ${proposal.appliedVersion}.`;
    case 'interrupted':
      return 'Interrupted before it finished. Nothing was changed; any cost already counted remains counted.';
    default:
      return 'Status unknown.';
  }
}

// The server redacts a proposal whose scene depends on a withdrawn
// recollection: its words, result and question are no longer available.
export const isRedacted = (proposal) => proposal.redacted === true || typeof proposal.statement?.text !== 'string';
export const REDACTED_TEXT = 'This memory and its proposal are no longer shown, because the scene they were made for depends on a withdrawn recollection.';

export function historyLabel(entry) {
  if (entry.kind === 'initial') return 'Original position';
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
// setLocked(boolean), saved(edit), unconfirmed(), conflict(), targets? }.
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
  let frontChecked = false;
  // The facing relation the 3D preview actually drew, or null if none.
  let guide = null;
  // Kept only while an outcome is unknown, so a retry repeats the same request.
  let planAttempt = null;
  let applyAttempt = null;
  let cancelAttempt = null;
  let undoAttempt = null;
  const blocked = proposalBlockedReason(bridge.source);

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
  const historyList = el('ol', { className: 'memory-history', reversed: true });

  const label = el('label', { htmlFor: text.id, textContent: 'What do you remember about this object?' });
  container.replaceChildren(
    el('h4', { textContent: 'Change it from a memory' }),
    el('p', {
      className: 'hint',
      textContent:
        'Use only public or synthetic material in this development version. When you press Plan, your message and a small copy of this photo without file metadata are sent to Meta, which proposes one change to the selected object. Nothing changes until you apply it.',
    }),
    ...(blocked
      ? [el('p', { className: 'hint', textContent: blocked })]
      : [
          label,
          text,
          el('p', { className: 'hint' }, [count, ` / ${TEXT_LIMIT.toLocaleString('en-US')} characters`]),
          el('label', { className: 'memory-consent' }, [consent, ' Send this message and the photo to Meta to propose a change']),
          el('div', { className: 'actions' }, [plan]),
          hint,
        ]),
    status,
    message,
    review,
    el('details', { className: 'source-details' }, [el('summary', { textContent: 'Saved versions' }), historyList]),
  );

  const editorReady = () => bridge.editor().clean && !busy;

  function setPreview(on) {
    previewing = on;
    const anchor = on && current.result.action === 'face_anchor' ? current.result.anchor.point : null;
    guide = bridge.showTransform(on ? current.result.transform : null, anchor, targetOf(current)) ?? null;
    if (!on) frontChecked = false;
    bridge.setLocked(on || busy);
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

  function sync() {
    if (disposed) return;
    const editor = bridge.editor();
    const raw = text.value;
    count.textContent = raw.length.toLocaleString('en-US');
    const active = current && ACTIVE.has(current.status);
    const needsTarget = bridge.targets && !bridge.targets.selected();
    hint.textContent = needsTarget
      ? 'Choose the object this memory is about before planning.'
      : !editor.clean
      ? 'Save or revert your manual change, or load the saved version, before planning from a memory.'
      : !raw.trim()
        ? 'Write what you remember to plan a change.'
        : !consent.checked
          ? 'Tick the box to allow sending this message and the photo to Meta.'
          : '';
    plan.disabled = Boolean(blocked) || busy || active || needsTarget || !editorReady() || !raw.trim() || raw.length > TEXT_LIMIT || !consent.checked;
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
    const nodes = [el('p', { className: 'memory-status', textContent: proposalStatusText(current) })];
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
      const needsFront = result.action === 'face_anchor';
      if (current.baseVersion !== editor.version) {
        nodes.push(el('p', { className: 'hint', textContent: `This proposal was made for version ${current.baseVersion}, but the saved position is now version ${editor.version}. Plan again to use it.` }));
      } else {
        const toggle = el('button', { type: 'button', className: 'secondary', textContent: previewing ? 'Stop preview' : 'Preview on the scene', disabled: busy || (!previewing && !editor.clean) });
        toggle.addEventListener('click', () => {
          setPreview(!previewing);
          sync();
        });
        const apply = el('button', { type: 'button', textContent: 'Apply and save this proposal', disabled: busy || !previewing || (needsFront && (!front || !frontChecked)) });
        apply.addEventListener('click', () => applyProposal(needsFront && Boolean(front) && frontChecked));
        front?.addEventListener('change', () => {
          frontChecked = front.checked;
          apply.disabled = busy || !previewing || !frontChecked;
        });
        if (previewing) nodes.push(el('p', { className: 'hint', textContent: 'Showing the proposed position on the scene. It is not saved.' }));
        nodes.push(el('div', { className: 'actions' }, [toggle, apply]));
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
  async function refresh() {
    const token = ++readToken;
    const [list, versions] = await Promise.all([request(`${bridge.jobUrl}/proposals`), request(`${bridge.jobUrl}/history`)]);
    if (disposed || token !== readToken) return;
    if (list.ok && Array.isArray(list.body)) {
      proposals = list.body;
      if (current) current = proposals.find((proposal) => proposal.id === current.id) ?? current;
      else current = proposals.find((proposal) => proposal.status !== 'applied') ?? null;
      if (current && ACTIVE.has(current.status) && pollingId !== current.id) poll(current.id);
    }
    if (versions.ok && Array.isArray(versions.body)) history = versions.body;
    if (!list.ok || !versions.ok) status.textContent = 'Saved proposals or versions could not be loaded. Reload the page to try again.';
    if (previewing && current?.status !== 'ready') setPreview(false);
    sync();
  }

  function poll(id) {
    stopPolling();
    pollingId = id;
    const token = pollToken;
    const tick = async () => {
      const result = await request(`${bridge.jobUrl}/proposals/${id}`);
      if (disposed || token !== pollToken) return;
      if (result.ok && result.body) {
        current = result.body;
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
      if (bridge.targets && !targetId) return;
      if (!planAttempt || planAttempt.text !== raw || planAttempt.baseVersion !== version || planAttempt.targetId !== targetId) {
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
      current = result.body;
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
      if (current?.id === target.id) {
        current = result.body;
        if (!ACTIVE.has(current.status)) stopPolling();
      }
    });
  }

  function applyProposal(frontConfirmed) {
    const target = current;
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
      current = result.body.proposal ?? current;
      if (adopt(result.body.edit)) status.textContent = `Applied and saved as version ${result.body.edit.version}.`;
    });
  }

  function undoTo(targetVersion, ruleChangeConfirmed = false) {
    ruleUndoVersion = null;
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
    dispose() {
      disposed = true;
      stopPolling();
    },
  };
}
