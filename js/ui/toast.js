import { el } from './dom.js';

const VISIBLE_MS = 2600;
let current = null;

export function toast(text) {
  current?.remove();
  const node = el('div', { class: 'toast', role: 'status' }, text);
  document.body.append(node);
  current = node;
  setTimeout(() => node.remove(), VISIBLE_MS);
}
