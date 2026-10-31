// Just enough DOM for the partial-scene module: elements, events, text,
// focus and removal.
export class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
  }
  append(...nodes) {
    for (const node of nodes) if (typeof node !== 'string') node.parent = this;
    this.children.push(...nodes);
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
  contains(node) {
    return this === node || this.children.some((child) => typeof child !== 'string' && child.contains(node));
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  removeAttribute(name) {
    delete this.attributes[name];
    if (name in this) this[name] = '';
  }
  get classList() {
    const names = new Set((this.className ?? '').split(' ').filter(Boolean));
    const write = () => (this.className = [...names].join(' '));
    return {
      contains: (name) => names.has(name),
      toggle: (name, force = !names.has(name)) => {
        if (force) names.add(name);
        else names.delete(name);
        write();
        return force;
      },
    };
  }
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  dispatch(type, event = {}) {
    // Browsers do not deliver clicks or input to disabled controls.
    if (this.disabled && (type === 'click' || type === 'input')) return;
    for (const listener of this.listeners[type] ?? []) listener({ preventDefault() {}, ...event });
  }
  focus() {}
  setPointerCapture() {}
  getBoundingClientRect() {
    return this.rect ?? { left: 0, top: 0, width: 0, height: 0 };
  }
  get textContent() {
    return this._text ?? this.children.map((child) => (typeof child === 'string' ? child : child.textContent)).join('');
  }
  set textContent(value) {
    this._text = String(value);
  }
  findAll(predicate) {
    return this.children.flatMap((child) =>
      typeof child === 'string' ? [] : [...(predicate(child) ? [child] : []), ...child.findAll(predicate)],
    );
  }
}
