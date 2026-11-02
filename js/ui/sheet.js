import { el } from './dom.js';

// Bottom sheet on a native <dialog>: focus trap, Esc and inert background for free.
// Returns { close, node }; onClose fires once with the value passed to close().
export function openSheet({ title, body, onClose, tall = false }) {
  const dialog = el('dialog', { class: `sheet${tall ? ' tall' : ''}`, 'aria-label': title });
  let result;

  function close(value) {
    result = value;
    dialog.close();
  }

  dialog.append(
    el('div', { class: 'sheet-panel' },
      el('div', { class: 'sheet-head' },
        el('h2', {}, title),
        el('button', { class: 'icon-button', type: 'button', 'aria-label': 'Закрыть', onClick: () => close() }, '✕')),
      body),
  );
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    onClose?.(result);
  });
  document.body.append(dialog);
  dialog.showModal();
  return { close, node: dialog };
}
