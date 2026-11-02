import { pushOverlay } from '../nav.js';
import { el } from './dom.js';

const DISMISS_PX = 96;
const DISMISS_SPEED = 0.5; // px per ms
const SCROLLERS = '.picker-list, .edit-sheet';

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// Pull the sheet down to close it: from its head, or from a list scrolled to the top.
function dragToDismiss(dialog, panel, dismiss) {
  let drag = null;
  panel.addEventListener('touchstart', (event) => {
    drag = null;
    if (event.touches.length !== 1) return;
    const scroller = event.target.closest(SCROLLERS);
    if (scroller && scroller.scrollTop > 0) return;
    if (event.target.closest('input[type="range"]')) return;
    drag = { y: event.touches[0].clientY, x: event.touches[0].clientX, state: 'pending', samples: [] };
  }, { passive: true });

  panel.addEventListener('touchmove', (event) => {
    if (!drag || drag.state === 'off') return;
    const touch = event.touches[0];
    const dy = touch.clientY - drag.y;
    const dx = touch.clientX - drag.x;
    if (drag.state === 'pending') {
      if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return;
      if (dy <= 0 || Math.abs(dx) > dy) {
        drag.state = 'off';
        return;
      }
      drag.state = 'drag';
      drag.y = touch.clientY;
      panel.style.animation = 'none';
    }
    event.preventDefault();
    const offset = Math.max(0, touch.clientY - drag.y);
    drag.offset = offset;
    drag.samples.push({ y: touch.clientY, t: event.timeStamp });
    if (drag.samples.length > 5) drag.samples.shift();
    panel.style.transform = `translateY(${offset}px)`;
    dialog.style.setProperty('--backdrop', String(Math.max(0, 0.4 - offset / 1200)));
  }, { passive: false });

  const end = () => {
    if (drag?.state !== 'drag') {
      drag = null;
      return;
    }
    const { offset = 0, samples } = drag;
    drag = null;
    const first = samples[0];
    const last = samples.at(-1);
    const speed = first && last && last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0;
    if (offset > DISMISS_PX || speed > DISMISS_SPEED) {
      dismiss();
      return;
    }
    panel.style.transform = '';
    dialog.style.removeProperty('--backdrop');
    panel.animate([{ transform: `translateY(${offset}px)` }, { transform: 'none' }], { duration: 180, easing: 'ease-out' });
  };
  panel.addEventListener('touchend', end);
  panel.addEventListener('touchcancel', end);
}

// Bottom sheet on a native <dialog>: focus trap, Esc and inert background for free.
// Returns { close, node }; onClose fires once with the value passed to close().
// A choice closes the sheet at once; ✕, a tap outside, a pull down and the back
// button slide it away.
export function openSheet({ title, body, onClose, tall = false }) {
  const dialog = el('dialog', { class: `sheet${tall ? ' tall' : ''}`, 'aria-label': title });
  let result;
  let leaving = false;

  function close(value) {
    result = value;
    if (dialog.open) dialog.close();
  }

  function dismiss() {
    if (leaving || !dialog.open) return;
    if (reducedMotion.matches) {
      close();
      return;
    }
    leaving = true;
    const from = getComputedStyle(panel).transform;
    panel.style.animation = 'none';
    dialog.style.setProperty('--backdrop', '0');
    panel.animate([{ transform: from === 'none' ? 'translateY(0)' : from }, { transform: 'translateY(100%)' }], {
      duration: 200, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards',
    }).finished.then(() => close(), () => close());
  }

  const panel = el('div', { class: 'sheet-panel' },
    el('div', { class: 'sheet-grabber', 'aria-hidden': 'true' }),
    el('div', { class: 'sheet-head' },
      el('h2', {}, title),
      el('button', { class: 'icon-button', type: 'button', 'aria-label': 'Закрыть', onClick: dismiss }, '✕')),
    body);
  dialog.append(panel);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dismiss();
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    dismiss();
  });
  let release = () => {};
  dialog.addEventListener('close', () => {
    dialog.remove();
    release();
    onClose?.(result);
  });
  dragToDismiss(dialog, panel, dismiss);
  document.body.append(dialog);
  dialog.showModal();
  release = pushOverlay(dismiss);
  return { close, node: dialog };
}
