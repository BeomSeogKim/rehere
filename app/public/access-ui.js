// Sign-in, recovery and invitation enrollment for one private workspace. Keys
// live only in memory and in the access card the person saves: never in
// browser storage, URLs or the server's plain text. New keys are generated
// here with WebCrypto, and the card is offered before the request that makes
// them real, so a lost response cannot leave someone without working keys.

export const NAME_LIMIT = 80;

const PREFIX = { access: 'rha_', recovery: 'rhr_' };
const KEY = { access: /^rha_[A-Za-z0-9_-]{43}$/, recovery: /^rhr_[A-Za-z0-9_-]{43}$/, invitation: /^rhi_[A-Za-z0-9_-]{43}$/ };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CARD_TITLE = 'Rehere access card';
const CARD_FIELDS = [
  ['workspace', 'Workspace'],
  ['operation', 'Operation'],
  ['createdAt', 'Created'],
  ['name', 'Name'],
  ['accessKey', 'Access key'],
  ['recoveryKey', 'Recovery key'],
  ['token', 'Invitation code'],
  ['requestId', 'Request ID'],
];

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function newKey(kind, crypto = globalThis.crypto) {
  return PREFIX[kind] + base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function freshKeys(crypto = globalThis.crypto) {
  return { accessKey: newKey('access', crypto), recoveryKey: newKey('recovery', crypto) };
}

export function nameProblem(name) {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter a name others will see next to what you add.';
  if ([...trimmed].length > NAME_LIMIT) return `Use ${NAME_LIMIT} characters or fewer for your name.`;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) return 'Your name cannot contain control characters.';
  return null;
}

// The card is plain text a person can read, and also what a later import
// parses. A join card carries the original request so it can be repeated
// exactly; a recovery card carries only the new keys.
export function accessCard(card) {
  const lines = [CARD_TITLE, ''];
  for (const [key, label] of CARD_FIELDS) if (card[key] != null) lines.push(`${label}: ${card[key]}`);
  lines.push(
    '',
    'Keep this file private. The access key signs you in. The recovery key',
    'replaces both keys if the access key is lost. Rehere stores neither key',
    'and cannot show them again. Losing both keys means losing this access.',
  );
  if (card.operation === 'recovery') lines.push('Keep your previous card until you have signed in with the access key above.');
  lines.push('');
  return lines.join('\n');
}

const OWNER_CARD_FORMAT = 'rehere-owner-recovery-card';

// The owner card written by the command-line setup is JSON. Only the browser
// origin, creation time, name and keys are read; its data-folder path stays
// out of the page.
function parseOwnerCard(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: 'This file is not a Rehere access card.' };
  }
  if (raw?.format !== OWNER_CARD_FORMAT) return { error: 'This file is not a Rehere access card.' };
  if (!KEY.access.test(raw.accessKey ?? '') || !KEY.recovery.test(raw.recoveryKey ?? '')) return { error: 'The keys on this card are incomplete or damaged.' };
  if (typeof raw.displayName !== 'string') return { error: 'This owner card is incomplete.' };
  return {
    card: {
      operation: 'owner',
      workspace: typeof raw.origin === 'string' ? raw.origin : null,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
      name: raw.displayName,
      accessKey: raw.accessKey,
      recoveryKey: raw.recoveryKey,
    },
  };
}

export function parseAccessCard(text) {
  if (String(text).trimStart().startsWith('{')) return parseOwnerCard(String(text));
  const lines = String(text).split(/\r?\n/);
  if (lines[0] !== CARD_TITLE) return { error: 'This file is not a Rehere access card.' };
  const card = {};
  for (const line of lines.slice(1)) {
    const match = CARD_FIELDS.find(([, label]) => line.startsWith(`${label}: `));
    if (!match) continue;
    if (match[0] in card) return { error: 'This card has a repeated field and cannot be used.' };
    card[match[0]] = line.slice(match[1].length + 2);
  }
  if (!['enrollment', 'recovery'].includes(card.operation)) return { error: 'This card does not say which operation it belongs to.' };
  if (!KEY.access.test(card.accessKey ?? '') || !KEY.recovery.test(card.recoveryKey ?? '')) return { error: 'The keys on this card are incomplete or damaged.' };
  if (!card.workspace || !card.createdAt) return { error: 'This card is missing its workspace or creation time.' };
  if (card.operation === 'enrollment' && (!KEY.invitation.test(card.token ?? '') || !UUID.test(card.requestId ?? '') || nameProblem(card.name ?? ''))) {
    return { error: 'This join card is missing its original request, so it cannot be used to repeat the join.' };
  }
  return { card };
}

function el(tag, { onclick, ...props } = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  if (onclick) node.addEventListener('click', onclick);
  node.append(...children);
  return node;
}

let fieldCount = 0;
function field(labelText, input) {
  input.id = `access-field-${++fieldCount}`;
  return el('div', { className: 'source-field' }, [el('label', { htmlFor: input.id, textContent: labelText }), input]);
}

const secretInput = () => el('input', { type: 'password', autocomplete: 'off', spellcheck: false });

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

// onOwner(principal) starts the owner app; onSignedOut() must tear down every
// private view synchronously. Returns { start(), sessionEnded() }.
export function mountAccess(container, { onOwner, onSignedOut }) {
  // Bumped on every screen change, so a late response for an earlier screen or
  // session is dropped.
  let generation = 0;
  let principal = null;
  let unsavedKeys = false;
  let cardUrl = null;

  window.addEventListener('beforeunload', (event) => {
    if (!unsavedKeys) return;
    event.preventDefault();
    event.returnValue = '';
  });

  const status = el('p', { className: 'form-message', role: 'alert' });
  const show = (...nodes) => {
    generation += 1;
    if (cardUrl) URL.revokeObjectURL(cardUrl);
    cardUrl = null;
    container.replaceChildren(...nodes);
    return generation;
  };
  const setStatus = (text) => {
    status.textContent = text;
    status.className = 'form-message';
  };

  // Shows a card's keys with its download. With onSaved, the caller's action
  // stays disabled until the person says they saved the card.
  function cardPanel(card, onSaved = null) {
    const url = URL.createObjectURL(new Blob([accessCard(card)], { type: 'text/plain' }));
    cardUrl = url;
    const keyRow = (label, value) => el('div', { className: 'access-key' }, [el('span', { textContent: label }), el('code', { textContent: value })]);
    const nodes = [
      keyRow('Access key', card.accessKey),
      keyRow('Recovery key', card.recoveryKey),
      el('a', { href: url, download: 'rehere-access-card.txt', textContent: 'Download access card', className: 'access-download' }),
    ];
    if (onSaved) {
      unsavedKeys = true;
      const saved = el('input', { type: 'checkbox' });
      saved.addEventListener('change', () => {
        unsavedKeys = !saved.checked;
        onSaved(saved.checked);
      });
      nodes.unshift(el('p', { textContent: 'Your new keys are ready. Nothing has been sent yet.' }));
      nodes.push(
        el('p', {
          className: 'hint',
          textContent:
            'Rehere does not store these keys and cannot show them again. Downloading only asks your browser to save a file; it does not confirm the file was kept. Check the saved file, or copy both keys somewhere private, before continuing.',
        }),
        el('label', { className: 'memory-consent' }, [saved, ' I saved this card (or copied both keys) somewhere private']),
      );
    }
    return el('div', { className: 'access-keys' }, nodes);
  }

  function setup() {
    show(
      el('section', { className: 'panel access' }, [
        el('h1', { textContent: 'This workspace is not set up yet' }),
        el('p', { textContent: 'The owner sets it up once on this computer with the command line tool, which creates the owner’s access card. There is no sign-up in the browser.' }),
        el('pre', { className: 'access-command', textContent: 'node app/access-cli.mjs init --credentials-file <path outside the app> --name <your name>' }),
        el('p', { className: 'hint', textContent: 'Reload this page after setup.' }),
      ]),
    );
  }

  function signIn(note = '', prefill = '') {
    unsavedKeys = false;
    const accessKey = secretInput();
    accessKey.value = prefill;
    const submit = el('button', { type: 'submit', textContent: 'Sign in' });
    const form = el('form', { className: 'panel access', noValidate: true }, [
      el('h1', { textContent: 'Sign in' }),
      field('Access key', accessKey),
      el('div', { className: 'actions' }, [submit]),
    ]);
    setStatus(note);
    const mine = show(
      form,
      status,
      el('div', { className: 'actions access-links' }, [
        el('button', { type: 'button', className: 'secondary', textContent: 'Use a saved access card', onclick: () => importCard() }),
        el('button', { type: 'button', className: 'secondary', textContent: 'Lost your access key?', onclick: () => recover() }),
        el('button', { type: 'button', className: 'secondary', textContent: 'Join with an invitation', onclick: () => join() }),
      ]),
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!accessKey.value.trim()) {
        setStatus('Enter your access key.');
        return;
      }
      submit.disabled = true;
      const result = await postJson('/api/session/login', { accessKey: accessKey.value.trim() });
      if (mine !== generation) return;
      submit.disabled = false;
      if (result.ok && result.body?.principal) {
        accessKey.value = '';
        signedIn(result.body.principal);
        return;
      }
      setStatus(reasonOf(result) || (result.status === 0 ? 'Rehere could not be reached. Try again.' : 'That access key was not accepted.'));
    });
  }

  // Reads a saved card on this device only. Choosing a file never sends
  // anything; every next step is a separate button.
  function importCard() {
    // Cards made here are text files; the command-line owner card is JSON.
    const file = el('input', { type: 'file', accept: '.txt,.json,text/plain,application/json' });
    const review = el('div');
    setStatus('');
    const mine = show(
      el('section', { className: 'panel access' }, [
        el('h1', { textContent: 'Use a saved access card' }),
        el('p', { className: 'hint', textContent: 'The card is read on this device. Nothing is sent until you choose what to do with it.' }),
        field('Access card file', file),
        review,
      ]),
      status,
      el('div', { className: 'actions access-links' }, [el('button', { type: 'button', className: 'secondary', textContent: 'Back to sign in', onclick: () => signIn() })]),
    );
    file.addEventListener('change', async () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      const parsed = parseAccessCard(await chosen.text().catch(() => ''));
      if (mine !== generation) return;
      review.replaceChildren();
      if (parsed.error) {
        setStatus(parsed.error);
        return;
      }
      setStatus('');
      const { card } = parsed;
      const here = location.origin;
      const created = new Date(card.createdAt);
      const title = { enrollment: `Join card for ${card.name}`, recovery: 'Key replacement card', owner: `Owner card for ${card.name}` }[card.operation];
      const nodes = [el('p', { textContent: title })];
      if (card.createdAt) {
        nodes.push(el('p', { textContent: `Created ${Number.isNaN(created.getTime()) ? card.createdAt : created.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}` }));
      }
      // A card for another address is never used here; its keys stay unsent.
      if (card.workspace && card.workspace !== here) {
        nodes.push(
          el('p', {
            className: 'form-message is-error',
            textContent: `This card was made for the Rehere workspace at ${card.workspace}, not this one (${here}). Open Rehere at that address to use it. Nothing from the card was sent.`,
          }),
        );
        review.replaceChildren(...nodes);
        return;
      }
      const actions = el('div', { className: 'actions' }, [
        el('button', { type: 'button', textContent: 'Sign in with this card', onclick: () => signIn('Press Sign in to use the access key from your card.', card.accessKey) }),
      ]);
      if (card.operation === 'enrollment') {
        actions.append(el('button', { type: 'button', className: 'secondary', textContent: 'Repeat the original join', onclick: () => join(card) }));
        nodes.push(el('p', { className: 'hint', textContent: 'If you are not sure the join went through, sign in first. If the access key is not accepted, repeating the original join sends the same request with the same keys.' }));
      } else if (card.operation === 'recovery') {
        nodes.push(el('p', { className: 'hint', textContent: 'Signing in with this card’s access key is how to find out whether the replacement went through. If it is not accepted, keep this card and your previous card.' }));
      }
      if (!card.workspace) {
        const confirm = el('input', { type: 'checkbox' });
        const buttons = [...actions.children];
        for (const button of buttons) button.disabled = true;
        confirm.addEventListener('change', () => {
          for (const button of buttons) button.disabled = !confirm.checked;
        });
        nodes.push(
          el('p', { className: 'form-message is-error', textContent: `This card does not record which address it belongs to.` }),
          el('label', { className: 'memory-consent' }, [confirm, ` This card belongs to the workspace at ${here}`]),
        );
      }
      review.replaceChildren(...nodes, actions);
    });
  }

  // Shared shape of the two credential-creating screens: fields, then the
  // prepared card and its saved acknowledgement, then one request body that is
  // never regenerated behind the person's back.
  function credentialFlow(options) {
    const { title, intro, fields, check, prepare, endpoint, actionLabel, onResult, preset = null, oneShot = false, beforeSend = () => {} } = options;
    const prepareButton = el('button', { type: 'submit', textContent: 'Prepare my new keys', hidden: Boolean(preset) });
    const action = el('button', { type: 'button', textContent: actionLabel, disabled: !preset, hidden: !preset });
    const startOver = el('button', { type: 'button', className: 'secondary', textContent: 'Start over', hidden: true });
    const extra = el('div', { className: 'actions' });
    const pending = el('div');
    let body = preset?.body ?? null;
    let sent = Boolean(preset);
    let saved = Boolean(preset);
    let inFlight = false;
    const form = el('form', { className: 'panel access', noValidate: true }, [
      el('h1', { textContent: title }),
      el('p', { className: 'hint', textContent: intro }),
      ...fields.map(([label, input]) => field(label, input)),
      el('div', { className: 'actions' }, [prepareButton]),
    ]);
    setStatus('');
    const back = el('button', { type: 'button', className: 'secondary', textContent: 'Back', onclick: () => (principal ? signedIn(principal) : signIn()) });
    const mine = show(form, pending, el('div', { className: 'actions' }, [startOver, action]), status, extra, el('div', { className: 'actions access-links' }, [back]));
    if (preset) {
      for (const [, input] of fields) input.readOnly = true;
      pending.replaceChildren(el('p', { className: 'hint', textContent: 'Loaded from your saved card. Joining again sends exactly the original request.' }), cardPanel(preset.card));
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (body) return;
      const problem = check();
      if (problem) {
        setStatus(problem);
        return;
      }
      setStatus('');
      const prepared = prepare(freshKeys(), { workspace: location.origin, createdAt: new Date().toISOString() });
      body = prepared.body;
      for (const [, input] of fields) input.readOnly = true;
      prepareButton.hidden = true;
      action.hidden = false;
      startOver.hidden = false;
      pending.replaceChildren(
        cardPanel(prepared.card, (value) => {
          saved = value;
          action.disabled = !saved || inFlight;
        }),
      );
    });
    // Discarding prepared keys is only safe before any request used them.
    startOver.addEventListener('click', () => {
      if (sent) return;
      unsavedKeys = false;
      for (const [, input] of fields) input.readOnly = false;
      credentialFlow({ ...options, preset: null });
    });
    action.addEventListener('click', async () => {
      if (!body || !saved || inFlight || (oneShot && sent)) return;
      sent = true;
      inFlight = true;
      startOver.hidden = true;
      action.disabled = true;
      setStatus('');
      extra.replaceChildren();
      beforeSend();
      const result = await postJson(endpoint, body);
      if (mine !== generation) return;
      inFlight = false;
      action.disabled = oneShot;
      if (result.ok && result.body?.principal) unsavedKeys = false;
      onResult(result, { action, extra, body });
    });
  }

  // Reconciles an unconfirmed key change by an ordinary sign-in the person
  // starts; the key is placed in the field but nothing is sent until they ask.
  const signInWithNewKey = (accessKey, note) =>
    el('button', { type: 'button', className: 'secondary', textContent: 'Sign in with the new access key', onclick: () => signIn(note, accessKey) });

  // Recovery replaces both keys and ends every session; it never signs in. It
  // has no request receipt: a lost response is settled only by signing in with
  // the new access key, never by resending or by another key set.
  function recover() {
    const recoveryKey = secretInput();
    credentialFlow({
      title: 'Replace lost keys',
      intro: 'Your recovery key replaces both your access key and your recovery key, and signs out every device, including this one. You then sign in with the new access key. Keep your previous card until that sign-in works.',
      fields: [['Recovery key', recoveryKey]],
      check: () => (recoveryKey.value.trim() ? null : 'Enter your recovery key.'),
      prepare: (keys, meta) => ({
        card: { ...meta, operation: 'recovery', name: principal?.displayName, ...keys },
        body: { recoveryKey: recoveryKey.value.trim(), newAccessKey: keys.accessKey, newRecoveryKey: keys.recoveryKey },
      }),
      endpoint: '/api/session/recover',
      actionLabel: 'Replace my keys',
      oneShot: true,
      // Any recovery request may end this browser's session, whatever its
      // outcome, so the local identity is dropped before it is sent.
      beforeSend: () => {
        if (!principal) return;
        const wasOwner = principal.role === 'owner';
        principal = null;
        if (wasOwner) onSignedOut();
      },
      onResult: (result, { action, extra, body }) => {
        action.hidden = true;
        if (result.ok && result.body?.principal) {
          signIn('Your keys were replaced and every session was signed out. Sign in with the new access key from your card. Keep your previous card until this sign-in works.');
          return;
        }
        if (unclear(result)) {
          setStatus(
            `${reasonOf(result) ? `${reasonOf(result)} ` : ''}Rehere could not confirm whether your keys were replaced. Signing in with the new access key from your card is how to find out. Keep both your previous card and the new one until a sign-in works.`,
          );
          extra.replaceChildren(
            signInWithNewKey(body.newAccessKey, 'If the replacement went through, the new access key from your card works. If it is not accepted, that alone does not show what happened; keep both cards.'),
          );
          return;
        }
        setStatus(`${reasonOf(result) || 'That recovery key was not accepted.'} This request did not replace your keys, so the card prepared for it will not work. Keep your previous card.`);
      },
    });
  }

  // Enrollment uses a manually entered invitation code and does not sign in.
  // A saved join card can repeat the original request exactly.
  function join(card = null) {
    const token = secretInput();
    const name = el('input', { type: 'text', maxLength: 200, autocomplete: 'nickname' });
    if (card) {
      token.value = card.token;
      name.value = card.name;
    }
    credentialFlow({
      title: 'Join with an invitation',
      intro: 'An invitation gives you access to one place in this workspace. Joining creates your own access key and recovery key.',
      fields: [
        ['Invitation code', token],
        ['Your name, shown with what you add', name],
      ],
      check: () => (!token.value.trim() ? 'Enter the invitation code you were given.' : nameProblem(name.value)),
      prepare: (keys, meta) => {
        const body = { token: token.value.trim(), requestId: crypto.randomUUID(), displayName: name.value.trim(), ...keys };
        return { body, card: { ...meta, operation: 'enrollment', name: body.displayName, ...keys, token: body.token, requestId: body.requestId } };
      },
      preset: card && {
        card,
        body: { token: card.token, requestId: card.requestId, displayName: card.name, accessKey: card.accessKey, recoveryKey: card.recoveryKey },
      },
      endpoint: '/api/invitations/redeem',
      actionLabel: 'Join',
      onResult: (result, { action }) => {
        if (result.ok && result.body?.principal) {
          signIn('You have joined. Sign in with the access key from your card.');
          return;
        }
        if (unclear(result)) {
          action.textContent = 'Try again';
          setStatus(`${reasonOf(result) ? `${reasonOf(result)} ` : ''}Rehere could not confirm whether you joined. Trying again repeats the same request with the same keys; keep your card.`);
          return;
        }
        setStatus(reasonOf(result) || 'That invitation could not be used.');
      },
    });
  }

  function accountBar() {
    const bar = el('div', { className: 'access-bar' }, [
      el('span', { textContent: `Signed in as ${principal.displayName}${principal.role === 'owner' ? ' (owner)' : ''}` }),
      el('button', { type: 'button', className: 'secondary', textContent: 'Sign out', onclick: () => signOut() }),
    ]);
    // An owner replaces keys from the sign-in screen, after the app has closed.
    if (principal.role !== 'owner') {
      bar.append(el('button', { type: 'button', className: 'secondary', textContent: 'Replace my keys', onclick: () => recover() }));
    }
    return bar;
  }

  function signedIn(next) {
    principal = next;
    if (principal.role === 'owner') {
      show(accountBar());
      onOwner(principal);
      return;
    }
    const places = principal.draftIds.length;
    show(
      accountBar(),
      el('section', { className: 'panel access' }, [
        el('h1', { textContent: 'You are a contributor' }),
        el('p', { textContent: `Your invitation gives you access to ${places} place${places === 1 ? '' : 's'} in this workspace.` }),
        el('p', { className: 'hint', textContent: 'Adding your own memories to a place is not available yet. Your access and your recovery key stay valid.' }),
      ]),
    );
  }

  // Private views are torn down before the request leaves, so nothing private
  // stays on screen even if the sign-out is not confirmed.
  async function signOut() {
    const wasOwner = principal?.role === 'owner';
    principal = null;
    if (wasOwner) onSignedOut();
    const mine = show(el('p', { className: 'hint', textContent: 'Signing out…' }));
    const result = await postJson('/api/session/logout', {});
    if (mine !== generation) return;
    if (result.ok) {
      signIn('You are signed out.');
      return;
    }
    show(
      el('p', { className: 'form-message is-error', textContent: 'Rehere could not confirm the sign-out. This session may stay active until it expires.' }),
      el('div', { className: 'actions' }, [el('button', { type: 'button', textContent: 'Try signing out again', onclick: () => signOut() })]),
    );
  }

  async function start() {
    const mine = show(el('p', { className: 'hint', textContent: 'Checking your session…' }));
    const result = await request('/api/session');
    if (mine !== generation) return;
    if (!result.ok || typeof result.body?.initialized !== 'boolean') {
      show(
        el('p', { className: 'form-message is-error', textContent: 'Rehere could not check your session.' }),
        el('div', { className: 'actions' }, [el('button', { type: 'button', textContent: 'Try again', onclick: () => start() })]),
      );
      return;
    }
    if (!result.body.initialized) setup();
    else if (result.body.principal) signedIn(result.body.principal);
    else signIn();
  }

  return {
    start,
    // For a 401 from a private request: the session expired or was replaced.
    sessionEnded() {
      if (!principal) return;
      const wasOwner = principal.role === 'owner';
      principal = null;
      if (wasOwner) onSignedOut();
      signIn('Your session ended. Sign in again.');
    },
  };
}
