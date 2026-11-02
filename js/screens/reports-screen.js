// All eight reports of SPEC §9. One Excel file holds every report of the month.
import { getSettings } from '../db.js';
import { formatDate, formatMoney, monthOf, todayIso } from '../money.js';
import {
  LIST_REPORTS, buildExcel, cashFlowReport, monthTitle, objectsReport, periodStatus, reportMonths,
} from '../reports.js';
import { el } from '../ui/dom.js';
import { firstIssue, formHead } from '../ui/form.js';
import { openPicker } from '../ui/picker.js';
import { deliverFile } from '../ui/share.js';
import { toast } from '../ui/toast.js';

const REPORTS = [
  ['cash', 'Движение денег'], ['objects', 'Расходы по объектам'], ['articles', 'Расходы по статьям по месяцам'],
  ['counterparties', 'Платежи контрагентам'], ['no-document', 'Операции без документа'], ['recurring', 'Регулярные платежи'],
  ['journal', 'Журнал операций'], ['barter', 'Реестр бартера'],
];

export function renderReports({ view }) {
  view.replaceChildren(
    el('header', { class: 'page-head' }, el('h1', {}, 'Отчёты')),
    el('section', { class: 'card' }, el('ul', { class: 'rows' }, REPORTS.map(([key, title]) => el('li', {},
      el('a', { class: 'row row-compact row-button chevron', href: `#/report?name=${key}`, 'data-report': key },
        el('p', { class: 'row-title' }, title)))))),
  );
}

function line(label, amount, currency = 'KGS', attrs = {}) {
  return el('li', { class: 'row row-compact', ...attrs }, el('p', { class: 'row-title' }, label), el('p', { class: 'row-amount' }, formatMoney(amount, currency)));
}

function card(title, sum, rows) {
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', {}, title), sum != null && el('p', { class: 'card-sum' }, formatMoney(sum, 'KGS'))),
    rows.length > 0 ? el('ul', { class: 'rows' }, rows) : el('p', { class: 'card-note card-empty' }, 'Нет операций'));
}

function cashFlowCards(report) {
  return [
    card('Остаток на начало', null, report.accounts.map(({ account, opening }) => line(account.name, opening, account.currency))),
    card('Поступления', report.income_total, report.income.map((row) => line(row.name, row.amount, 'KGS', { 'data-flow': row.name }))),
    card('Расходы', report.expense_total, report.expense.flatMap((group) => [
      el('li', { class: 'row row-compact report-group' }, el('p', { class: 'row-title' }, group.group), el('p', { class: 'row-amount' }, formatMoney(group.total, 'KGS'))),
      ...group.items.map((item) => el('li', { class: 'row row-compact report-item' }, el('p', { class: 'row-title' }, item.name), el('p', { class: 'row-amount' }, formatMoney(item.amount, 'KGS')))),
    ])),
    card('Переводы и обмены', null, report.transfers.map(({ tx, from, to }) => el('li', { class: 'row' },
      el('div', { class: 'row-main' },
        el('p', { class: 'row-title' }, `${from.name} → ${to.name}`),
        el('p', { class: 'row-sub' }, formatDate(tx.date))),
      el('p', { class: 'row-amount' }, formatMoney(tx.amount, from.currency))))),
    card('Остаток на конец', null, report.accounts.map(({ account, closing }) => line(account.name, closing, account.currency))),
  ];
}

function objectCards(entries) {
  return entries.map((entry) => {
    const allCost = entry.all.paid + entry.all.owed;
    return el('section', { class: 'card', 'data-report-object': entry.object.name },
      el('div', { class: 'card-head' }, el('h2', {}, entry.object.name), el('p', { class: 'card-sum' }, formatMoney(entry.month.paid + entry.month.owed, 'KGS'))),
      entry.month.owed > 0 && el('p', { class: 'card-note' }, `Оплачено ${formatMoney(entry.month.paid, 'KGS')}, ещё должны ${formatMoney(entry.month.owed, 'KGS')}`),
      el('ul', { class: 'rows' },
        [...entry.groups.entries()].filter(([, cell]) => cell.month > 0).map(([group, cell]) => line(group, cell.month)),
        line('Всего по объекту', allCost),
        line('Поступило всего', entry.all.income),
        line('Разница', entry.all.income - allCost)));
  });
}

function cellText(value, column) {
  if (column.type === 'date') return formatDate(value);
  if (column.type === 'money') return value ? `${column.label}: ${formatMoney(value, 'KGS')}` : '';
  return value;
}

function listCards(report) {
  const moneyIndexes = report.columns.flatMap((column, index) => (column.type === 'money' ? [index] : []));
  const main = moneyIndexes.at(-1);
  const rows = report.rows.map((row) => el('li', { class: 'row', 'data-report-row': row[0] },
    el('div', { class: 'row-main' },
      el('p', { class: 'row-title' }, row[0]),
      el('p', { class: 'row-sub' }, row.slice(1).filter((_, index) => index + 1 !== main)
        .map((value, index) => cellText(value, report.columns[index + 1 >= main ? index + 2 : index + 1]))
        .filter(Boolean).join(', '))),
    main != null && el('p', { class: 'row-amount' }, formatMoney(row[main], 'KGS'))));
  return [
    report.total != null && el('section', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h2', {}, report.total_label ?? 'Итого'),
        el('p', { class: 'card-sum', 'data-testid': 'report-total' }, formatMoney(report.total, 'KGS')))),
    rows.length > 0 ? el('section', { class: 'card' }, el('ul', { class: 'rows' }, rows)) : el('p', { class: 'stub-note' }, 'За этот месяц записей нет'),
  ].filter(Boolean);
}

async function reportCards(name, month) {
  if (name === 'cash') return cashFlowCards(await cashFlowReport(month));
  if (name === 'objects') return objectCards(await objectsReport(month));
  return listCards(await LIST_REPORTS[name](month));
}

export function renderReport({ view, params, isCurrent }) {
  const name = params?.get('name');
  const title = REPORTS.find(([key]) => key === name)?.[1] ?? 'Отчёт';
  let month = params?.get('month') ?? monthOf(todayIso());

  async function exportExcel() {
    try {
      const settings = await getSettings();
      const blob = await buildExcel(month);
      await deliverFile(blob, `${settings.company_name.replace(/[^\p{L}\p{N}]+/gu, '-')}-${month}.xlsx`);
    } catch (error) {
      toast(firstIssue(error));
    }
  }

  async function chooseMonth() {
    const months = await reportMonths();
    const picked = await openPicker({ title: 'Период', items: months.map((id) => ({ id, label: monthTitle(id) })), selectedId: month });
    if (picked) {
      month = picked;
      show();
    }
  }

  async function show() {
    const [status, cards] = await Promise.all([periodStatus(month), reportCards(name, month)]);
    if (!isCurrent()) return;
    view.replaceChildren(
      formHead(title, { href: '#/reports' }),
      el('div', { class: 'report-bar' },
        el('button', { class: 'chip filter-chip selected', type: 'button', 'data-action': 'report-month', onClick: chooseMonth }, monthTitle(month)),
        el('span', { class: 'row-sub', 'data-testid': 'report-status' }, status === 'closed' ? 'Месяц закрыт' : 'Предварительный')),
      ...cards,
      el('button', { class: 'button button-primary', type: 'button', 'data-action': 'export', onClick: exportExcel }, 'Скачать Excel'),
    );
  }

  show();
}
