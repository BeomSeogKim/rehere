// The owner's control over how one imported photo, text or recording may be
// used. Uses can only be narrowed, and stopping use is final. Originals are
// kept; nothing is deleted. Contributors' own grants are not managed here.

const USES = {
  place: 'Use to reconstruct this place',
  model: 'Use for model processing',
  share: 'Share with others',
};

export const isStopped = (record) => record?.policy?.stopped === true || record?.stopped === true;

export const STOPPED_TEXT = 'Stopped: this material is no longer used anywhere in Rehere. The original is kept, not deleted.';

export function cancellationText(cancellation) {
  switch (cancellation?.status) {
    case 'requested':
      return 'Stopping work already in progress was requested. Anything already sent for processing cannot be recalled.';
    case 'unconfirmed':
      return 'Rehere could not confirm that work in progress stopped. The restriction is saved, and no new work will start with this material.';
    default:
      return '';
  }
}

export function impactText(impacts) {
  if (!impacts) return 'Rehere could not count where this material is used.';
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const uses = [plural(impacts.scenes ?? 0, 'scene', 'scenes')];
  if (Number.isInteger(impacts.stories)) uses.push(plural(impacts.stories, 'recorded story', 'recorded stories'));
  // The owner's links between photo regions, counted whether or not they can
  // be shown now; null means that count could not be read.
  if (Number.isInteger(impacts.linkedRegions)) uses.push(plural(impacts.linkedRegions, 'linked photo region', 'linked photo regions'));
  // Links from a scene object to the saved writing, counted when this is that
  // writing or that scene's photo; null means they could not be counted.
  if (Number.isInteger(impacts.linkedMemories)) uses.push(plural(impacts.linkedMemories, 'written memory link', 'written memory links'));
  uses.push(plural(impacts.snapshots ?? 0, 'shared link', 'shared links'));
  const listed = uses.length === 2 ? uses.join(' and ') : `${uses.slice(0, -1).join(', ')} and ${uses.at(-1)}`;
  const unknown = `${impacts.linkedRegions === null ? ' Linked photo regions could not be counted.' : ''}${impacts.linkedMemories === null ? ' Written memory links could not be counted.' : ''}`;
  return `Currently used by ${listed}, with ${plural(impacts.processing ?? 0, 'piece of work', 'pieces of work')} in progress.${unknown}`;
}

function el(tag, { onclick, ...props } = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  if (onclick) node.addEventListener('click', onclick);
  node.append(...children);
  return node;
}

// A short marker for stopped material: who provided it and its checksum, never
// its content.
export function renderStoppedMarker(record) {
  const nodes = [el('p', { className: 'hint', textContent: STOPPED_TEXT })];
  const provider = record?.provider;
  if (provider) nodes.push(el('p', { className: 'hint', textContent: `Provided by ${provider}` }));
  if (record?.sha256) nodes.push(el('p', { className: 'hint', textContent: `Original checksum (SHA-256): ${record.sha256}` }));
  return el('div', { className: 'source-stopped' }, nodes);
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

const unclear = (result) => result.status === 0 || result.status >= 500;
const reasonOf = (result) => (typeof result.body?.error === 'string' ? result.body.error.trim() : '');
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// onChanged(policy, notice) is called after a saved change, or when a read
// finds the policy changed elsewhere, so the page can re-read the memory under
// it and keep showing the notice. knownRevision is the policy revision the page
// rendered from; a newer one on the first read means the page shows material
// under uses that no longer apply. Revisions only grow on reductions, so newer
// is always narrower, and an equal revision never triggers a re-read.
export function mountSourceControls(container, { draftId, sourceId, label, knownRevision = null, onChanged = () => {} }) {
  let disposed = false;
  let readToken = 0;
  let policy = null;
  let attempt = null;
  const url = `/api/drafts/${draftId}/sources/${sourceId}/policy`;
  const body = el('div');
  const message = el('p', { className: 'form-message', role: 'alert' });
  container.replaceChildren(el('details', { className: 'source-details source-uses' }, [el('summary', { textContent: `Uses of ${label}` }), body, message]));

  async function save(input, button) {
    if (!attempt || !sameJson(attempt.input, input)) attempt = { input, body: { requestId: crypto.randomUUID(), ...input } };
    button.disabled = true;
    const result = await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(attempt.body) });
    if (disposed) return;
    button.disabled = false;
    if (unclear(result) || (result.ok && result.body?.saved !== true)) {
      message.textContent = `${reasonOf(result) ? `${reasonOf(result)} ` : ''}Rehere could not confirm whether this was saved. Saving again repeats the same request.`;
      return;
    }
    attempt = null;
    if (result.status === 409) {
      const notice = `${reasonOf(result) || 'The uses of this material changed elsewhere.'} Review them again before saving.`;
      message.textContent = notice;
      const before = policy?.revision;
      await load();
      if (!disposed && policy && policy.revision !== before) onChanged(policy, notice);
      return;
    }
    if (!result.ok) {
      message.textContent = reasonOf(result) || 'The change could not be saved.';
      return;
    }
    policy = result.body;
    const notice = [input.stopUse ? 'Saved. This material is no longer used.' : 'Saved. The narrower uses apply now.', cancellationText(result.body.cancellation)].filter(Boolean).join(' ');
    message.textContent = notice;
    render();
    onChanged(policy, notice);
  }

  function render() {
    if (!policy) return;
    if (policy.stopped) {
      body.replaceChildren(el('p', { className: 'hint', textContent: STOPPED_TEXT }));
      return;
    }
    const boxes = Object.fromEntries(Object.keys(USES).map((key) => [key, el('input', { type: 'checkbox', checked: policy.permissions[key] === true, disabled: policy.permissions[key] !== true })]));
    const saveButton = el('button', { type: 'button', className: 'secondary', textContent: 'Save narrower uses', disabled: true });
    const chosen = () => Object.fromEntries(Object.entries(boxes).map(([key, box]) => [key, box.checked === true && policy.permissions[key] === true]));
    for (const box of Object.values(boxes)) box.addEventListener('change', () => (saveButton.disabled = sameJson(chosen(), policy.permissions)));
    saveButton.addEventListener('click', () => save({ baseRevision: policy.revision, permissions: chosen(), stopUse: false }, saveButton));

    const stopWrap = el('div', { className: 'actions' });
    const stopStart = el('button', { type: 'button', className: 'secondary', textContent: 'Stop using this material' });
    stopStart.addEventListener('click', () => {
      const confirm = el('button', { type: 'button', textContent: 'Stop using it' });
      const cancel = el('button', { type: 'button', className: 'secondary', textContent: 'Keep using it', onclick: () => stopWrap.replaceChildren(stopStart) });
      confirm.addEventListener('click', () => save({ baseRevision: policy.revision, permissions: { place: false, model: false, share: false }, stopUse: true }, confirm));
      stopWrap.replaceChildren(
        el('p', { className: 'hint', textContent: impactText(policy.impacts) }),
        el('p', {
          className: 'hint',
          textContent:
            'Every scene and shared link that uses it stops working, and this cannot be undone. The original stays stored and is not deleted. Anything already sent for processing cannot be recalled.',
        }),
        cancel,
        confirm,
      );
    });
    stopWrap.append(stopStart);

    body.replaceChildren(
      el('p', { className: 'hint', textContent: 'You can narrow how this material is used. A use that is not allowed now cannot be added back here.' }),
      el('fieldset', { className: 'source-permissions' }, [
        el('legend', { textContent: 'Allowed uses' }),
        ...Object.entries(USES).map(([key, text]) => el('label', {}, [boxes[key], ` ${text}`])),
      ]),
      el('div', { className: 'actions' }, [saveButton]),
      stopWrap,
    );
  }

  async function load() {
    const token = ++readToken;
    const result = await request(url);
    if (disposed || token !== readToken) return;
    if (!result.ok || !result.body?.permissions) {
      body.replaceChildren(el('p', { className: 'hint', textContent: 'The uses of this material could not be loaded.' }));
      return;
    }
    const first = policy === null;
    policy = result.body;
    render();
    if (first && Number.isInteger(knownRevision) && policy.revision > knownRevision) {
      onChanged(policy, 'The uses of this material changed since this memory was opened.');
    }
  }

  load();
  return {
    dispose() {
      disposed = true;
      readToken += 1;
      container.replaceChildren();
    },
  };
}
