import { pushOverlay } from '../nav.js';
import { el } from './dom.js';

const CLOSE_PX = 110;
const FLIP_SHARE = 0.25;

// Full-screen photos inside the app: a new tab with a blob address does not work
// in an installed app on iPhone. Swipe sideways between photos, down to close.
export function openPhotos(urls, start = 0) {
  let index = start;
  const image = el('img', { class: 'viewer-image', alt: 'Фото документа', draggable: false });
  const counter = el('p', { class: 'viewer-counter' });
  const dialog = el('dialog', { class: 'viewer', 'aria-label': 'Фото' },
    image,
    el('div', { class: 'viewer-bar' },
      counter,
      el('button', { class: 'icon-button viewer-close', type: 'button', 'aria-label': 'Закрыть', onClick: () => dialog.close() }, '✕')));

  function showPhoto(next, from = 0) {
    index = (next + urls.length) % urls.length;
    image.src = urls[index];
    counter.textContent = urls.length > 1 ? `${index + 1} из ${urls.length}` : '';
    if (from) image.animate([{ transform: `translateX(${from}px)`, opacity: 0.4 }, { transform: 'none', opacity: 1 }], { duration: 200, easing: 'ease-out' });
  }

  let drag = null;
  dialog.addEventListener('touchstart', (event) => {
    drag = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY, axis: null } : null;
  }, { passive: true });
  dialog.addEventListener('touchmove', (event) => {
    if (!drag || event.touches.length !== 1) {
      drag = null;
      image.style.transform = '';
      return;
    }
    const dx = event.touches[0].clientX - drag.x;
    const dy = event.touches[0].clientY - drag.y;
    if (!drag.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    event.preventDefault();
    drag.dx = dx;
    drag.dy = dy;
    if (drag.axis === 'x' && urls.length > 1) image.style.transform = `translateX(${dx}px)`;
    if (drag.axis === 'y' && dy > 0) {
      image.style.transform = `translateY(${dy}px) scale(${1 - Math.min(dy / 2000, 0.15)})`;
      dialog.style.setProperty('--viewer-dim', String(Math.max(0.3, 1 - dy / 500)));
    }
  }, { passive: false });
  dialog.addEventListener('touchend', () => {
    if (!drag?.axis) return;
    const { axis, dx = 0, dy = 0 } = drag;
    drag = null;
    image.style.transform = '';
    dialog.style.removeProperty('--viewer-dim');
    if (axis === 'y' && dy > CLOSE_PX) dialog.close();
    else if (axis === 'x' && urls.length > 1 && Math.abs(dx) > innerWidth * FLIP_SHARE) showPhoto(index + (dx < 0 ? 1 : -1), dx < 0 ? innerWidth / 3 : -innerWidth / 3);
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') showPhoto(index + 1);
    if (event.key === 'ArrowLeft') showPhoto(index - 1);
  });

  let release = () => {};
  dialog.addEventListener('close', () => {
    dialog.remove();
    release();
  });
  document.body.append(dialog);
  showPhoto(start);
  dialog.showModal();
  release = pushOverlay(() => dialog.close());
}

// Thumbnails that open the viewer; returns the grid's children.
export function photoThumbs(urls, alt) {
  return urls.map((url, index) => el('button', {
    class: 'photo-link', type: 'button', 'aria-label': `${alt}, открыть`, onClick: () => openPhotos(urls, index),
  }, el('img', { src: url, alt })));
}
