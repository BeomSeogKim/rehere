// The owner's optional check of one memory's written note against photos of
// the same memory. A hosted model points at a part of the note and a region
// of one chosen photo; the server checks both, and the owner decides whether
// to keep each result. Nothing here is shared with visitors.

const LIMIT_TEXT = 'A result shows only whether these photos visibly agree or disagree with a part of the note. It is not proof of what happened, and "not visible" never means a part is false.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const photoName = (photos, sourceId) => {
  const index = photos.findIndex((item) => item.sourceId === sourceId);
  return index < 0 ? 'a photo that is no longer shown' : `photo ${photos[index].index + 1}`;
};

// One plain line per finding, for screen readers and tests.
export function verdictText(finding, photos) {
  const where = finding.sourceId ? photoName(photos, finding.sourceId) : null;
  if (finding.verdict === 'supports') return `Visible support in ${where}`;
  if (finding.verdict === 'conflicts') return `Visible conflict in ${where}`;
  return where ? `Not visible in these photos (closest region: ${where})` : 'Not visible in these photos';
}

// Parts of the note no finding covered, so a partial check is never read as
// a check of the whole note. Returns the uncovered text, trimmed, or ''.
export function uncheckedText(note, findings) {
  const covered = new Array(note.length).fill(false);
  for (const { part } of findings) {
    const start = note.indexOf(part);
    if (start >= 0) covered.fill(true, start, start + part.length);
  }
  const rest = [];
  let current = '';
  for (let i = 0; i < note.length; i += 1) {
    if (covered[i]) {
      if (current.trim()) rest.push(current.trim());
      current = '';
    } else current += note[i];
  }
  if (current.trim()) rest.push(current.trim());
  return rest.filter((item) => /[\p{L}\p{N}]/u.test(item)).join(' … ');
}

export function callText(call) {
  if (!call) return 'No model answer was recorded.';
  const parts = [`Model: ${call.model ?? 'not returned'}`, `response ID: ${call.responseId ?? 'not returned'}`];
  if (Number.isInteger(call.latencyMs)) parts.push(`${call.latencyMs} ms`);
  parts.push(call.usage ? `${call.usage.inputTokens} input and ${call.usage.outputTokens} output tokens, estimated $${call.usage.estimatedUsd.toFixed(5)} (an estimate, not the bill)` : 'usage not returned');
  return parts.join(' · ');
}

export function decisionText(decision, formatDate = (value) => value) {
  if (!decision) return '';
  const who = decision.by?.displayName || 'the owner';
  return decision.choice === 'accepted' ? `Kept by ${who} on ${formatDate(decision.at)}.` : `Dismissed by ${who} on ${formatDate(decision.at)}.`;
}

export function mountEvidenceReview(container, { draftId, note, photos, fetch = globalThis.fetch, doc = document, formatDate = (value) => value, randomId = () => crypto.randomUUID() }) {
  let disposed = false;
  let state = null;
  let choosing = false;
  let sending = null;
  let message = '';
  const chosen = new Set();
  const el = (tag, props = {}, children = []) => {
    const node = doc.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
  };
  const button = (text, onClick, props = {}) => {
    const node = el('button', { type: 'button', textContent: text, ...props });
    node.addEventListener('click', onClick);
    return node;
  };
  const read = async (response) => {
    try {
      return await response.json();
    } catch {
      return null;
    }
  };

  async function load() {
    let next = null;
    try {
      const response = await fetch(`/api/drafts/${draftId}/evidence-reviews`);
      next = response.ok ? await read(response) : null;
    } catch {}
    if (disposed) return;
    state = next;
    render();
  }

  async function send() {
    if (sending || chosen.size === 0) return;
    // The same request ID is reused only if this exact send is repeated.
    sending = { requestId: randomId(), sourceIds: photos.filter((item) => chosen.has(item.sourceId)).map((item) => item.sourceId) };
    message = 'Waiting for Muse Spark. Nothing is kept until it answers and you decide.';
    render();
    let answer = null;
    let status = 0;
    try {
      const response = await fetch(`/api/drafts/${draftId}/evidence-reviews`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...sending, consent: true }),
      });
      status = response.status;
      answer = await read(response);
    } catch {}
    if (disposed) return;
    sending = null;
    choosing = false;
    if (status === 200 || status === 201) {
      message = answer?.review?.status === 'answered' ? 'Muse Spark answered. Review each part below, then keep or dismiss the result.' : (answer?.review?.error ?? '');
    } else {
      message = answer?.error ?? 'The check could not be completed. A request that was already sent may still count toward usage.';
    }
    await load();
  }

  async function decide(review, choice) {
    let answer = null;
    let ok = false;
    try {
      const response = await fetch(`/api/drafts/${draftId}/evidence-reviews/${review.id}/decision`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ choice }),
      });
      ok = response.ok;
      answer = await read(response);
    } catch {}
    if (disposed) return;
    message = ok ? '' : (answer?.error ?? 'The decision could not be saved.');
    await load();
  }

  function cropView(finding) {
    const photo = photos.find((item) => item.sourceId === finding.sourceId);
    if (!photo || !finding.crop) return null;
    const [x0, y0, x1, y1] = finding.crop;
    const frame = el('div', { className: 'evidence-crop-frame' });
    const image = el('img', { src: photo.url, alt: `Photo ${photo.index + 1}, with the region the model pointed at outlined` });
    const box = el('span', { className: `evidence-crop evidence-${finding.verdict}` });
    box.setAttribute('aria-hidden', 'true');
    const percent = (value) => `${Number((value * 100).toFixed(3))}%`;
    box.style.left = percent(x0);
    box.style.top = percent(y0);
    box.style.width = percent(x1 - x0);
    box.style.height = percent(y1 - y0);
    frame.append(image, box);
    return frame;
  }

  function reviewView(review) {
    const item = el('li', { className: 'evidence-item' });
    item.append(el('p', { className: 'hint', textContent: `${formatDate(review.createdAt)} · sent ${review.sourceIds.map((id) => photoName(photos, id)).join(', ')}` }));
    if (!review.available) {
      item.append(el('p', { textContent: 'This check used material that is stopped or no longer usable here, so its result is not shown.' }));
    } else if (review.status === 'answered' && review.result) {
      const list = el('ol', { className: 'evidence-findings' });
      for (const finding of review.result.findings) {
        const crop = cropView(finding);
        list.append(el('li', { className: `evidence-finding evidence-${finding.verdict}` }, [
          el('q', { textContent: finding.part }),
          el('p', { className: 'evidence-verdict', textContent: verdictText(finding, photos) }),
          el('p', { textContent: finding.observation }),
          ...(crop ? [crop] : []),
        ]));
      }
      item.append(list);
      const unchecked = uncheckedText(note, review.result.findings);
      if (unchecked) item.append(el('p', { className: 'evidence-unchecked', textContent: `Not checked: ${unchecked}` }));
      item.append(el('p', { className: 'evidence-uncertainty', textContent: `What these photos cannot settle: ${review.result.uncertainty}` }));
    } else {
      item.append(el('p', { className: 'form-message', textContent: review.error ?? 'No result is offered.' }));
    }
    item.append(el('p', { className: 'hint evidence-call', textContent: callText(review.call) }));
    if (review.decision) item.append(el('p', { className: 'evidence-decision', textContent: decisionText(review.decision, formatDate) }));
    else if (review.status === 'answered' && review.available) {
      item.append(el('div', { className: 'evidence-actions' }, [
        button('Keep this result', () => decide(review, 'accepted')),
        button('Dismiss', () => decide(review, 'dismissed')),
      ]));
    }
    return item;
  }

  function render() {
    if (disposed) return;
    const reviews = Array.isArray(state?.reviews) ? state.reviews : [];
    // Hidden unless the check is set up here or earlier results exist.
    if (!state || (!state.enabled && reviews.length === 0) || !note) {
      container.replaceChildren();
      return;
    }
    const section = el('section', { className: 'evidence-review' });
    section.setAttribute('aria-label', 'Check this note against its photos');
    section.append(el('h3', { textContent: 'Check this note against its photos' }), el('p', { className: 'hint', textContent: LIMIT_TEXT }));
    const usable = (state.photos ?? []).filter((item) => UUID.test(item.sourceId));
    if (state.enabled) {
      if (!state.note?.modelAllowed) section.append(el('p', { className: 'hint', textContent: 'Model use is off for the written note, so it cannot be checked.' }));
      else if (state.note.tooLong) section.append(el('p', { className: 'hint', textContent: 'This note is too long for a bounded check.' }));
      else if (!choosing) section.append(button('Check the note against photos…', () => { choosing = true; render(); }));
      else {
        const fieldset = el('fieldset', {}, [el('legend', { textContent: 'Photos to send' })]);
        for (const item of usable) {
          const label = `Photo ${item.index + 1}`;
          if (!item.modelAllowed) {
            fieldset.append(el('p', { className: 'hint', textContent: `${label}: model use is off, so it is never sent.` }));
            continue;
          }
          const box = el('input', { type: 'checkbox', checked: chosen.has(item.sourceId), disabled: Boolean(sending) });
          box.addEventListener('change', () => {
            if (box.checked) chosen.add(item.sourceId);
            else chosen.delete(item.sourceId);
            render();
          });
          fieldset.append(el('label', {}, [box, ` ${label}`]));
        }
        section.append(fieldset, el('p', { className: 'hint', textContent: `The note and the ${chosen.size === 1 ? 'chosen photo are' : `${chosen.size} chosen photos are`} sent once to Meta's Muse Spark model. Nothing else about this memory is sent, and a failed check is not repeated automatically.` }));
        section.append(el('div', { className: 'evidence-actions' }, [
          button('Send once for a check', send, { disabled: Boolean(sending) || chosen.size === 0 }),
          button('Cancel', () => { choosing = false; message = ''; render(); }, { disabled: Boolean(sending) }),
        ]));
      }
    }
    const status = el('p', { className: 'form-message', textContent: message });
    status.setAttribute('role', 'status');
    section.append(status);
    if (reviews.length) section.append(el('ol', { className: 'evidence-list', reversed: true }, reviews.map(reviewView)));
    container.replaceChildren(section);
  }

  load();
  return {
    dispose() {
      disposed = true;
    },
    reload: load,
  };
}
