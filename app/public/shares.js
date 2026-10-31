// The owner's sharing panel inside a ready scene: choose what visitors may
// see, preview it with the real visitor screen, then explicitly issue a local
// link, list and revoke. The issued link is shown only from the token this
// page generated; the server never returns it.

import { mountVisitor, previewSource } from './visits.js';

export const TITLE_LIMIT = 120;
export const QUOTE_LIMIT = 20;
export const VIEW_LIMIT = 8;
const QUOTABLE = new Set(['submitted', 'adopted', 'alternative']);

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function visitToken(crypto = globalThis.crypto) {
  return `rhv_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

// The link works only where this page is served from; the token lives only in
// the fragment, which browsers never send to a server.
export const visitLink = (origin, token) => `${origin}/#/visit/${token}`;

// A recollection can be quoted only if its writer allowed both reconstruction
// and sharing and it is still in use.
export const quotable = (entry) => QUOTABLE.has(entry.status) && typeof entry.text === 'string' && entry.permissions?.place === true && entry.permissions?.share === true;

export function previewProblem({ title, views, startViewId, camera, contributionIds }) {
  if (!title.trim()) return 'Give the shared view a title.';
  if ([...title].length > TITLE_LIMIT) return `Keep the title to ${TITLE_LIMIT} characters or fewer.`;
  if (views.length < 1) return 'Choose at least one view to share.';
  if (views.length > VIEW_LIMIT) return `Choose ${VIEW_LIMIT} views or fewer.`;
  if (!views.some((view) => view.id === startViewId)) return 'Choose which view visitors see first.';
  if (!camera) return 'Capture the camera view first, from the 3D scene above.';
  if (contributionIds.length > QUOTE_LIMIT) return `Quote ${QUOTE_LIMIT} recollections or fewer.`;
  return null;
}

const STATUS_TEXT = { active: 'Active', revoked: 'Revoked', suspended: 'Suspended', expired: 'Expired' };

function el(tag, { onclick, ...props } = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  if (onclick) node.addEventListener('click', onclick);
  node.append(...children);
  return node;
}

let fieldCount = 0;
function field(labelText, input, hintText = '') {
  input.id = `share-field-${++fieldCount}`;
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
const withReason = (result, note) => (reasonOf(result) ? `${reasonOf(result)} ${note}` : note);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const when = (iso) => new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

// bridge: { sharesUrl, jobUrl, editor() -> { version }, getCamera() ->
// { position, target } | null when no 3D view is open }.
export function mountShares(container, bridge) {
  let disposed = false;
  let collaboration = null;
  let camera = null;
  let preview = null;
  let previewView = null;
  let previewState = null;
  let issuedFor = null;
  let previewAttempt = null;
  let issueAttempt = null;
  let revokeAttempt = null;
  const viewIds = new Map();
  const idFor = (key) => {
    if (!viewIds.has(key)) viewIds.set(key, crypto.randomUUID());
    return viewIds.get(key);
  };

  const title = el('input', { type: 'text', maxLength: 200 });
  const synthetic = el('input', { type: 'checkbox' });
  const viewList = el('div');
  const startSelect = el('select');
  const quoteList = el('div');
  const cameraNote = el('p', { className: 'hint', textContent: 'No camera view captured yet.' });
  const captureButton = el('button', { type: 'button', className: 'secondary', textContent: 'Use the current camera view' });
  const previewButton = el('button', { type: 'button', textContent: 'Preview what visitors will see' });
  const previewBox = el('div', { className: 'share-preview' });
  const issueBox = el('div');
  const message = el('p', { className: 'form-message', role: 'alert' });
  const list = el('ul', { className: 'collab-list' });
  let viewBoxes = [];
  let quoteBoxes = [];

  container.replaceChildren(
    el('details', { className: 'source-details share-panel' }, [
      el('summary', { textContent: 'Share a saved view with visitors' }),
      el('p', {
        className: 'hint',
        textContent:
          'Visitors see only what you choose here, without signing in, and cannot change anything. The link works only on this computer’s local address; nothing is published on the internet. Uses that a photo’s or a recollection’s provider did not allow cannot be added here.',
      }),
      field('Title visitors see', title),
      el('label', { className: 'memory-consent' }, [synthetic, ' Label this as synthetic test material']),
      el('fieldset', { className: 'source-permissions' }, [el('legend', { textContent: 'Views to share' }), viewList]),
      field('Visitors see first', startSelect),
      el('fieldset', { className: 'source-permissions' }, [
        el('legend', { textContent: 'Recollections to quote (optional)' }),
        el('p', { className: 'hint', textContent: 'Quoting shows the person’s own words. Only recollections whose writers allowed both reconstruction and sharing can be quoted.' }),
        quoteList,
      ]),
      el('div', { className: 'actions' }, [captureButton]),
      cameraNote,
      el('div', { className: 'actions' }, [previewButton]),
      message,
      previewBox,
      issueBox,
      el('h4', { textContent: 'Shared views' }),
      list,
    ]),
  );

  const selectedViews = () =>
    viewBoxes
      .filter(({ box }) => box.checked === true)
      .map(({ key, kind, variantId }) => ({ id: idFor(key), kind, version: kind === 'version' ? bridge.editor().version : null, variantId: kind === 'variant' ? variantId : null }));

  // Any change after a preview discards it: issue binds to the exact preview.
  function discardPreview(reason = '') {
    previewView?.dispose();
    previewView = null;
    preview = null;
    previewState = null;
    issueAttempt = null;
    previewBox.replaceChildren();
    issueBox.replaceChildren();
    if (reason) message.textContent = reason;
  }

  function renderStart() {
    const views = selectedViews();
    const previous = startSelect.value;
    const labels = new Map(viewBoxes.map(({ key, label }) => [idFor(key), label]));
    startSelect.replaceChildren(...views.map((view) => el('option', { value: view.id, textContent: labels.get(view.id) })));
    startSelect.value = views.some((view) => view.id === previous) ? previous : views[0]?.id ?? '';
  }

  function renderChoices() {
    const version = bridge.editor().version;
    const choices = [{ key: 'version', kind: 'version', label: `Current saved scene, version ${version}` }];
    for (const variant of collaboration?.variants ?? []) {
      if (!variant.blocked) choices.push({ key: variant.id, kind: 'variant', variantId: variant.id, label: variant.label });
    }
    const checked = new Set(viewBoxes.filter(({ box }) => box.checked === true).map(({ key }) => key));
    viewBoxes = choices.map((choice) => ({ ...choice, box: el('input', { type: 'checkbox', checked: checked.has(choice.key) || (checked.size === 0 && choice.key === 'version') }) }));
    viewList.replaceChildren(...viewBoxes.map(({ box, label }) => el('label', {}, [box, ` ${label}`])));
    for (const { box } of viewBoxes) {
      box.addEventListener('change', () => {
        renderStart();
        discardPreview();
      });
    }
    renderStart();

    const chosenQuotes = new Set(quoteBoxes.filter(({ box }) => box.checked === true).map(({ id }) => id));
    const eligible = (collaboration?.contributions ?? []).filter(quotable);
    quoteBoxes = eligible.map((entry) => ({ id: entry.id, entry, box: el('input', { type: 'checkbox', checked: chosenQuotes.has(entry.id) }) }));
    quoteList.replaceChildren(
      ...(quoteBoxes.length
        ? quoteBoxes.map(({ box, entry }) => el('label', {}, [box, ` ${entry.provider?.displayName || 'Someone'}: “${entry.text.length > 80 ? `${entry.text.slice(0, 80)}…` : entry.text}”`]))
        : [el('p', { className: 'hint', textContent: 'No recollection can be quoted.' })]),
    );
    for (const { box } of quoteBoxes) box.addEventListener('change', () => discardPreview());
  }

  function candidateInput() {
    return {
      title: title.value,
      views: selectedViews(),
      startViewId: startSelect.value,
      camera,
      contributionIds: quoteBoxes.filter(({ box }) => box.checked === true).map(({ id }) => id),
      synthetic: synthetic.checked === true,
    };
  }

  function renderIssue() {
    if (!preview) {
      issueBox.replaceChildren();
      return;
    }
    const consent = el('input', { type: 'checkbox' });
    const fallback = el('input', { type: 'checkbox' });
    const issue = el('button', { type: 'button', textContent: 'Issue a visitor link' });
    const refresh = () => {
      const rendered = previewState === '3d' || (previewState === '2d' && fallback.checked === true);
      issue.disabled = issuedFor === preview.id || !rendered || consent.checked !== true;
    };
    consent.addEventListener('change', refresh);
    fallback.addEventListener('change', refresh);
    issue.addEventListener('click', () => issueLink(issue));
    const nodes = [
      el('p', { className: 'hint', textContent: `This preview is not a link. It can be issued until ${when(preview.expiresAt)}.` }),
      el('label', { className: 'memory-consent' }, [consent, ' Visitors may see the selected reconstruction and my own time assertions']),
    ];
    if (previewState === '2d') {
      nodes.push(el('label', { className: 'memory-consent' }, [fallback, ' I checked the 2D fallback; the 3D view was not shown here']));
    }
    nodes.push(el('div', { className: 'actions' }, [issue]));
    issueBox.replaceChildren(...nodes);
    refresh();
  }

  async function makePreview() {
    const input = candidateInput();
    const problem = previewProblem(input);
    if (problem) {
      message.textContent = problem;
      return;
    }
    if (!previewAttempt || !sameJson(previewAttempt.input, input)) previewAttempt = { input, body: { requestId: crypto.randomUUID(), ...input } };
    discardPreview();
    message.textContent = '';
    previewButton.disabled = true;
    const result = await postJson(`${bridge.sharesUrl}/previews`, previewAttempt.body);
    if (disposed) return;
    previewButton.disabled = false;
    if (unclear(result)) {
      message.textContent = withReason(result, 'Rehere could not confirm the preview. Pressing Preview again repeats the same request.');
      return;
    }
    previewAttempt = null;
    if (!result.ok || !result.body?.id) {
      message.textContent = reasonOf(result) || 'This preview could not be made.';
      return;
    }
    if (!sameJson(candidateInput(), input)) return;
    preview = result.body;
    issuedFor = null;
    previewView = mountVisitor(previewBox, previewSource(bridge.sharesUrl, preview.id), {
      onState: (state) => {
        previewState = state;
        renderIssue();
      },
    });
    renderIssue();
  }

  async function issueLink(button) {
    const target = preview;
    if (!target || Date.now() >= Date.parse(target.expiresAt)) {
      message.textContent = 'This preview has expired. Make a new preview to issue a link.';
      return;
    }
    if (!issueAttempt || issueAttempt.previewId !== target.id) {
      issueAttempt = { previewId: target.id, body: { requestId: crypto.randomUUID(), previewId: target.id, previewDigest: target.digest, token: visitToken(), consent: true } };
    }
    const { body } = issueAttempt;
    button.disabled = true;
    const result = await postJson(bridge.sharesUrl, body);
    if (disposed) return;
    // An answer for a preview that is no longer shown never puts its link or
    // message under the newer one; the issued record, if any, is in the list.
    if (preview !== target) {
      message.textContent = result.ok
        ? 'A link was issued for an earlier preview that is no longer shown. It is listed under Shared views, where you can revoke it.'
        : 'A link request for an earlier preview did not clearly complete. Check Shared views below and revoke any link you do not want.';
      await loadList();
      return;
    }
    if (unclear(result)) {
      button.disabled = false;
      message.textContent = withReason(result, 'Rehere could not confirm the link. Pressing Issue again repeats the same request with the same link.');
      return;
    }
    if (!result.ok) {
      issueAttempt = null;
      button.disabled = false;
      message.textContent = reasonOf(result) || 'The link could not be issued.';
      return;
    }
    issueAttempt = null;
    issuedFor = target.id;
    const link = visitLink(location.origin, body.token);
    const copy = el('button', { type: 'button', className: 'secondary', textContent: 'Copy link' });
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(link);
        copy.textContent = 'Copied';
      } catch {
        copy.textContent = 'Copy failed; select the link instead';
      }
    });
    const done = el('button', { type: 'button', className: 'secondary', textContent: 'Done' });
    done.addEventListener('click', () => issueBox.replaceChildren());
    issueBox.replaceChildren(
      el('div', { className: 'access-keys' }, [
        el('p', {
          textContent: `Visitor link, shown only now. It works on this computer’s local address until ${when(result.body.expiresAt)} or until you revoke it. If you lose it, revoke this one and issue another.`,
        }),
        el('div', { className: 'access-key' }, [el('code', { textContent: link })]),
        el('div', { className: 'actions' }, [copy, done]),
      ]),
    );
    message.textContent = '';
    await loadList();
  }

  async function loadList() {
    const result = await request(bridge.sharesUrl);
    if (disposed) return;
    if (!result.ok || !Array.isArray(result.body)) {
      list.replaceChildren(el('li', { className: 'hint', textContent: 'Shared views could not be loaded.' }));
      return;
    }
    list.replaceChildren(
      ...result.body.map((share) => {
        const item = el('li', {}, [
          el('span', { className: 'space-choice-label', textContent: `${share.title} · ${STATUS_TEXT[share.status] ?? share.status}` }),
          el('span', { className: 'hint', textContent: `Issued ${when(share.createdAt)} · expires ${when(share.expiresAt)}${share.views?.length ? ` · ${share.views.map((view) => view.label).join(', ')}` : ''}` }),
        ]);
        if (share.reason) item.append(el('span', { className: 'hint', textContent: share.reason }));
        if (share.status === 'active' || share.status === 'suspended') item.append(revokeControl(share));
        return item;
      }),
    );
  }

  function revokeControl(share) {
    const wrap = el('div', { className: 'actions' });
    const start = el('button', { type: 'button', className: 'secondary', textContent: 'Revoke' });
    start.addEventListener('click', () => {
      const confirm = el('button', { type: 'button', textContent: 'Revoke this link' });
      const cancel = el('button', { type: 'button', className: 'secondary', textContent: 'Keep it', onclick: () => wrap.replaceChildren(start) });
      confirm.addEventListener('click', async () => {
        if (!revokeAttempt || revokeAttempt.id !== share.id) revokeAttempt = { id: share.id, body: { requestId: crypto.randomUUID() } };
        confirm.disabled = true;
        const result = await postJson(`${bridge.sharesUrl}/${share.id}/revoke`, revokeAttempt.body);
        if (disposed) return;
        confirm.disabled = false;
        if (unclear(result)) {
          message.textContent = withReason(result, 'Rehere could not confirm the revoke. Pressing it again repeats the same request.');
          return;
        }
        revokeAttempt = null;
        message.textContent = result.ok
          ? 'Revoked. Open visitor pages stop showing it at their next check; copies already saved on a device cannot be removed.'
          : reasonOf(result) || 'The link could not be revoked.';
        await loadList();
      });
      wrap.replaceChildren(el('p', { className: 'hint', textContent: 'Visitors lose access. A revoked link cannot be turned back on.' }), cancel, confirm);
    });
    wrap.append(start);
    return wrap;
  }

  title.addEventListener('input', () => discardPreview());
  synthetic.addEventListener('change', () => discardPreview());
  startSelect.addEventListener('change', () => discardPreview());
  captureButton.addEventListener('click', () => {
    const captured = bridge.getCamera();
    if (!captured) {
      cameraNote.textContent = 'The 3D view is not open, so no camera view can be captured.';
      return;
    }
    camera = { position: [...captured.position], target: [...captured.target] };
    cameraNote.textContent = 'Camera view captured from the scene above. Visitors start from it, and every shared view uses the same camera.';
    discardPreview();
  });
  previewButton.addEventListener('click', makePreview);

  (async () => {
    const result = await request(`${bridge.jobUrl}/collaboration`);
    if (disposed) return;
    collaboration = result.ok && Array.isArray(result.body?.variants) ? result.body : { variants: [], contributions: [] };
    renderChoices();
  })();
  loadList();

  return {
    // The saved version changed: views and quotes are chosen again.
    refresh() {
      discardPreview();
      request(`${bridge.jobUrl}/collaboration`).then((result) => {
        if (disposed) return;
        collaboration = result.ok && Array.isArray(result.body?.variants) ? result.body : collaboration;
        renderChoices();
      });
      loadList();
    },
    dispose() {
      disposed = true;
      discardPreview();
      container.replaceChildren();
    },
  };
}
