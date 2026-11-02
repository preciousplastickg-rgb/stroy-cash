// One person the company buys through: what they hold, what we owe through them,
// and everything that was bought through them, for which object and when.
import { db } from '../db.js';
import { accountBalance, openDebts, personName, shortName } from '../ledger.js';
import { formatDate, formatMoney, todayIso } from '../money.js';
import { debtRow } from '../ui/debt-row.js';
import { el } from '../ui/dom.js';
import { formHead } from '../ui/form.js';

function historyRow(tx, person, refs) {
  if (tx.type === 'transfer') {
    const given = tx.to_account_id === person.id;
    const other = refs.accounts.get(given ? tx.account_id : tx.to_account_id);
    return el('li', { class: 'row' },
      el('div', { class: 'row-main' },
        el('p', { class: 'row-title' }, given ? 'Выдано' : 'Возврат'),
        el('p', { class: 'row-sub' }, `№${tx.number}, ${formatDate(tx.date)}, ${given ? 'из' : 'в'}: ${other.name}`)),
      el('p', { class: 'row-amount income' }, formatMoney(given ? tx.to_amount : -tx.amount, person.currency, { signed: true })));
  }
  const supplier = refs.counterparties.get(tx.counterparty_id)?.name;
  const object = refs.objects.get(tx.object_id)?.name;
  return el('li', { class: 'row', 'data-bought': shortName(refs.categories.get(tx.category_id).name) },
    el('div', { class: 'row-main' },
      el('p', { class: 'row-title' }, shortName(refs.categories.get(tx.category_id).name)),
      el('p', { class: 'row-sub' }, [`№${tx.number}`, formatDate(tx.date), object, supplier].filter(Boolean).join(', '))),
    el('p', { class: 'row-amount' }, formatMoney(-tx.amount, person.currency)));
}

async function loadPerson(id) {
  const [person, balance, own, incoming, debts, accounts, objects, categories, counterparties] = await Promise.all([
    db.accounts.get(id),
    accountBalance(id),
    db.transactions.where('account_id').equals(id).toArray(),
    db.transactions.where('to_account_id').equals(id).toArray(),
    openDebts(),
    db.accounts.toArray(),
    db.objects.toArray(),
    db.categories.toArray(),
    db.counterparties.toArray(),
  ]);
  const byId = (rows) => new Map(rows.map((row) => [row.id, row]));
  return {
    person,
    balance,
    debts: debts.filter((tx) => tx.account_id === id),
    history: [...own, ...incoming].filter((tx) => tx.status === 'posted').sort((a, b) => b.number - a.number),
    refs: { accounts: byId(accounts), objects: byId(objects), categories: byId(categories), counterparties: byId(counterparties) },
  };
}

function balanceLine(balance, currency) {
  if (balance < 0) return { label: 'Потрачено своих, мы должны', value: formatMoney(-balance, currency) };
  return { label: 'На руках', value: formatMoney(balance, currency) };
}

export function renderPerson({ view, params, isCurrent }) {
  const id = params?.get('id');
  loadPerson(id).then(({ person, balance, debts, history, refs }) => {
    if (!isCurrent()) return;
    const { label, value } = balanceLine(balance, person.currency);
    const owed = debts.reduce((sum, tx) => sum + tx.amount, 0);
    view.replaceChildren(...[
      formHead(personName(person)),
      el('section', { class: 'total' },
        el('p', { class: 'total-label' }, label),
        el('p', { class: 'total-value', 'data-testid': 'person-balance' }, value)),
      el('div', { class: 'tx-actions' },
        el('a', { class: 'button button-primary', href: `#/issue?person=${person.id}` }, 'Выдать деньги'),
        el('a', { class: 'button', href: `#/transfer?from=${person.id}`, 'data-action': 'return' }, 'Вернуть в кассу')),
      debts.length > 0 && el('section', { class: 'card' },
        el('div', { class: 'card-head' },
          el('h2', {}, 'Должны передать'),
          el('p', { class: 'card-sum' }, formatMoney(owed, person.currency))),
        el('ul', { class: 'rows' }, debts.map((tx) => debtRow(tx, refs, todayIso())))),
      el('section', { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', {}, 'Что куплено и выдано')),
        history.length > 0
          ? el('ul', { class: 'rows' }, history.map((tx) => historyRow(tx, person, refs)))
          : el('p', { class: 'card-note card-empty' }, 'Пока ничего нет')),
    ].filter(Boolean));
  });
}
