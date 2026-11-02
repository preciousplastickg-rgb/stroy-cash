// One debt, the same way everywhere: what for, which object, from whom, who passes
// the money on, and when it has to be given.
import { personName, shortName } from '../ledger.js';
import { daysBetween, formatDate, formatMoney } from '../money.js';
import { el } from './dom.js';

export function debtDueText(tx, today) {
  if (!tx.due_date) return { text: 'Срок не указан', overdue: false };
  const days = daysBetween(today, tx.due_date);
  const date = formatDate(tx.due_date);
  if (days < 0) return { text: `Просрочено на ${-days} дн., ${date}`, overdue: true };
  if (days === 0) return { text: `Отдать сегодня, ${date}`, overdue: false };
  if (days === 1) return { text: `Отдать завтра, ${date}`, overdue: false };
  return { text: `Отдать до ${date}`, overdue: false };
}

export function debtRow(tx, refs, today) {
  const what = shortName(refs.categories.get(tx.category_id).name);
  const object = refs.objects.get(tx.object_id)?.name;
  const supplier = refs.counterparties.get(tx.counterparty_id)?.name;
  const account = refs.accounts.get(tx.account_id);
  const { text, overdue } = debtDueText(tx, today);
  const soon = !overdue && tx.due_date && daysBetween(today, tx.due_date) <= 3;
  return el('li', {}, el('a', {
    class: `row row-button debt-row${overdue ? ' overdue' : ''}`, href: `#/expense/new?planned=${tx.id}`, 'data-debt': what,
  },
  el('div', { class: 'row-main' },
    el('p', { class: 'row-title' }, what),
    el('p', { class: 'row-sub' }, [object, supplier].filter(Boolean).join(', ')),
    account?.type === 'imprest' && el('p', { class: 'row-sub' }, `Передать: ${personName(account)}`),
    el('p', { class: `pill${overdue ? ' pill-danger' : soon ? ' pill-warn' : ''}`, 'data-due-text': text }, text)),
  el('p', { class: 'row-amount' }, formatMoney(tx.amount_kgs, 'KGS'))));
}
