// PWA duties of step 7: persistent storage, the install prompt and the update bar.
import { el } from './ui/dom.js';

let installPrompt = null;

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
});

function isInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function isPhone() {
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

function isIos() {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export async function askPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  return (await navigator.storage.persisted()) || navigator.storage.persist();
}

// iOS deletes site data of a tab after 7 idle days, so a phone tab shows how to install
// (SPEC §3). The prototype lets the user continue in the browser for a look around.
export function showInstallGuide() {
  if (isInstalled() || !isPhone() || sessionStorage.getItem('install-skipped')) return;
  const close = () => {
    sessionStorage.setItem('install-skipped', '1');
    screen.remove();
  };
  const steps = isIos()
    ? ['Откройте этот адрес в Safari', 'Нажмите кнопку «Поделиться»', 'Выберите «На экран Домой»', 'Запускайте приложение с иконки']
    : ['Откройте меню браузера', 'Выберите «Установить приложение»', 'Запускайте приложение с иконки'];
  const screen = el('div', { class: 'pin-screen install-screen', role: 'dialog', 'aria-label': 'Установка' },
    el('h1', {}, 'Установите приложение'),
    el('p', {}, 'Без установки телефон может удалить данные. Удаление иконки тоже удаляет все данные, сначала сделайте бэкап.'),
    el('ol', {}, steps.map((step) => el('li', {}, step))),
    installPrompt && el('button', {
      class: 'button button-primary',
      type: 'button',
      onClick: async () => {
        installPrompt.prompt();
        await installPrompt.userChoice;
        close();
      },
    }, 'Установить'),
    el('button', { class: 'button', type: 'button', onClick: close }, 'Продолжить в браузере'));
  document.body.append(screen);
}

function showUpdateBar(worker) {
  if (document.querySelector('.update-bar')) return;
  document.body.append(el('div', { class: 'update-bar', role: 'status' },
    el('span', {}, 'Доступна новая версия'),
    el('button', {
      class: 'banner-action',
      type: 'button',
      'data-action': 'update',
      onClick: () => {
        // Waits for a tap: an update must not reload a half-filled form.
        navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
        worker.postMessage('skip-waiting');
      },
    }, 'Обновить')));
}

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.register('sw.js');
  if (registration.waiting && navigator.serviceWorker.controller) showUpdateBar(registration.waiting);
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdateBar(worker);
    });
  });
}
