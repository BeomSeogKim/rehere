// Chooses the one saved-view button that a ?version=<label> link asks for. Only buttons the visitor page marks as saved
// views (they carry a string viewId) are candidates. An unknown label, the label of any other control such as Play, or a
// label shared by two views selects nothing, so a link can never press an unrelated control.
export function pickViewButton(buttons, label) {
  const matches = [...buttons].filter((button) => typeof button.viewId === 'string' && button.viewId !== '' && button.textContent.trim() === label);
  return matches.length === 1 ? matches[0] : null;
}
