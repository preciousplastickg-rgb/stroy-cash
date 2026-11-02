import { el } from './dom.js';
import { openSheet } from './sheet.js';

// Resolves to true only on an explicit "yes".
export function confirmSheet({ title, amount, message, confirmLabel = 'Да, всё верно', cancelLabel = 'Исправить', danger = false }) {
  return new Promise((resolve) => {
    const sheet = openSheet({
      title,
      onClose: (value) => resolve(value === true),
      body: el('div', { class: 'confirm' },
        amount && el('p', { class: 'confirm-amount' }, amount),
        el('p', { class: 'confirm-text' }, message),
        el('div', { class: 'confirm-actions' },
          el('button', { class: 'button', type: 'button', onClick: () => sheet.close(false) }, cancelLabel),
          el('button', {
            class: `button ${danger ? 'button-danger' : 'button-primary'}`, type: 'button', onClick: () => sheet.close(true),
          }, confirmLabel))),
    });
  });
}
