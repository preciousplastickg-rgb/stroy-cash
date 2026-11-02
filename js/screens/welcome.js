// First start: real work, a look at the demo, or a backup from another phone.
import { generateInstances } from '../recurring.js';
import { todayIso } from '../money.js';
import { seedDemo, startClean } from '../seed.js';
import { el } from '../ui/dom.js';

export function renderWelcome({ view }) {
  const go = (path) => {
    location.hash = path;
  };
  view.replaceChildren(el('div', { class: 'welcome' },
    el('h1', {}, 'Учёт денег стройки'),
    el('p', {}, 'Все данные хранятся только на этом телефоне. Интернет нужен для установки и обновлений.'),
    el('button', {
      class: 'button button-primary',
      type: 'button',
      'data-action': 'start-clean',
      onClick: async () => {
        await startClean();
        go('#/');
      },
    }, 'Начать работу'),
    el('button', {
      class: 'button',
      type: 'button',
      'data-action': 'start-demo',
      onClick: async () => {
        await seedDemo();
        await generateInstances(todayIso());
        go('#/');
      },
    }, 'Посмотреть на демо-данных'),
    el('a', { class: 'button', href: '#/restore', 'data-action': 'start-restore' }, 'Восстановить из бэкапа')));
}
