// The owner's removal of one whole saved place from this app's local storage,
// and the list of removals whose local cleanup is still finishing. Opening the
// review only reads. A confirmed removal is one immutable request; only its
// opaque ID and impact digest are kept in browser storage, so the exact
// request can be repeated or checked after a reload. Nothing here infers that
// nothing was deleted from a failed answer, and a removed place is never
// shown again.

const NUMBERS = ['photos', 'scenes', 'recordedStories', 'contributions', 'contributionProviders', 'visitorSnapshots', 'visitorPreviews', 'linkedRegions', 'invitations', 'intakes', 'processing'];
const FLAGS = ['writtenMemory', 'recording'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const LIMITS =
  'This removes the copies this app keeps on this computer. It is not secure erasure, and it cannot remove backups, logs, caches, downloads, screenshots, copies already delivered to someone, or anything already sent to a hosted service.';
const UNCONFIRMED = 'Rehere could not confirm the deletion. It may have been accepted.';

function el(tag, { onclick, ...props } = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  if (onclick) node.addEventListener('click', onclick);
  node.append(...children);
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

const reasonOf = (result) => (typeof result.body?.error === 'string' ? result.body.error.trim() : '');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const when = (iso) => new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

// Exactly the stored counts the server reports; anything else is not a review.
export function validInventory(inventory) {
  if (!inventory || typeof inventory !== 'object') return false;
  const keys = Object.keys(inventory).sort();
  if (keys.join() !== [...NUMBERS, ...FLAGS].sort().join()) return false;
  return NUMBERS.every((key) => Number.isInteger(inventory[key]) && inventory[key] >= 0) && FLAGS.every((key) => typeof inventory[key] === 'boolean');
}

// A deletion record for this place; with an attempt, only that attempt's own.
export function validRecord(record, draftId, attempt = null) {
  return (
    record?.draftId === draftId &&
    UUID.test(record.draftId ?? '') &&
    UUID.test(record.requestId ?? '') &&
    SHA.test(record.impactSha256 ?? '') &&
    Number.isFinite(Date.parse(record.requestedAt)) &&
    // A finished cleanup has its time; one still pending has none.
    ((record.state === 'access-stopped' && record.completedAt === null) || (record.state === 'complete' && typeof record.completedAt === 'string' && Number.isFinite(Date.parse(record.completedAt)))) &&
    validInventory(record.inventory) &&
    (!attempt || (record.requestId === attempt.requestId && record.impactSha256 === attempt.impactSha256))
  );
}

// What the stored counts cover, without any content, names or labels. In a
// deletion receipt they are the scope frozen when deletion was requested, not
// what remains now; work in progress is described as active at that moment.
export function inventoryText(inventory, { receipt = false } = {}) {
  const parts = [
    plural(inventory.photos, 'original photo', 'original photos'),
    inventory.writtenMemory ? 'the written memory' : null,
    inventory.recording ? 'the voice recording' : null,
    plural(inventory.scenes, 'scene', 'scenes'),
    plural(inventory.recordedStories, 'recorded story', 'recorded stories'),
    `${plural(inventory.contributions, 'contribution', 'contributions')} from ${plural(inventory.contributionProviders, 'contributor', 'contributors')}`,
    plural(inventory.visitorSnapshots, 'visitor link', 'visitor links'),
    plural(inventory.visitorPreviews, 'visitor preview', 'visitor previews'),
    plural(inventory.linkedRegions, 'linked photo region', 'linked photo regions'),
    plural(inventory.invitations, 'invitation', 'invitations'),
    plural(inventory.intakes, 'related upload record', 'related upload records'),
    receipt
      ? `${plural(inventory.processing, 'piece of work', 'pieces of work')} active when deletion was requested`
      : plural(inventory.processing, 'piece of work in progress', 'pieces of work in progress'),
  ].filter(Boolean);
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

// The state of an accepted removal, content-free.
export function deletionText(record) {
  return record.state === 'complete'
    ? `This place was deleted from this computer. Local cleanup finished on ${when(record.completedAt)} for what was recorded when deletion was requested: ${inventoryText(record.inventory, { receipt: true })}. ${LIMITS}`
    : `This place was deleted on ${when(record.requestedAt)}. Access to it has stopped. Removal of its stored files on this computer has not been verified yet.`;
}

const stateUrl = (draftId) => `/api/drafts/${draftId}/deletion`;
const deleteUrl = (draftId) => `/api/drafts/${draftId}/delete`;
const bodyOf = (attempt) => JSON.stringify({ requestId: attempt.requestId, impactSha256: attempt.impactSha256, confirmDeletion: true });
const post = (draftId, attempt) => request(deleteUrl(draftId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: bodyOf(attempt) });

// The current deletion state of one place: { deleted: record } | { present:
// review } | null when it could not be read.
export async function readDeletion(draftId) {
  const result = await request(stateUrl(draftId));
  if (!result.ok) return null;
  if (validRecord(result.body, draftId)) return { deleted: result.body };
  if (result.body?.draftId === draftId && result.body.state === 'present' && SHA.test(result.body.impactSha256 ?? '') && validInventory(result.body.inventory)) {
    return { present: { impactSha256: result.body.impactSha256, inventory: result.body.inventory } };
  }
  return null;
}

// Owner-scoped opaque attempt: { requestId, impactSha256 } only.
function attemptStore(storage, ownerId, draftId) {
  const key = ownerId ? `rehere:place-deletion-pending:${ownerId}:${draftId}` : null;
  return {
    read() {
      try {
        const value = key ? JSON.parse(storage()?.getItem(key) ?? 'null') : null;
        return value && UUID.test(value.requestId ?? '') && SHA.test(value.impactSha256 ?? '') ? { requestId: value.requestId, impactSha256: value.impactSha256 } : null;
      } catch {
        return null;
      }
    },
    write(attempt) {
      try {
        if (key) storage()?.setItem(key, JSON.stringify({ requestId: attempt.requestId, impactSha256: attempt.impactSha256 }));
      } catch {
        // Then only this page remembers it.
      }
    },
    clear() {
      try {
        if (key) storage()?.removeItem(key);
      } catch {
        // Nothing to clear.
      }
    },
  };
}

// Forgets this browser's stored request for a place whose deletion record was
// read: the place no longer exists, so that request can never apply to it.
export function forgetAttempt(storage, ownerId, draftId) {
  attemptStore(storage, ownerId, draftId).clear();
}

// The disclosure at the end of a saved place. onDeleting() is called on the
// final press, before the answer: the page closes the scene, audio and rename.
// onAccepted(record) gets this place's deletion record; onStillPresent(notice)
// asks the page to read the place again after a definite refusal.
export function mountPlaceRemoval(container, { draftId, ownerId, storage, onDeleting, onAccepted, onStillPresent }) {
  let alive = true;
  let token = 0;
  const store = attemptStore(storage, ownerId, draftId);
  // A request whose answer is not known; repeated exactly until settled.
  let attempt = store.read();
  let review = null;
  let phase = attempt ? 'checking' : 'idle';
  let message = '';
  let busy = false;
  const ack = el('input', { type: 'checkbox' });
  const view = el('div');
  const details = el('details', { className: 'source-details place-removal', open: Boolean(attempt) }, [el('summary', { textContent: 'Delete this place from this computer…' }), view]);
  container.replaceChildren(details);
  const live = (mine) => alive && mine === token;

  function render() {
    if (!alive) return;
    const nodes = [];
    if (phase === 'unknown' || phase === 'checking') {
      nodes.push(el('p', { className: 'hint', role: 'status', textContent: phase === 'checking' ? 'Checking an earlier deletion request from this browser…' : message || UNCONFIRMED }));
      if (phase === 'unknown') {
        nodes.push(
          el('div', { className: 'actions' }, [
            el('button', { type: 'button', className: 'secondary', textContent: 'Check earlier deletion', disabled: busy, onclick: check }),
            el('button', { type: 'button', textContent: 'Delete again (same request)', disabled: busy, onclick: send }),
          ]),
        );
      }
    } else if (review) {
      ack.disabled = busy;
      nodes.push(
        el('p', { textContent: `Deleting removes this place and everything this app keeps for it on this computer: ${inventoryText(review.inventory)}.` }),
        el('p', {
          className: 'hint',
          textContent:
            'Local copies of contributions received for this place are removed too. This is not a withdrawal made for the people who sent them, and their own copies elsewhere are not affected. Every visitor link and invitation for this place stops for good.',
        }),
        el('p', { className: 'hint', textContent: 'Unsaved changes on this screen, such as scene edits, previews or an open rename, are discarded when you confirm.' }),
        el('p', { className: 'hint', textContent: LIMITS }),
        el('p', { className: 'hint', textContent: 'No use permission or public-origin rule changes, and nothing is published.' }),
        el('label', { className: 'memory-consent' }, [ack, ' I understand this deletes this place from this computer and cannot be undone']),
        el('div', { className: 'actions' }, [
          el('button', { type: 'button', className: 'secondary', textContent: 'Keep this place', disabled: busy, onclick: keep }),
          el('button', { type: 'button', textContent: 'Delete this place permanently', disabled: busy || ack.checked !== true, onclick: confirm }),
        ]),
      );
    } else if (phase === 'loading') {
      nodes.push(el('p', { className: 'hint', role: 'status', textContent: 'Reading what deleting this place would remove…' }));
    } else if (phase === 'unavailable') {
      nodes.push(el('p', { className: 'hint', textContent: `${message} Nothing was deleted.` }), el('div', { className: 'actions' }, [el('button', { type: 'button', className: 'secondary', textContent: 'Try reading it again', onclick: load })]));
    }
    if (message && phase !== 'unknown' && phase !== 'unavailable') nodes.push(el('p', { className: 'form-message', role: 'alert', textContent: message }));
    view.replaceChildren(...nodes);
  }
  ack.addEventListener('change', render);

  // Opening only reads what deleting would remove.
  async function load() {
    const mine = ++token;
    review = null;
    ack.checked = false;
    phase = 'loading';
    render();
    const result = await request(stateUrl(draftId));
    if (!live(mine)) return;
    if (result.ok && validRecord(result.body, draftId)) {
      store.clear();
      onAccepted(result.body);
      return;
    }
    if (result.ok && result.body?.draftId === draftId && result.body.state === 'present' && SHA.test(result.body.impactSha256 ?? '') && validInventory(result.body.inventory)) {
      review = { impactSha256: result.body.impactSha256, inventory: result.body.inventory };
      phase = 'review';
    } else {
      phase = 'unavailable';
      message = reasonOf(result) || 'Rehere could not show what deleting this place would remove.';
    }
    render();
  }
  details.addEventListener('toggle', () => {
    if (details.open && phase === 'idle') load();
  });

  function keep() {
    token += 1;
    review = null;
    ack.checked = false;
    phase = 'idle';
    message = '';
    details.open = false;
    render();
  }

  function confirm() {
    if (busy || !review || ack.checked !== true) return;
    attempt = { requestId: crypto.randomUUID(), impactSha256: review.impactSha256 };
    store.write(attempt);
    send();
  }

  // Sends the one prepared request. The scene and its unsaved state close
  // first; whatever the answer, the removed place is not shown again.
  async function send() {
    if (busy || !attempt) return;
    const mine = ++token;
    busy = true;
    message = 'Deleting this place…';
    render();
    onDeleting();
    const sent = attempt;
    const result = await post(draftId, sent);
    if (!live(mine)) return;
    busy = false;
    if (result.ok && validRecord(result.body, draftId, sent)) {
      settle(result.body);
      return;
    }
    if (!result.ok && reasonOf(result) && result.status < 500) {
      // A readable refusal: what is true now decides, never the status alone.
      await reconcile(mine, `${reasonOf(result)} This request was not applied to the place as it is now. Review it again before deleting.`);
      return;
    }
    phase = 'unknown';
    message = UNCONFIRMED;
    render();
  }

  // After a readable refusal: a deletion found now is shown; a place still
  // present needs a new explicit review; an unreadable state stays uncertain.
  async function reconcile(mine, notice) {
    const state = await readDeletion(draftId);
    if (!live(mine)) return;
    if (state?.deleted) {
      settle(state.deleted);
      return;
    }
    if (state?.present) {
      attempt = null;
      store.clear();
      review = null;
      ack.checked = false;
      phase = 'idle';
      message = '';
      details.open = false;
      render();
      onStillPresent(notice);
      return;
    }
    phase = 'unknown';
    message = `${UNCONFIRMED} Its current state could not be read.`;
    render();
  }

  // Check only reads. A place still present does not show that the earlier
  // request was refused, so it stays the one request to repeat.
  async function check() {
    if (busy || !attempt) return;
    const mine = ++token;
    busy = true;
    render();
    const state = await readDeletion(draftId);
    if (!live(mine)) return;
    busy = false;
    if (state?.deleted) {
      settle(state.deleted);
      return;
    }
    phase = 'unknown';
    message = state?.present
      ? 'This place is still here, but the earlier request may still be accepted. Delete again repeats exactly that request.'
      : `${UNCONFIRMED} Its current state could not be read.`;
    render();
  }

  function settle(record) {
    attempt = null;
    store.clear();
    onAccepted(record);
  }

  render();
  // A stored request is reconciled before anything new is offered.
  if (attempt) check();
  return {
    // A re-read of the same place after a definite refusal closes any review.
    dispose() {
      alive = false;
      token += 1;
      container.replaceChildren();
    },
  };
}

// Removals whose local cleanup is still finishing, content-free, with Check
// and an explicit retry of each accepted request.
export function mountPendingDeletions(container, { onComplete = () => {} } = {}) {
  let alive = true;
  let seq = 0;
  const notes = new Map();
  let items = [];

  function render() {
    if (!alive) return;
    if (!items.length) {
      container.replaceChildren();
      return;
    }
    container.replaceChildren(
      el('h3', { textContent: 'Places still being deleted' }),
      el(
        'ul',
        { className: 'collab-list' },
        items.map((record) => {
          const item = el('li', {}, [el('p', { className: 'hint', textContent: `${deletionText(record)} Recorded when deletion was requested: ${inventoryText(record.inventory, { receipt: true })}.` })]);
          const check = el('button', { type: 'button', className: 'secondary', textContent: 'Check' });
          const retry = el('button', { type: 'button', className: 'secondary', textContent: 'Retry local cleanup' });
          check.addEventListener('click', async () => {
            check.disabled = true;
            const state = await readDeletion(record.draftId);
            if (!alive) return;
            check.disabled = false;
            notes.set(record.draftId, state?.deleted ? (state.deleted.state === 'complete' ? 'Local cleanup finished.' : 'Local cleanup is still not finished. Every use stays stopped.') : 'The deletion state could not be read. Every use stays stopped.');
            if (state?.deleted?.state === 'complete') onComplete(state.deleted);
            await load();
          });
          retry.addEventListener('click', async () => {
            retry.disabled = true;
            const result = await post(record.draftId, record);
            if (!alive) return;
            retry.disabled = false;
            notes.set(
              record.draftId,
              result.ok && validRecord(result.body, record.draftId, record)
                ? result.body.state === 'complete'
                  ? 'Local cleanup finished.'
                  : 'Local cleanup is still not finished. Every use stays stopped; you can try again later.'
                : `${reasonOf(result) ? `${reasonOf(result)} ` : ''}Rehere could not confirm the cleanup retry. Every use stays stopped.`,
            );
            if (result.ok && validRecord(result.body, record.draftId, record) && result.body.state === 'complete') onComplete(result.body);
            await load();
          });
          item.append(el('div', { className: 'actions' }, [check, retry]));
          if (notes.has(record.draftId)) item.append(el('p', { className: 'form-message', textContent: notes.get(record.draftId) }));
          return item;
        }),
      ),
    );
  }

  async function load() {
    const mine = ++seq;
    const result = await request('/api/place-deletions');
    if (!alive || mine !== seq) return;
    // Only well-formed pending records are listed; a failed read keeps the last list.
    if (result.ok && Array.isArray(result.body?.items)) items = result.body.items.filter((record) => record?.state === 'access-stopped' && validRecord(record, record.draftId));
    render();
  }

  return {
    load,
    dispose() {
      alive = false;
      seq += 1;
      items = [];
      container.replaceChildren();
    },
  };
}
