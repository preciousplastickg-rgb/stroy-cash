// Restore from data.json and, if there is one, a ZIP with photos. The summary comes
// first, and the current data is saved to a file before it is replaced (SPEC §10).
import {
  backupSummary, buildBackup, parseBackup, restoreBackup, restorePhotos,
} from '../backup.js';
import { db } from '../db.js';
import { formatDate, formatMoney, todayIso } from '../money.js';
import { confirmSheet } from '../ui/confirm.js';
import { el } from '../ui/dom.js';
import { formHead } from '../ui/form.js';
import { deliverFile } from '../ui/share.js';
import { toast } from '../ui/toast.js';

export function renderRestore({ view }) {
  let data = null;
  let photos = [];
  const summaryBox = el('div', { class: 'form-body' });
  const error = el('p', { class: 'field-error', hidden: true });

  async function saveCurrent() {
    const operations = await db.transactions.count();
    if (operations === 0) return;
    const json = JSON.stringify(await buildBackup(), null, 1);
    await deliverFile(new Blob([json], { type: 'application/json' }), `kassa-before-restore-${todayIso()}.json`);
  }

  async function apply() {
    const replacing = await db.transactions.count();
    if (replacing > 0) {
      const accepted = await confirmSheet({
        title: 'Заменить все данные?',
        message: `Сейчас в приложении ${replacing} записей. Они будут заменены, перед этим текущие данные сохранятся в файл.`,
        confirmLabel: 'Заменить',
        cancelLabel: 'Отмена',
        danger: true,
      });
      if (!accepted) return;
    }
    await saveCurrent();
    await restoreBackup(data);
    let restored = 0;
    for (const file of photos) restored += await restorePhotos(file);
    toast(`Данные восстановлены${restored ? `, фото: ${restored}` : ''}`);
    location.hash = '#/';
  }

  function showSummary() {
    const { operations, last_date: lastDate, balances } = backupSummary(data);
    summaryBox.replaceChildren(
      el('section', { class: 'card', 'data-testid': 'restore-summary' },
        el('div', { class: 'card-head' }, el('h2', {}, 'Что в файле')),
        el('ul', { class: 'rows' },
          el('li', { class: 'row row-compact' }, el('p', { class: 'row-title' }, 'Операций'), el('p', { class: 'row-amount' }, String(operations))),
          lastDate && el('li', { class: 'row row-compact' }, el('p', { class: 'row-title' }, 'Последняя'), el('p', { class: 'row-amount' }, formatDate(lastDate))),
          balances.map(({ account, balance }) => el('li', { class: 'row row-compact' },
            el('p', { class: 'row-title' }, account.name),
            el('p', { class: 'row-amount' }, formatMoney(balance, account.currency)))))),
      el('label', { class: 'photo-button secondary' },
        el('input', {
          class: 'file-input',
          type: 'file',
          accept: '.zip,application/zip',
          multiple: true,
          'data-restore': 'zip',
          onChange: (event) => {
            photos = [...event.target.files];
            photoNote.textContent = `Архивов с фото: ${photos.length}`;
          },
        }), 'Добавить ZIP с фото'),
      photoNote,
      el('button', { class: 'button button-primary', type: 'button', 'data-action': 'restore', onClick: apply }, 'Восстановить'),
    );
  }

  const photoNote = el('p', { class: 'card-note' }, 'Фото необязательны, их можно добавить только сейчас.');

  async function pickFile(event) {
    const [file] = event.target.files;
    if (!file) return;
    error.hidden = true;
    try {
      data = parseBackup(await file.text());
      showSummary();
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
      summaryBox.replaceChildren();
    }
  }

  view.replaceChildren(
    formHead('Восстановление', { href: '#/more' }),
    el('p', { class: 'stub-note' }, 'Выберите файл kassa-backup с датой. Все данные на этом телефоне будут заменены данными из файла.'),
    el('label', { class: 'photo-button' },
      el('input', {
        class: 'file-input', type: 'file', accept: '.json,application/json', 'data-restore': 'json', onChange: pickFile,
      }), 'Выбрать файл бэкапа'),
    error,
    summaryBox,
  );
}
