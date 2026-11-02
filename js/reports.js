// Report calculations. Money reports use posted operations by `date` on `amount_kgs`
// and leave barter accounts out. Object costs include barter and unpaid debts: they
// answer what the object really cost, not where the money went (SPEC §6, §9).
import { db, getSettings } from './db.js';
import { balanceFromTransactions, isMoneyAccount, shortName, sortAccounts } from './ledger.js';
import { formatDate, monthName, monthOf } from './money.js';

const TOP_OBJECTS = 3;
const BARTER_SALES = 'Продажа бартерного имущества';

function costMonth(tx) {
  return monthOf(tx.cost_date ?? tx.date);
}

// An opposite operation counts against the side of its original: a returned expense
// lowers expenses instead of looking like income (SPEC §6).
function originalKind(tx) {
  return tx.reversal_kind ?? tx.type;
}

function signOf(tx) {
  return tx.reversal_kind ? -1 : 1;
}

// Returning a loan moves money but costs no object.
function isCost(tx) {
  return originalKind(tx) === 'expense' && tx.source_kind !== 'repayment'
    && (tx.status === 'posted' || (tx.status === 'planned' && tx.plan_kind === 'debt'));
}

function isIncome(tx) {
  return originalKind(tx) === 'income' && tx.status === 'posted';
}

// Only customers' money is income of an object. The company's own money, the founder's
// and loans pay for the work, they are not what the customer paid.
function isCustomerIncome(tx) {
  return isIncome(tx) && !['company', 'founder', 'loan'].includes(tx.source_kind);
}

const SOURCE_LINES = { founder: 'Деньги учредителя', loan: 'Получено в долг' };

function addCost(entry, tx) {
  if (tx.status === 'posted') entry.paid += signOf(tx) * tx.amount_kgs;
  else entry.owed += tx.amount_kgs;
}

export async function monthExpenseSummary(month) {
  const rows = await db.transactions.where('date').aboveOrEqual(`${month}-01`).toArray();
  const byObject = new Map();
  for (const tx of rows.filter((row) => isCost(row) && costMonth(row) === month)) {
    if (!byObject.has(tx.object_id)) byObject.set(tx.object_id, { paid: 0, owed: 0 });
    addCost(byObject.get(tx.object_id), tx);
  }
  const totals = [...byObject.values()];
  const top = [...byObject.entries()].sort(([, a], [, b]) => b.paid + b.owed - a.paid - a.owed).slice(0, TOP_OBJECTS);
  const objects = await db.objects.bulkGet(top.map(([objectId]) => objectId));
  const paid = totals.reduce((sum, entry) => sum + entry.paid, 0);
  const owed = totals.reduce((sum, entry) => sum + entry.owed, 0);
  return {
    total: paid + owed,
    paid,
    owed,
    top_objects: top.map(([, entry], index) => ({ object: objects[index], amount: entry.paid + entry.owed, ...entry })),
  };
}

function groupOf(category, categoriesById) {
  return categoriesById.get(category?.parent_id)?.name ?? 'Прочее';
}

// Costs, customer income and the difference per object, for the month and in total.
export async function objectsReport(month) {
  const [transactions, objects, categories] = await Promise.all([
    db.transactions.toArray(), db.objects.toArray(), db.categories.toArray(),
  ]);
  const categoriesById = new Map(categories.map((row) => [row.id, row]));
  const entries = new Map(objects.map((object) => [object.id, {
    object,
    month: { paid: 0, owed: 0, income: 0 },
    all: { paid: 0, owed: 0, income: 0 },
    groups: new Map(),
    articles: new Map(),
    debts: [],
  }]));

  for (const tx of transactions) {
    const entry = entries.get(tx.object_id);
    if (!entry) continue;
    if (isCost(tx)) {
      const category = categoriesById.get(tx.category_id);
      addCost(entry.all, tx);
      if (costMonth(tx) === month) addCost(entry.month, tx);
      const group = groupOf(category, categoriesById);
      const cell = entry.groups.get(group) ?? { month: 0, all: 0 };
      const amount = signOf(tx) * tx.amount_kgs;
      cell.all += amount;
      if (costMonth(tx) === month) cell.month += amount;
      entry.groups.set(group, cell);
      const name = shortName(category?.name ?? '');
      entry.articles.set(name, (entry.articles.get(name) ?? 0) + amount);
      if (tx.status === 'planned') entry.debts.push(tx);
    } else if (isCustomerIncome(tx)) {
      entry.all.income += signOf(tx) * tx.amount_kgs;
      if (monthOf(tx.date) === month) entry.month.income += signOf(tx) * tx.amount_kgs;
    }
  }

  return [...entries.values()]
    .filter((entry) => entry.object.status !== 'archived' || entry.all.paid + entry.all.owed + entry.all.income > 0)
    .sort((a, b) => b.all.paid + b.all.owed - a.all.paid - a.all.owed);
}

function balanceBefore(account, transactions, date) {
  return balanceFromTransactions(account, transactions.filter((tx) => tx.date < date));
}

function addTo(map, key, amount) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

// Cash flow statement for one month. Barter accounts are out, so money from selling
// a car comes in through its own line instead of disappearing from the report.
export async function cashFlowReport(month) {
  const [transactions, allAccounts, categories] = await Promise.all([
    db.transactions.toArray(), db.accounts.toArray(), db.categories.toArray(),
  ]);
  const posted = transactions.filter((tx) => tx.status === 'posted');
  const categoriesById = new Map(categories.map((row) => [row.id, row]));
  const accounts = sortAccounts(allAccounts.filter(isMoneyAccount));
  const isMoney = new Set(accounts.map((account) => account.id));
  const inMonth = posted.filter((tx) => monthOf(tx.date) === month);
  const start = `${month}-01`;
  const end = nextMonthStart(month);

  const income = new Map();
  const expense = new Map();
  const transfers = [];
  let barterSales = 0;

  for (const tx of inMonth) {
    if (isIncome(tx) && isMoney.has(tx.account_id)) {
      const line = SOURCE_LINES[tx.source_kind] ?? shortName(categoriesById.get(tx.category_id).name);
      addTo(income, line, signOf(tx) * tx.amount_kgs);
    } else if (originalKind(tx) === 'expense' && isMoney.has(tx.account_id)) {
      const category = categoriesById.get(tx.category_id);
      const group = groupOf(category, categoriesById);
      if (!expense.has(group)) expense.set(group, new Map());
      addTo(expense.get(group), shortName(category.name), signOf(tx) * tx.amount_kgs);
    } else if (tx.type === 'transfer') {
      if (!isMoney.has(tx.account_id) && isMoney.has(tx.to_account_id)) barterSales += tx.amount_kgs;
      else if (isMoney.has(tx.account_id) && isMoney.has(tx.to_account_id)) transfers.push(tx);
    }
  }

  const expenseGroups = [...expense.entries()].map(([group, items]) => ({
    group,
    total: [...items.values()].reduce((sum, amount) => sum + amount, 0),
    items: [...items.entries()].map(([name, amount]) => ({ name, amount })),
  })).sort((a, b) => b.total - a.total);
  const incomeRows = [...income.entries()].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount);
  if (barterSales > 0) incomeRows.push({ name: BARTER_SALES, amount: barterSales });

  return {
    month,
    accounts: accounts.map((account) => ({
      account,
      opening: balanceBefore(account, posted, start),
      closing: balanceBefore(account, posted, end),
    })),
    income: incomeRows,
    expense: expenseGroups,
    transfers: transfers.map((tx) => ({
      tx,
      from: allAccounts.find((account) => account.id === tx.account_id),
      to: allAccounts.find((account) => account.id === tx.to_account_id),
    })),
    income_total: incomeRows.reduce((sum, row) => sum + row.amount, 0),
    expense_total: expenseGroups.reduce((sum, row) => sum + row.total, 0),
  };
}

function nextMonthStart(month) {
  const [year, number] = month.split('-').map(Number);
  return number === 12 ? `${year + 1}-01-01` : `${year}-${String(number + 1).padStart(2, '0')}-01`;
}

export async function balancesAtMonthEnd(month) {
  const [transactions, allAccounts] = await Promise.all([db.transactions.where('status').equals('posted').toArray(), db.accounts.toArray()]);
  const end = nextMonthStart(month);
  return sortAccounts(allAccounts.filter((account) => isMoneyAccount(account) && !account.is_archived))
    .map((account) => ({ account, balance: balanceBefore(account, transactions, end) }));
}

export async function periodStatus(month) {
  const period = await db.periods.where('month').equals(month).first();
  return period?.status ?? 'open';
}

export async function reportMonths() {
  const first = await db.transactions.orderBy('date').first();
  const last = await db.transactions.orderBy('date').last();
  if (!first) return [];
  const months = [];
  for (let month = monthOf(first.date); month <= monthOf(last.date); month = nextMonthStart(month).slice(0, 7)) months.push(month);
  return months.reverse();
}

export function monthTitle(month) {
  return `${monthName(month)} ${month.slice(0, 4)}`;
}

// The six list reports share one shape, so the screen and Excel read the same data:
// { title, columns: [{ label, type: 'text'|'money'|'date' }], rows, total? }.
const text = (label) => ({ label, type: 'text' });
const amountColumn = (label) => ({ label, type: 'money' });
const dateColumn = (label) => ({ label, type: 'date' });

async function references() {
  const [accounts, objects, categories, counterparties] = await Promise.all([
    db.accounts.toArray(), db.objects.toArray(), db.categories.toArray(), db.counterparties.toArray(),
  ]);
  const byId = (rows) => new Map(rows.map((row) => [row.id, row]));
  return { accounts: byId(accounts), objects: byId(objects), categories: byId(categories), counterparties: byId(counterparties) };
}

function shiftMonth(month, delta) {
  const [year, number] = month.split('-').map(Number);
  const moved = new Date(Date.UTC(year, number - 1 + delta, 1));
  return moved.toISOString().slice(0, 7);
}

export async function articlesByMonthReport(month) {
  const refs = await references();
  const months = Array.from({ length: 6 }, (_, index) => shiftMonth(month, index - 5));
  const rows = new Map();
  const transactions = await db.transactions.where('status').equals('posted').toArray();
  for (const tx of transactions) {
    const position = months.indexOf(monthOf(tx.date));
    if (position === -1 || !isCost(tx) || refs.accounts.get(tx.account_id)?.type === 'barter') continue;
    const category = refs.categories.get(tx.category_id);
    if (!rows.has(category.id)) rows.set(category.id, { category, cells: months.map(() => 0) });
    rows.get(category.id).cells[position] += signOf(tx) * tx.amount_kgs;
  }
  return {
    title: 'Расходы по статьям по месяцам',
    columns: [text('Статья'), ...months.map((item) => amountColumn(monthTitle(item)))],
    rows: [...rows.values()]
      .sort((a, b) => a.category.position - b.category.position)
      .map(({ category, cells }) => [shortName(category.name), ...cells]),
  };
}

export async function counterpartyPaymentsReport(month) {
  const refs = await references();
  const transactions = await db.transactions.where('[type+date]').between(['expense', `${month}-01`], ['expense', `${month}-31`], true, true).toArray();
  const paid = transactions.filter((tx) => tx.status === 'posted' && tx.counterparty_id).sort((a, b) => a.date.localeCompare(b.date));
  return {
    title: 'Платежи контрагентам',
    columns: [text('Контрагент'), dateColumn('Дата'), text('№'), text('Статья'), text('Объект'), amountColumn('Сумма')],
    rows: paid
      .map((tx) => [refs.counterparties.get(tx.counterparty_id).name, tx.date, String(tx.number), shortName(refs.categories.get(tx.category_id).name), refs.objects.get(tx.object_id)?.name ?? '', tx.amount_kgs])
      .sort((a, b) => a[0].localeCompare(b[0], 'ru')),
    grouped: true,
    total: paid.reduce((sum, tx) => sum + tx.amount_kgs, 0),
  };
}

export async function noDocumentReport(month) {
  const refs = await references();
  const transactions = await db.transactions.where('[type+date]').between(['expense', `${month}-01`], ['expense', `${month}-31`], true, true).toArray();
  const found = transactions.filter((tx) => tx.status === 'posted' && (tx.doc_type === 'none' || tx.doc_type === 'transfer_screenshot'))
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    title: 'Операции без документа',
    columns: [text('Статья'), dateColumn('Дата'), text('№'), text('Документ'), text('Объект'), amountColumn('Сумма')],
    rows: found.map((tx) => [shortName(refs.categories.get(tx.category_id).name), tx.date, String(tx.number), tx.doc_type === 'none' ? 'Без документа' : 'Скриншот перевода', refs.objects.get(tx.object_id)?.name ?? '', tx.amount_kgs]),
    total: found.reduce((sum, tx) => sum + tx.amount_kgs, 0),
  };
}

export async function recurringReport(month) {
  const [templates, instances, payments] = await Promise.all([
    db.recurring_templates.toArray(), db.recurring_instances.toArray(), db.transactions.where('recurring_instance_id').above('').toArray(),
  ]);
  const byInstance = new Map(payments.filter((tx) => tx.status === 'posted').map((tx) => [tx.recurring_instance_id, tx]));
  const labels = { paid: 'Оплачено', pending: 'Не оплачено', skipped: 'Пропущено' };
  const rows = instances.filter((row) => monthOf(row.due_date) === month).map((row) => {
    const template = templates.find((item) => item.id === row.template_id);
    const status = row.skip_reason ? `Пропущено: ${row.skip_reason}` : labels[row.status];
    return [template.name, row.due_date, status, template.amount, byInstance.get(row.id)?.amount_kgs ?? 0];
  }).sort((a, b) => a[1].localeCompare(b[1]));
  return {
    title: 'Регулярные платежи',
    columns: [text('Шаблон'), dateColumn('Срок'), text('Статус'), amountColumn('План'), amountColumn('Факт')],
    rows,
  };
}

const JOURNAL_STATUS = { posted: 'Проведена', reversed: 'Сторнирована' };
const TYPE_NAMES = { expense: 'Расход', income: 'Поступление', transfer: 'Перевод' };

export async function journalReport(month) {
  const refs = await references();
  const transactions = await db.transactions.where('date').between(`${month}-01`, `${month}-31`, true, true).toArray();
  const rows = transactions.filter((tx) => tx.number != null).sort((a, b) => a.number - b.number).map((tx) => [
    `${TYPE_NAMES[tx.type]} №${tx.number}`,
    tx.date,
    JOURNAL_STATUS[tx.status] + (tx.reversal_reason ? `: ${tx.reversal_reason}` : ''),
    refs.accounts.get(tx.account_id)?.name ?? '',
    refs.accounts.get(tx.to_account_id)?.name ?? '',
    shortName(refs.categories.get(tx.category_id)?.name ?? ''),
    refs.objects.get(tx.object_id)?.name ?? '',
    refs.counterparties.get(tx.counterparty_id)?.name ?? '',
    tx.doc_type ?? '',
    tx.doc_number,
    tx.description,
    tx.amount_kgs,
  ]);
  return {
    title: 'Журнал операций',
    columns: [text('Операция'), dateColumn('Дата'), text('Статус'), text('Счёт'), text('На счёт'), text('Статья'), text('Объект'), text('Контрагент'), text('Документ'), text('Номер'), text('Описание'), amountColumn('Сумма в сомах')],
    rows,
  };
}

export async function barterReport(month) {
  const refs = await references();
  const [assets, transactions] = await Promise.all([db.barter_assets.toArray(), db.transactions.where('barter_asset_id').above('').toArray()]);
  const statuses = { held: 'У компании', transferred: 'Передана', sold_by_company: 'Продана компанией' };
  const reimbursements = transactions.filter((tx) => tx.barter_meta && tx.status === 'posted');
  const inPeriod = reimbursements.filter((tx) => monthOf(tx.date) === month);
  return {
    title: 'Реестр бартера',
    columns: [text('Машина'), text('Покупатель, квартира'), text('Статус'), text('Кому передана'), amountColumn('Оценка в сомах'), amountColumn('Возмещено в сомах'), text('Причина, согласовал')],
    rows: assets.map((asset) => {
      const own = reimbursements.filter((tx) => tx.barter_asset_id === asset.id);
      const income = transactions.find((tx) => tx.barter_asset_id === asset.id && tx.type === 'income');
      return [
        asset.name,
        `${refs.counterparties.get(asset.buyer_id)?.name ?? ''}, кв. ${asset.apartment}`,
        statuses[asset.status],
        refs.counterparties.get(asset.transferred_to_id)?.name ?? '',
        income?.amount_kgs ?? 0,
        own.reduce((sum, tx) => sum + tx.amount_kgs, 0),
        own.map((tx) => `${tx.barter_meta.reason}, ${tx.barter_meta.approved_by}${tx.doc_type === 'none' ? ', без документа' : ''}`).join('; '),
      ];
    }),
    total: inPeriod.reduce((sum, tx) => sum + tx.amount_kgs, 0),
    total_label: 'Возмещено за период',
  };
}

export const LIST_REPORTS = {
  articles: articlesByMonthReport,
  counterparties: counterpartyPaymentsReport,
  'no-document': noDocumentReport,
  recurring: recurringReport,
  journal: journalReport,
  barter: barterReport,
};

// Excel export.

function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'vendor/xlsx.full.min.js';
    script.onload = () => resolve(window.XLSX);
    script.onerror = () => reject(new Error('Не удалось загрузить модуль Excel'));
    document.head.append(script);
  });
}

const NUMBER_FORMAT = '# ##0.00';
const DATE_FORMAT = 'dd.mm.yyyy';
const money = (minor) => ({ t: 'n', v: minor / 100, z: NUMBER_FORMAT });

// Excel stores a date as a day count, which also avoids any time zone shift.
function excelDate(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return { t: 'n', v: (Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86400000, z: DATE_FORMAT };
}

function sheetHeader(company, title, month, status) {
  const state = status === 'closed' ? 'месяц закрыт' : 'месяц открыт, отчёт предварительный';
  return [[company], [title], [`Период: ${monthTitle(month)}, ${state}`], []];
}

function cashFlowRows(report) {
  const rows = [['Остаток на начало', 'Валюта', 'Сумма']];
  for (const { account, opening } of report.accounts) rows.push([account.name, account.currency, money(opening)]);
  rows.push([], ['Поступления', '', money(report.income_total)]);
  for (const row of report.income) rows.push([row.name, 'KGS', money(row.amount)]);
  rows.push([], ['Расходы', '', money(report.expense_total)]);
  for (const group of report.expense) {
    rows.push([group.group, 'KGS', money(group.total)]);
    for (const item of group.items) rows.push([`  ${item.name}`, 'KGS', money(item.amount)]);
  }
  rows.push([], ['Переводы и обмены', '', '']);
  for (const { tx, from, to } of report.transfers) {
    rows.push([`${from.name} → ${to.name}`, excelDate(tx.date), money(tx.amount_kgs)]);
  }
  rows.push([], ['Остаток на конец', 'Валюта', 'Сумма']);
  for (const { account, closing } of report.accounts) rows.push([account.name, account.currency, money(closing)]);
  return rows;
}

function objectRows(entries) {
  const groups = [...new Set(entries.flatMap((entry) => [...entry.groups.keys()]))];
  const rows = [['Объект', ...groups, 'Затраты за месяц', 'Оплачено', 'Ещё должны', 'Затраты всего', 'Поступления всего', 'Разница']];
  for (const entry of entries) {
    const allCost = entry.all.paid + entry.all.owed;
    rows.push([
      entry.object.name,
      ...groups.map((group) => money(entry.groups.get(group)?.month ?? 0)),
      money(entry.month.paid + entry.month.owed),
      money(entry.month.paid),
      money(entry.month.owed),
      money(allCost),
      money(entry.all.income),
      money(entry.all.income - allCost),
    ]);
  }
  return rows;
}

function listRows(report) {
  const cell = (value, column) => {
    if (column.type === 'money') return money(value);
    if (column.type === 'date') return excelDate(value);
    return value;
  };
  const rows = [report.columns.map((column) => column.label)];
  for (const row of report.rows) rows.push(row.map((value, index) => cell(value, report.columns[index])));
  if (report.total != null) rows.push([], [report.total_label ?? 'Итого', ...Array(report.columns.length - 2).fill(''), money(report.total)]);
  return rows;
}

const SHEET_NAMES = {
  articles: 'Статьи по месяцам',
  counterparties: 'Контрагенты',
  'no-document': 'Без документа',
  recurring: 'Регулярные',
  journal: 'Журнал',
  barter: 'Бартер',
};

export async function buildExcel(month) {
  const XLSX = await loadXlsx();
  const [settings, status, flow, objects] = await Promise.all([
    getSettings(), periodStatus(month), cashFlowReport(month), objectsReport(month),
  ]);
  const book = XLSX.utils.book_new();
  const company = settings.company_name;
  const append = (name, rows, cols) => {
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet['!cols'] = cols;
    XLSX.utils.book_append_sheet(book, sheet, name);
  };
  append('ДДС', [...sheetHeader(company, 'Движение денег', month, status), ...cashFlowRows(flow)], [{ wch: 44 }, { wch: 12 }, { wch: 16 }]);
  append('Объекты', [...sheetHeader(company, 'Расходы по объектам', month, status), ...objectRows(objects)], [{ wch: 30 }]);
  for (const [key, build] of Object.entries(LIST_REPORTS)) {
    const report = await build(month);
    append(SHEET_NAMES[key], [...sheetHeader(company, report.title, month, status), ...listRows(report)], report.columns.map(() => ({ wch: 18 })));
  }
  const bytes = XLSX.write(book, { type: 'array', bookType: 'xlsx' });
  return new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
