// Operation card: all fields, photos, change history, edit and reversal (SPEC §5.7).
import { db } from '../db.js';
import { navigate } from '../nav.js';
import {
  DOC_TYPES, INCOME_SOURCES, LedgerError, accountName, isMonthClosed, reverseTransaction, reverseWithOpposite, shortName,
} from '../ledger.js';
import { formatDate, formatMoney, formatRate } from '../money.js';
import { el } from '../ui/dom.js';
import { askReason } from '../ui/edit-sheet.js';
import { formHead } from '../ui/form.js';
import { photoThumbs } from '../ui/photo-viewer.js';
import { toast } from '../ui/toast.js';

const TYPE_TITLES = { expense: 'Расход', income: 'Поступление', transfer: 'Перевод' };
const ACTION_LABELS = {
  create: 'Создано', update: 'Изменено', reverse: 'Сторно', pay: 'Оплачено', cancel: 'Отменено', reverse_link: 'Исправлено обратной операцией',
};
const WATCHED = {
  amount: 'Сумма', date: 'Дата', account_id: 'Счёт', object_id: 'Объект', category_id: 'Статья', counterparty_id: 'Контрагент',
  doc_type: 'Документ', doc_number: 'Номер документа', description: 'Комментарий', status: 'Статус',
};

function fact(label, value) {
  return value ? [el('dt', {}, label), el('dd', {}, value)] : [];
}

function dateTime(iso) {
  const moment = new Date(iso);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(moment.getDate())}.${pad(moment.getMonth() + 1)}.${moment.getFullYear()} ${pad(moment.getHours())}:${pad(moment.getMinutes())}`;
}

function shown(key, value, refs, currency) {
  if (value == null || value === '') return 'пусто';
  if (key === 'amount') return formatMoney(value, currency);
  if (key === 'date') return formatDate(value);
  if (key === 'account_id') return accountName(refs.accounts.get(value));
  if (key === 'object_id') return refs.objects.get(value)?.name ?? '';
  if (key === 'category_id') return shortName(refs.categories.get(value)?.name ?? '');
  if (key === 'counterparty_id') return refs.counterparties.get(value)?.name ?? '';
  if (key === 'doc_type') return DOC_TYPES.find((doc) => doc.code === value)?.label ?? '';
  return String(value);
}

function historyRow(entry, refs, currency) {
  const changes = entry.before && entry.after
    ? Object.keys(WATCHED).filter((key) => entry.before[key] !== entry.after[key])
    : [];
  return el('li', { class: 'history-row' },
    el('p', { class: 'row-title' }, ACTION_LABELS[entry.action] ?? entry.action),
    el('p', { class: 'row-sub' }, dateTime(entry.at)),
    changes.map((key) => el('p', { class: 'row-sub' },
      `${WATCHED[key]}: ${shown(key, entry.before[key], refs, currency)} → ${shown(key, entry.after[key], refs, currency)}`)));
}

export function renderTransaction({ view, params, isCurrent }) {
  const id = params?.get('id');
  const urls = [];

  async function show() {
    const [tx, photos, history, accounts, objects, categories, counterparties] = await Promise.all([
      db.transactions.get(id),
      db.attachments.where('transaction_id').equals(id).toArray(),
      db.audit_log.where({ table_name: 'transactions', row_id: id }).sortBy('at'),
      db.accounts.toArray(), db.objects.toArray(), db.categories.toArray(), db.counterparties.toArray(),
    ]);
    if (!isCurrent()) return;
    if (!tx) {
      navigate('/journal', { replace: true });
      return;
    }
    const byId = (rows) => new Map(rows.map((row) => [row.id, row]));
    const refs = { accounts: byId(accounts), objects: byId(objects), categories: byId(categories), counterparties: byId(counterparties) };
    const account = refs.accounts.get(tx.account_id);
    const target = refs.accounts.get(tx.to_account_id);
    const doc = DOC_TYPES.find((row) => row.code === tx.doc_type);
    const reversed = tx.status === 'reversed';
    const closed = await isMonthClosed(tx.date);
    if (!isCurrent()) return;
    const fromBarter = Boolean(tx.barter_asset_id);
    const editRoute = { expense: 'expense/new', income: 'income', transfer: 'transfer' }[tx.type];

    async function reverse() {
      const reason = await askReason({
        title: 'Сторно операции',
        message: `Операция №${tx.number} исчезнет из сумм и останется в журнале зачёркнутой.`,
        confirmLabel: 'Сторнировать',
      });
      if (!reason) return;
      try {
        await reverseTransaction(id, reason);
        toast('Операция сторнирована');
        show();
      } catch (error) {
        if (!(error instanceof LedgerError)) throw error;
        toast(error.message);
      }
    }

    async function reverseOpposite() {
      const reason = await askReason({
        title: 'Обратная операция',
        message: `Месяц закрыт, операция №${tx.number} не изменится. Обратная операция запишется сегодняшней датой в открытый месяц, затем внесите правильную операцию.`,
        confirmLabel: 'Создать',
      });
      if (!reason) return;
      try {
        const row = await reverseWithOpposite(id, reason);
        toast(`Создана операция №${row.number}`);
        show();
      } catch (error) {
        if (!(error instanceof LedgerError)) throw error;
        toast(error.message);
      }
    }

    for (const url of urls.splice(0)) URL.revokeObjectURL(url);
    const images = photoThumbs(photos.filter((photo) => photo.blob).map((photo) => {
      const url = URL.createObjectURL(photo.blob);
      urls.push(url);
      return url;
    }), 'Фото документа');

    view.replaceChildren(...[
      formHead(`${TYPE_TITLES[tx.type]} №${tx.number}`, { href: '#/journal' }),
      el('section', { class: 'total' },
        el('p', { class: `total-value${reversed ? ' struck' : ''}`, 'data-testid': 'tx-amount' }, formatMoney(tx.amount, account.currency)),
        reversed && el('p', { class: 'total-note danger-text' }, `Сторно: ${tx.reversal_reason}`)),
      el('dl', { class: 'facts' },
        fact('Дата', formatDate(tx.date)),
        fact('Покупка', tx.cost_date && tx.cost_date !== tx.date ? formatDate(tx.cost_date) : null),
        fact(tx.type === 'transfer' ? 'Откуда' : 'Счёт', accountName(account)),
        fact('Куда', accountName(target)),
        fact('Зачислено', target ? formatMoney(tx.to_amount, target.currency) : null),
        fact('Курс', tx.rate !== 10000 ? formatRate(tx.rate) : null),
        fact('В сомах', account.currency === 'USD' ? formatMoney(tx.amount_kgs, 'KGS') : null),
        fact('Откуда деньги', tx.type === 'income' ? INCOME_SOURCES.find((row) => row.code === tx.source_kind)?.label : null),
        fact('Отдать до', tx.type === 'income' && tx.due_date ? formatDate(tx.due_date) : null),
        fact('Статья', shortName(refs.categories.get(tx.category_id)?.name ?? '')),
        fact('Объект', refs.objects.get(tx.object_id)?.name),
        fact('Контрагент', refs.counterparties.get(tx.counterparty_id)?.name),
        fact('Документ', doc?.label),
        fact('Номер документа', tx.doc_number),
        fact('Комментарий', tx.description)),
      images.length > 0 && el('div', { class: 'photo-grid' }, images),
      closed && el('p', { class: 'stub-note', 'data-testid': 'month-closed' }, 'Месяц закрыт, операция не меняется.'),
      closed && !reversed && !fromBarter && !tx.reversed_by_id && !tx.reversal_of_id && el('button', {
        class: 'button', type: 'button', 'data-action': 'opposite', onClick: reverseOpposite,
      }, 'Исправить обратной операцией'),
      tx.reversed_by_id && el('a', { class: 'button', href: `#/tx?id=${tx.reversed_by_id}` }, 'Открыть обратную операцию'),
      tx.reversal_of_id && el('a', { class: 'button', href: `#/tx?id=${tx.reversal_of_id}` }, 'Открыть исходную операцию'),
      !closed && !reversed && !fromBarter && !tx.reversal_of_id && el('div', { class: 'tx-actions' },
        el('a', { class: 'button', href: `#/${editRoute}?edit=${id}`, 'data-action': 'edit' }, 'Изменить'),
        el('button', { class: 'button danger-button', type: 'button', 'data-action': 'reverse', onClick: reverse }, 'Сторно')),
      fromBarter && el('p', { class: 'stub-note' }, 'Операция бартера. Она меняется из карточки машины.'),
      el('section', { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', {}, 'История изменений')),
        el('ul', { class: 'rows' }, history.map((entry) => historyRow(entry, refs, account.currency)))),
    ].filter(Boolean));
  }

  show();
  return () => {
    for (const url of urls) URL.revokeObjectURL(url);
  };
}
