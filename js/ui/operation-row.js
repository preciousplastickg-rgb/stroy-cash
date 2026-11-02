// One operation in a list: the same row on the home screen and in the journal.
import { shortName } from '../ledger.js';
import { formatDate, formatMoney } from '../money.js';
import { el } from './dom.js';

function describe(tx, refs) {
  const account = refs.accounts.get(tx.account_id);
  if (tx.type === 'transfer') {
    const target = refs.accounts.get(tx.to_account_id);
    return {
      title: account.currency !== target.currency ? 'Обмен валюты' : 'Перевод',
      place: `${account.name} → ${target.name}`,
      amount: formatMoney(tx.amount, account.currency),
      tone: '',
    };
  }
  const income = tx.type === 'income';
  return {
    title: shortName(refs.categories.get(tx.category_id)?.name ?? ''),
    place: refs.objects.get(tx.object_id)?.name ?? account.name,
    amount: formatMoney(income ? tx.amount : -tx.amount, account.currency, { signed: true }),
    tone: income ? 'income' : '',
  };
}

export function operationRow(tx, refs) {
  const { title, place, amount, tone } = describe(tx, refs);
  return el('li', {}, el('a', {
    class: `row row-button${tx.status === 'reversed' ? ' reversed' : ''}`, href: `#/tx?id=${tx.id}`, 'data-number': tx.number,
  },
  el('div', { class: 'row-main' },
    el('p', { class: 'row-title' }, title),
    el('p', { class: 'row-sub one-line' }, `№${tx.number}, ${formatDate(tx.date)}, ${place}`)),
  el('p', { class: `row-amount ${tone}` }, amount)));
}
