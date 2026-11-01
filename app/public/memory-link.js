// The owner's link from one confirmed scene object to the place's whole saved
// written memory. A link is the owner's own judgment that these exact words
// are about this object: not a model reading, a date or proof of the past.
// The words shown always come from the server's fresh read under the current
// source rights, never from text this page loaded earlier. Nothing here calls
// a model or a share route, and nothing is kept in browser storage.

const REASONS = Object.freeze({
  source: 'Its use to reconstruct this place is not allowed now, or its use was stopped. The link is kept; the words are not shown.',
  checksum: 'The saved writing no longer matches what was linked, so the words are not shown.',
  unreadable: 'The saved writing could not be read, so the words are not shown.',
});
const SOURCE_REASONS = Object.freeze({
  source: 'The saved written memory cannot be linked now: its use to reconstruct this place is not allowed, or its use was stopped.',
  checksum: 'The saved written memory no longer matches its recorded checksum, so it cannot be linked.',
  unreadable: 'The saved written memory could not be read, so it cannot be linked.',
});
const MEANING = 'Linking is your own judgment that these exact words are about this object. It is not a model reading, a date or proof of how the place was.';
const UNREADABLE = 'The written memory link could not be read right now. This does not mean it is unlinked.';
const UNCONFIRMED = 'Rehere could not confirm this change. It may have been saved. Repeating it sends exactly the same request.';

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
const reasonValid = (reason) => reason === null || Object.hasOwn(REASONS, reason);
const when = (iso) => new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

// Only a projection for exactly this place, scene and object, internally
// consistent, is shown; anything else is "could not be read", never unlinked.
export function validProjection(body, { draftId, jobId, objectId }) {
  if (body?.draftId !== draftId || body.jobId !== jobId || body.objectId !== objectId || !Number.isInteger(body.revision) || body.revision < 0) return false;
  const source = body.source;
  if (source !== null) {
    if (typeof source?.sourceId !== 'string' || typeof source.available !== 'boolean' || !reasonValid(source.reason)) return false;
    if (source.available ? typeof source.text !== 'string' || source.reason !== null : source.text !== null || source.reason === null) return false;
  }
  const link = body.link;
  if (link !== null) {
    if (typeof link?.sourceId !== 'string' || typeof link.available !== 'boolean' || !reasonValid(link.reason) || !Number.isFinite(Date.parse(link.linkedAt))) return false;
    if (link.available ? link.reason !== null || source?.available !== true || source.sourceId !== link.sourceId : link.reason === null) return false;
  }
  return true;
}

function validReceipt(body, ids) {
  return validProjection(body, ids) && typeof body.changed === 'boolean' && typeof body.replayed === 'boolean'
    && Number.isSafeInteger(body.appliedRevision) && body.appliedRevision >= 0 && body.appliedRevision <= body.revision
    && (body.replayed ? body.changed === false : body.appliedRevision === body.revision);
}

// options: { jobUrl, draftId, jobId, objectId, name }.
export function mountMemoryLink(container, { jobUrl, draftId, jobId, objectId, name }) {
  let alive = true;
  let readSeq = 0;
  let data = null;
  let readError = null;
  let message = '';
  let busy = false;
  // 'idle' | 'review' (exact words shown for linking) | 'remove' (second confirmation)
  let mode = 'idle';
  // A prepared request whose answer is not known; repeated exactly until a
  // definite answer or the owner explicitly abandons it.
  let attempt = null;
  const ids = { draftId, jobId, objectId };
  const url = `${jobUrl}/objects/${encodeURIComponent(objectId)}/memory-link`;
  const confirm = el('input', { type: 'checkbox' });
  const root = el('div', { className: 'memory-link' });
  container.replaceChildren(root);

  const words = (text) => el('p', { className: 'memory-text', textContent: text });

  function render() {
    if (!alive) return;
    const nodes = [el('h4', { textContent: 'Saved written memory' })];
    if (readError) {
      nodes.push(el('p', { className: 'hint', role: 'status', textContent: readError }), el('div', { className: 'actions' }, [el('button', { type: 'button', className: 'secondary', textContent: 'Read it again', disabled: busy, onclick: () => load() })]));
    } else if (!data) {
      nodes.push(el('p', { className: 'hint', role: 'status', textContent: 'Reading the saved written memory…' }));
    } else {
      nodes.push(...body());
    }
    if (attempt) {
      nodes.push(
        el('p', { className: 'form-message', role: 'alert', textContent: UNCONFIRMED }),
        el('div', { className: 'actions' }, [
          el('button', { type: 'button', className: 'secondary', textContent: 'Check', disabled: busy, onclick: () => load() }),
          el('button', { type: 'button', className: 'secondary', textContent: 'Abandon this request', disabled: busy, onclick: abandon }),
          el('button', { type: 'button', textContent: attempt.action === 'set' ? 'Link again (same request)' : 'Remove again (same request)', disabled: busy, onclick: send }),
        ]),
      );
    } else if (message) nodes.push(el('p', { className: 'form-message', role: 'alert', textContent: message }));
    root.replaceChildren(...nodes);
  }

  function body() {
    const { source, link } = data;
    const nodes = [];
    if (link) {
      if (link.available) {
        nodes.push(
          el('p', { className: 'hint', textContent: `Linked by you to ${name} on ${when(link.linkedAt)}. ${MEANING}` }),
          words(source.text),
        );
      } else {
        // The words of an unavailable link are never shown as linked.
        nodes.push(el('p', { className: 'hint', textContent: `A written memory is linked to ${name}. ${REASONS[link.reason]}` }));
      }
      if (attempt) return nodes;
      if (mode === 'remove') {
        nodes.push(
          el('p', { className: 'hint', textContent: 'Remove this link? The written memory and the scene stay as they are.' }),
          el('div', { className: 'actions' }, [
            el('button', { type: 'button', className: 'secondary', textContent: 'Keep the link', disabled: busy, onclick: () => ((mode = 'idle'), render()) }),
            el('button', { type: 'button', textContent: 'Remove this link', disabled: busy, onclick: () => prepare('remove', link.sourceId) }),
          ]),
        );
      } else nodes.push(el('div', { className: 'actions' }, [el('button', { type: 'button', className: 'secondary', textContent: 'Remove link', disabled: busy, onclick: () => ((mode = 'remove'), (message = ''), render()) })]));
      return nodes;
    }
    if (!source) {
      nodes.push(el('p', { className: 'hint', textContent: 'This place has no saved written memory that can be linked.' }));
      return nodes;
    }
    if (!source.available) {
      nodes.push(el('p', { className: 'hint', textContent: SOURCE_REASONS[source.reason] }));
      return nodes;
    }
    nodes.push(el('p', { className: 'hint', textContent: `Your saved written memory is not linked to ${name}.` }));
    if (attempt) return nodes;
    if (mode === 'review') {
      confirm.disabled = busy;
      nodes.push(
        el('p', { className: 'hint', textContent: `${MEANING} The whole saved writing is linked, exactly as saved:` }),
        words(source.text),
        el('label', { className: 'memory-consent' }, [confirm, ' These words are about this object']),
        el('div', { className: 'actions' }, [
          el('button', { type: 'button', className: 'secondary', textContent: 'Not now', disabled: busy, onclick: () => ((mode = 'idle'), (confirm.checked = false), render()) }),
          el('button', { type: 'button', textContent: 'Link', disabled: busy || confirm.checked !== true, onclick: () => prepare('set', source.sourceId) }),
        ]),
      );
    } else {
      nodes.push(el('div', { className: 'actions' }, [el('button', { type: 'button', className: 'secondary', textContent: `Link your saved written memory to ${name}`, disabled: busy, onclick: () => ((mode = 'review'), (confirm.checked = false), (message = ''), render()) })]));
    }
    return nodes;
  }
  confirm.addEventListener('change', render);

  function prepare(action, sourceId) {
    if (busy || !data || attempt) return;
    if (action === 'set' && confirm.checked !== true) return;
    attempt = { action, body: { requestId: crypto.randomUUID(), baseRevision: data.revision, action, sourceId, confirmed: true } };
    send();
  }

  function abandon() {
    attempt = null;
    message = 'The unconfirmed request was abandoned here. It may still have been saved; the current state is read again.';
    mode = 'idle';
    load();
  }

  async function send() {
    if (busy || !attempt) return;
    const sent = attempt;
    const mine = ++readSeq;
    busy = true;
    message = '';
    render();
    const result = await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sent.body) });
    if (!alive || attempt !== sent) return;
    busy = false;
    const reason = reasonOf(result);
    if (result.ok && validReceipt(result.body, ids)) {
      attempt = null;
      if (mine === readSeq) data = result.body;
      readError = null;
      mode = 'idle';
      confirm.checked = false;
      // The answer names the current state, which a replay may show changed since.
      const linked = data.link?.sourceId === sent.body.sourceId;
      message =
        sent.action === 'set'
          ? linked
            ? result.body.changed === false && result.body.replayed !== true
              ? 'It was already linked, so nothing changed.'
              : 'Linked.'
            : 'That link was recorded earlier and has changed since. The current state is shown.'
          : linked
            ? 'That removal was recorded earlier, and it has been linked again since. The current state is shown.'
            : 'Link removed. The written memory and the scene are unchanged.';
      render();
      return;
    }
    // Only the server's own readable refusal is definite.
    if (!result.ok && reason && result.status < 500) {
      attempt = null;
      if (result.status === 409) {
        // Changed elsewhere: show what is true now; the open review and its tick stay for an explicit new save.
        message = `${reason} The current state is shown; save again to change it.`;
        await load();
        return;
      }
      message = `${reason} Nothing was changed.`;
      mode = 'idle';
      confirm.checked = false;
      render();
      return;
    }
    render();
  }

  // A read never settles an unconfirmed request; it only shows what is there.
  async function load() {
    const seq = ++readSeq;
    busy = true;
    render();
    const result = await request(url);
    if (!alive || seq !== readSeq) return;
    busy = false;
    if (result.ok && validProjection(result.body, ids)) {
      if (mode === 'review' && (data?.source?.sourceId !== result.body.source?.sourceId || data?.source?.text !== result.body.source?.text)) {
        confirm.checked = false;
      }
      data = result.body;
      readError = null;
      // A review needs words that can still be linked.
      if (mode === 'review' && !(data.source?.available && !data.link)) mode = 'idle';
      if (mode === 'remove' && !data.link) mode = 'idle';
    } else {
      data = null;
      readError = result.status === 0 || result.status >= 500 || !reasonOf(result) ? UNREADABLE : `${reasonOf(result)} Nothing was changed.`;
    }
    render();
  }

  render();
  load();
  return {
    dispose() {
      alive = false;
      readSeq += 1;
      attempt = null;
      container.replaceChildren();
    },
  };
}
