// Objects: what each one cost, for the month and in total. Costs include debts and
// cars given to contractors, income is what the customer paid (SPEC §5.8).
import { db } from '../db.js';
import { formatMoney, monthOf, todayIso } from '../money.js';
import { monthTitle, objectsReport } from '../reports.js';
import { debtRow } from '../ui/debt-row.js';
import { el } from '../ui/dom.js';
import { formHead } from '../ui/form.js';

function costNote(paid, owed) {
  return owed > 0 ? `Оплачено ${formatMoney(paid, 'KGS')}, ещё должны ${formatMoney(owed, 'KGS')}` : null;
}

export function renderObjects({ view, isCurrent }) {
  const month = monthOf(todayIso());
  objectsReport(month).then((entries) => {
    if (!isCurrent()) return;
    view.replaceChildren(
      el('header', { class: 'page-head' }, el('h1', {}, 'Объекты')),
      entries.length === 0
        ? el('p', { class: 'stub-note' }, 'Объектов пока нет')
        : el('section', { class: 'card' }, el('ul', { class: 'rows' }, entries.map((entry) => {
          const allCost = entry.all.paid + entry.all.owed;
          const monthCost = entry.month.paid + entry.month.owed;
          return el('li', {}, el('a', { class: 'row row-button', href: `#/object?id=${entry.object.id}`, 'data-object': entry.object.name },
            el('div', { class: 'row-main' },
              el('p', { class: 'row-title' }, entry.object.name),
              el('p', { class: 'row-sub' }, `За ${monthTitle(month)}: ${formatMoney(monthCost, 'KGS')}`),
              entry.all.owed > 0 && el('p', { class: 'row-sub' }, `Ещё должны ${formatMoney(entry.all.owed, 'KGS')}`)),
            el('p', { class: 'row-amount' }, formatMoney(allCost, 'KGS'))));
        }))),
    );
  });
}

export function renderObject({ view, params, isCurrent }) {
  const id = params?.get('id');
  const month = monthOf(todayIso());

  Promise.all([objectsReport(month), db.accounts.toArray(), db.objects.toArray(), db.categories.toArray(), db.counterparties.toArray()])
    .then(([entries, accounts, objects, categories, counterparties]) => {
      if (!isCurrent()) return;
      const entry = entries.find((row) => row.object.id === id);
      if (!entry) {
        location.hash = '#/objects';
        return;
      }
      const byId = (rows) => new Map(rows.map((row) => [row.id, row]));
      const refs = { accounts: byId(accounts), objects: byId(objects), categories: byId(categories), counterparties: byId(counterparties) };
      const allCost = entry.all.paid + entry.all.owed;
      const difference = entry.all.income - allCost;
      const articles = [...entry.articles.entries()].sort((a, b) => b[1] - a[1]);
      view.replaceChildren(...[
        formHead(entry.object.name, { href: '#/objects' }),
        el('section', { class: 'total' },
          el('p', { class: 'total-label' }, 'Стоимость объекта'),
          el('p', { class: 'total-value', 'data-testid': 'object-cost' }, formatMoney(allCost, 'KGS')),
          costNote(entry.all.paid, entry.all.owed) && el('p', { class: 'total-note' }, costNote(entry.all.paid, entry.all.owed))),
        el('section', { class: 'card' }, el('ul', { class: 'rows' },
          el('li', { class: 'row row-compact' }, el('p', { class: 'row-title' }, 'Поступило от заказчика'), el('p', { class: 'row-amount income' }, formatMoney(entry.all.income, 'KGS'))),
          el('li', { class: 'row row-compact' }, el('p', { class: 'row-title' }, 'Разница'), el('p', { class: `row-amount${difference < 0 ? ' owed' : ''}`, 'data-testid': 'object-difference' }, formatMoney(difference, 'KGS', { signed: true }))))),
        entry.debts.length > 0 && el('section', { class: 'card' },
          el('div', { class: 'card-head' }, el('h2', {}, 'Ещё должны')),
          el('ul', { class: 'rows' }, entry.debts.map((tx) => debtRow(tx, refs, todayIso())))),
        articles.length > 0 && el('section', { class: 'card' },
          el('div', { class: 'card-head' }, el('h2', {}, 'Расходы по статьям')),
          el('ul', { class: 'rows' }, articles.map(([name, amount]) => el('li', { class: 'row row-compact' },
            el('p', { class: 'row-title' }, name), el('p', { class: 'row-amount' }, formatMoney(amount, 'KGS')))))),
        el('a', { class: 'button', href: `#/journal?object=${id}&month=` }, 'Все операции объекта'),
      ].filter(Boolean));
    });
}
