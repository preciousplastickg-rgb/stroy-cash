// One person or company the company owes money to: how much, since when, and returning it.
import { db } from '../db.js';
import {
  DOC_TYPES, createRepayment, isMoneyAccount, lenderBalances, shortName, sortAccounts,
} from '../ledger.js';
import { formatMoney, todayIso } from '../money.js';
import { debtDueText } from '../ui/debt-row.js';
import { el } from '../ui/dom.js';
import { editSheet } from '../ui/edit-sheet.js';
import { formHead } from '../ui/form.js';
import { operationRow } from '../ui/operation-row.js';

export function renderLender({ view, params, isCurrent }) {
  const id = params?.get('id');

  async function repay(owed, accounts) {
    const saved = await editSheet({
      title: 'Вернуть деньги',
      fields: [
        { key: 'amount', label: 'Сумма', type: 'amount', value: owed },
        {
          key: 'account_id',
          label: 'С какого счёта',
          type: 'select',
          options: accounts.map((row) => ({ value: row.id, label: shortName(row.name) })),
        },
        { key: 'date', label: 'Дата', type: 'date', value: todayIso() },
        { key: 'doc_type', label: 'Документ', type: 'select', value: 'cash_order', options: DOC_TYPES.map((doc) => ({ value: doc.code, label: doc.label })) },
      ],
      saveLabel: 'Вернуть',
      onSave: (values, options) => createRepayment({ ...values, counterparty_id: id }, options),
    });
    if (saved) show();
  }

  async function show() {
    const [lenders, counterparty, operations, accounts, objects, categories] = await Promise.all([
      lenderBalances(),
      db.counterparties.get(id),
      db.transactions.where('counterparty_id').equals(id).toArray(),
      db.accounts.toArray(), db.objects.toArray(), db.categories.toArray(),
    ]);
    if (!isCurrent()) return;
    const entry = lenders.find((row) => row.counterparty_id === id);
    const byId = (rows) => new Map(rows.map((row) => [row.id, row]));
    const refs = { accounts: byId(accounts), objects: byId(objects), categories: byId(categories) };
    const owed = entry?.owed ?? 0;
    const history = operations.filter((tx) => tx.source_kind && tx.number != null).sort((a, b) => b.number - a.number);
    const money = sortAccounts(accounts.filter((row) => isMoneyAccount(row) && !row.is_archived && row.type !== 'imprest'));
    const due = entry?.due_date ? debtDueText({ due_date: entry.due_date }, todayIso()) : null;
    view.replaceChildren(...[
      formHead(counterparty.name),
      el('section', { class: 'total' },
        el('p', { class: 'total-label' }, owed > 0 ? 'Мы должны' : 'Долга нет'),
        el('p', { class: 'total-value', 'data-testid': 'lender-owed' }, formatMoney(owed, 'KGS')),
        due && el('p', { class: `total-note${due.overdue ? ' danger-text' : ''}` }, due.text)),
      owed > 0 && el('button', { class: 'button button-primary', type: 'button', 'data-action': 'repay', onClick: () => repay(owed, money) }, 'Вернуть деньги'),
      el('section', { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', {}, 'Получено и возвращено')),
        el('ul', { class: 'rows' }, history.map((tx) => operationRow(tx, refs)))),
    ].filter(Boolean));
  }

  show();
}
