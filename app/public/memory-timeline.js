function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

export function timelineMemory(entry, proposals) {
  if (entry.blocked === true) return { unavailable: true };
  if (entry.kind !== 'proposal' || !entry.proposalId) return null;
  const proposal = proposals.find((item) => item.id === entry.proposalId);
  if (!proposal || proposal.redacted === true || typeof proposal.statement?.text !== 'string'
      || proposal.status !== 'applied' || proposal.appliedVersion !== entry.version
      || proposal.baseVersion + 1 !== entry.version) return { unavailable: true };
  return { text: proposal.statement.text, reason: proposal.result?.reason ?? 'not available', mode: proposal.mode };
}

export function renderMemoryTimeline(container, { history, proposals, currentVersion, available, label, describe, actions }) {
  const summary = el('p', { className: 'hint', textContent: available
    ? `Saved version ${currentVersion} · ${history.length} saved ${history.length === 1 ? 'version' : 'versions'}. Earlier versions remain available.`
    : 'Saved versions could not be confirmed. Refresh before using this timeline.' });
  const list = el('ol', { className: 'memory-history', reversed: true });
  list.setAttribute('aria-label', 'Saved memory versions');
  if (available) list.append(...[...history].sort((a, b) => b.version - a.version).map((entry) => {
    const current = entry.version === currentVersion;
    const item = el('li', {}, [
      el('span', { className: 'space-choice-label', textContent: `Version ${entry.version}${current ? ' (current)' : ''}: ${label(entry)}` }),
      el('p', { className: 'hint', textContent: describe(entry) }),
    ]);
    if (current) item.setAttribute('aria-current', 'step');
    const memory = timelineMemory(entry, proposals);
    if (memory?.unavailable) {
      item.append(el('p', { className: 'hint', textContent: 'The memory for this change is no longer shown.' }));
    } else if (memory) {
      item.append(
        el('p', { className: 'hint', textContent: `Your memory: “${memory.text}”` }),
        el('p', { className: 'hint', textContent: `${memory.mode === 'simulated' ? 'SIMULATED suggestion, not from Meta' : 'AI suggestion'}: ${memory.reason}` }),
        el('p', { className: 'hint', textContent: 'Owner approved and saved. This does not establish historical truth.' }),
      );
    }
    item.append(...actions(entry, current));
    return item;
  }));
  container.replaceChildren(el('h4', { textContent: 'Memory timeline' }), summary, list);
}
