// One person or company the company owes money to: how much, since when, and returning it.
import { db, getSettings } from '../db.js';
import {
  DOC_TYPES, createRepayment, isMoneyAccount, lenderBalances, owedText, shortName, sortAccounts,
} from '../ledger.js';
import { formatMoney, formatRate, todayIso } from '../money.js';
import { debtDueText } from '../ui/debt-row.js';
import { el } from '../ui/dom.js';
import { editSheet } from '../ui/edit-sheet.js';
import { formHead } from '../ui/form.js';
import { operationRow } from '../ui/operation-row.js';

export function renderLender({ view, params, isCurrent }) {
  const id = params?.get('id');

  // One currency at a time: a dollar debt is returned in dollars, from a dollar account.
  async function repay(currency, owed, accounts, lastRate) {
    const saved = await editSheet({
      title: currency === 'USD' ? 'Вернуть доллары' : 'Вернуть деньги',
      fields: [
        { key: 'amount', label: currency === 'USD' ? 'Сумма, $' : 'Сумма, сом', type: 'amount', value: owed },
        {
          key: 'account_id',
          label: 'С какого счёта',
          type: 'select',
          options: accounts.map((row) => ({ value: row.id, label: shortName(row.name) })),
        },
        currency === 'USD' && { key: 'rate', label: 'Курс к сому', type: 'rate', value: lastRate },
        { key: 'date', label: 'Дата', type: 'date', value: todayIso() },
        { key: 'doc_type', label: 'Документ', type: 'select', value: 'cash_order', options: DOC_TYPES.map((doc) => ({ value: doc.code, label: doc.label })) },
      ].filter(Boolean),
      saveLabel: 'Вернуть',
      onSave: (values, options) => createRepayment({ ...values, counterparty_id: id }, options),
    });
    if (saved) show();
  }

  async function show() {
    const [lenders, counterparty, operations, accounts, objects, categories, settings] = await Promise.all([
      lenderBalances(),
      db.counterparties.get(id),
      db.transactions.where('counterparty_id').equals(id).toArray(),
      db.accounts.toArray(), db.objects.toArray(), db.categories.toArray(), getSettings(),
    ]);
    if (!isCurrent()) return;
    const entry = lenders.find((row) => row.counterparty_id === id);
    const byId = (rows) => new Map(rows.map((row) => [row.id, row]));
    const refs = { accounts: byId(accounts), objects: byId(objects), categories: byId(categories) };
    const owed = entry?.by_currency ?? { KGS: 0, USD: 0 };
    const owing = ['KGS', 'USD'].filter((currency) => owed[currency] > 0);
    const history = operations.filter((tx) => tx.source_kind && tx.number != null).sort((a, b) => b.number - a.number);
    const money = sortAccounts(accounts.filter((row) => isMoneyAccount(row) && !row.is_archived && row.type !== 'imprest'));
    const due = entry?.due_date ? debtDueText({ due_date: entry.due_date }, todayIso()) : null;
    view.replaceChildren(...[
      formHead(counterparty.name),
      el('section', { class: 'total' },
        el('p', { class: 'total-label' }, owing.length > 0 ? 'Мы должны' : 'Долга нет'),
        el('p', { class: 'total-value', 'data-testid': 'lender-owed' }, entry ? owedText(entry) : formatMoney(0, 'KGS')),
        owed.USD > 0 && settings.last_usd_rate && el('p', { class: 'total-note' }, `≈ ${formatMoney(entry.owed, 'KGS')} по курсу ${formatRate(settings.last_usd_rate)}`),
        due && el('p', { class: `total-note${due.overdue ? ' danger-text' : ''}` }, due.text)),
      ...owing.map((currency) => el('button', {
        class: 'button button-primary',
        type: 'button',
        'data-action': owing.length > 1 ? `repay-${currency.toLowerCase()}` : 'repay',
        onClick: () => repay(currency, owed[currency], money.filter((row) => row.currency === currency), settings.last_usd_rate),
      }, owing.length > 1 ? `Вернуть ${currency === 'USD' ? 'доллары' : 'сомы'}` : 'Вернуть деньги')),
      el('section', { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', {}, 'Получено и возвращено')),
        el('ul', { class: 'rows' }, history.map((tx) => operationRow(tx, refs)))),
    ].filter(Boolean));
  }

  show();
}
