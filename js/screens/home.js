import { quickBackup } from '../backup.js';
import { heldAssets, knownLocations, moveAsset } from '../barter.js';
import { db, getSettings } from '../db.js';
import {
  allBalances, isCashTotalAccount, isMoneyAccount, latestTransactions, lenderBalances, openDebts, owedText, personName, sortAccounts,
} from '../ledger.js';
import {
  addDays, daysBetween, formatDate, formatDayMonth, formatMoney, formatRate, monthName, monthOf, toKgs, todayIso,
} from '../money.js';
import { dueSoon } from '../recurring.js';
import { debtsOverview, monthExpenseSummary } from '../reports.js';
import { debtDueText, debtRow } from '../ui/debt-row.js';
import { el } from '../ui/dom.js';
import { firstIssue } from '../ui/form.js';
import { accountBadge, badge, icon } from '../ui/icons.js';
import { operationRow } from '../ui/operation-row.js';
import { openPicker } from '../ui/picker.js';
import { toast } from '../ui/toast.js';

const LATEST_COUNT = 5; // the full list is the journal
const BACKUP_WARNING_DAYS = 1;

function sumInKgs(accounts, balances, rate) {
  return accounts.reduce((sum, account) => {
    const balance = balances.get(account.id);
    return sum + (account.currency === 'USD' ? toKgs(balance, rate ?? 0) : balance);
  }, 0);
}

// The headline: money that exists right now, then what the company owes and what
// it is owed. Each figure opens its chart.
function totalCard({ accounts, balances, settings, overview }) {
  const money = accounts.filter(isMoneyAccount);
  const rate = settings.last_usd_rate;
  const total = sumInKgs(money, balances, rate);
  const atPeople = sumInKgs(money.filter((account) => account.type === 'imprest' && balances.get(account.id) > 0), balances, rate);
  const notes = [atPeople > 0 && `из них у людей ${formatMoney(atPeople, 'KGS')}`, rate && `доллар по ${formatRate(rate)}`].filter(Boolean);
  const figure = (label, value, href, testId, tone) => el('a', { class: `total-figure${tone ? ` ${tone}` : ''}`, href, 'data-testid': testId },
    el('span', { class: 'total-figure-label' }, label),
    el('span', { class: 'total-figure-value' }, formatMoney(value, 'KGS')));
  return el('section', { class: 'total' },
    el('a', { class: 'total-main', href: '#/analytics', 'data-action': 'money-chart' },
      el('p', { class: 'total-label' }, 'Деньги сейчас', icon('chevron', 'total-chevron')),
      el('p', { class: 'total-value', 'data-testid': 'total' }, formatMoney(total, 'KGS')),
      notes.length > 0 && el('p', { class: 'total-note' }, notes.join(' · '))),
    el('div', { class: 'total-figures' },
      figure('Мы должны', overview.we_owe_total, '#/analytics?view=debts', 'debt-sum', overview.we_owe_total > 0 ? 'owe' : ''),
      figure('Нам должны', overview.owed_to_us_total, '#/analytics?view=debts&split=owed', 'owed-sum', overview.owed_to_us_total > 0 ? 'owed' : '')));
}

function backupBanner(settings, today, refresh) {
  const lastBackup = settings.last_backup_at ? todayIso(new Date(settings.last_backup_at)) : null;
  const age = lastBackup ? daysBetween(lastBackup, today) : null;
  if (age !== null && age <= BACKUP_WARNING_DAYS) return null;
  return el('section', { class: 'banner' },
    icon('backup', 'banner-icon'),
    el('p', {}, age === null ? 'Бэкапа ещё не было' : `Бэкап был ${age} дн. назад`),
    el('button', {
      class: 'banner-action',
      type: 'button',
      'data-action': 'backup',
      onClick: async () => {
        try {
          if (await quickBackup()) toast('Бэкап сохранён');
          await refresh();
        } catch (error) {
          toast(firstIssue(error));
        }
      },
    }, 'Сделать'));
}

// Empty app: the three things that make it useful, in order (SPEC §7, §11).
function setupCard({ accounts, refs, templates }) {
  const hasAccounts = accounts.some(isCashTotalAccount);
  const hasObjects = [...refs.objects.values()].some((object) => !object.is_overhead);
  if (hasAccounts && hasObjects && templates > 0) return null;
  const step = (done, label, href) => el('li', {}, el('a', { class: `row row-compact row-button${done ? ' done' : ''}`, href, 'data-setup': label },
    el('p', { class: 'row-title' }, label),
    el('p', { class: 'row-amount' }, done ? 'Готово' : 'Добавить')));
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', {}, 'С чего начать')),
    el('ul', { class: 'rows' },
      step(hasAccounts, 'Счета и начальные остатки', '#/refs?table=accounts'),
      step(hasObjects, 'Строительные объекты', '#/refs?table=objects'),
      step(templates > 0, 'Регулярные платежи', '#/recurring')));
}

function accountsCard({ accounts, balances }) {
  const visible = sortAccounts(accounts.filter((account) => isCashTotalAccount(account) && !account.is_archived));
  if (visible.length === 0) return null;
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', {}, 'Счета')),
    el('ul', { class: 'rows' }, visible.map((account) => el('li', {},
      el('a', { class: 'row row-compact row-button', href: `#/journal?account=${account.id}&month=` },
        accountBadge(account),
        el('p', { class: 'row-title' }, account.name),
        el('p', { class: 'row-amount', 'data-account': account.name }, formatMoney(balances.get(account.id), account.currency)))))));
}

function personRow(account, balance) {
  return el('li', {}, el('a', { class: 'row row-compact row-button', href: `#/person?id=${account.id}`, 'data-person': personName(account) },
    badge('person', 'gray'),
    el('p', { class: 'row-title' }, personName(account)),
    el('p', { class: `row-amount${balance < 0 ? ' owed' : ''}`, 'data-account': account.name }, formatMoney(balance, account.currency))));
}

function peopleCard({ accounts, balances }) {
  const people = sortAccounts(accounts.filter((account) => account.type === 'imprest' && !account.is_archived));
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {}, 'Деньги у людей'),
      el('a', { class: 'card-action', href: '#/issue', 'data-action': 'issue' }, 'Выдать')),
    people.length > 0
      ? el('ul', { class: 'rows' }, people.map((account) => personRow(account, balances.get(account.id))))
      : el('p', { class: 'card-note card-empty' }, 'Пока никому не выдавали'));
}

function ownMoneyRow(account, amount) {
  return el('li', {}, el('a', { class: 'row row-button', href: `#/person?id=${account.id}`, 'data-owe': personName(account) },
    el('div', { class: 'row-main' },
      el('p', { class: 'row-title' }, personName(account)),
      el('p', { class: 'row-sub' }, 'Потрачены свои деньги')),
    el('p', { class: 'row-amount' }, formatMoney(amount, 'KGS'))));
}

function lenderRow(entry, refs, today) {
  const name = refs.counterparties.get(entry.counterparty_id)?.name ?? '';
  const due = entry.due_date ? debtDueText({ due_date: entry.due_date }, today) : null;
  return el('li', {}, el('a', {
    class: `row row-button${due?.overdue ? ' overdue' : ''}`, href: `#/lender?id=${entry.counterparty_id}`, 'data-lender': name,
  },
  el('div', { class: 'row-main' },
    el('p', { class: 'row-title' }, name),
    el('p', { class: 'row-sub' }, entry.source_kind === 'founder' ? 'Личные деньги учредителя' : 'Взято в долг'),
    due && el('p', { class: 'row-sub row-due' }, due.text)),
  el('p', { class: 'row-amount' }, owedText(entry))));
}

// Every debt on its own row, nearest deadline first. A negative imprest balance is
// a debt too: that person spent their own money. So is money from the founder or a loan.
function debtsCard({ debts, lenders, accounts, balances, refs, today, overview }) {
  const ownMoney = accounts
    .filter((account) => account.type === 'imprest' && balances.get(account.id) < 0)
    .map((account) => ({ account, amount: -balances.get(account.id) }));
  if (debts.length === 0 && ownMoney.length === 0 && lenders.length === 0) return null;
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {}, 'Мы должны'),
      el('a', { class: 'card-sum card-sum-link', href: '#/analytics?view=debts', 'data-testid': 'debt-total' }, formatMoney(overview.we_owe_total, 'KGS'))),
    el('ul', { class: 'rows' },
      debts.map((tx) => debtRow(tx, refs, today)),
      lenders.map((entry) => lenderRow(entry, refs, today)),
      ownMoney.map(({ account, amount }) => ownMoneyRow(account, amount))));
}

// Contractors who got a car worth more than their work (SPEC §8).
function owedCard({ overview, refs }) {
  if (overview.owed_to_us.length === 0) return null;
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {}, 'Нам должны'),
      el('a', { class: 'card-sum card-sum-link', href: '#/analytics?view=debts&split=owed', 'data-testid': 'owed-total' }, formatMoney(overview.owed_to_us_total, 'KGS'))),
    el('ul', { class: 'rows' }, overview.owed_to_us.map((row) => el('li', {}, el('a', {
      class: 'row row-button', href: `#/barter-asset?id=${row.asset.id}`, 'data-owed': row.debtor,
    },
    badge('car', 'brown'),
    el('div', { class: 'row-main' },
      el('p', { class: 'row-title' }, row.debtor || refs.counterparties.get(row.debtor_key)?.name || ''),
      el('p', { class: 'row-sub' }, `За ${row.asset.name}`)),
    el('p', { class: 'row-amount' }, formatMoney(row.owed, row.currency)))))));
}

function dueLabel(item) {
  const date = formatDate(item.due_date);
  if (item.overdue) return `Просрочено на ${-item.days_left} дн., ${date}`;
  if (item.days_left === 0) return `Сегодня, ${date}`;
  if (item.days_left === 1) return `Завтра, ${date}`;
  return `Через ${item.days_left} дн., ${date}`;
}

function dueCard({ due }) {
  if (due.items.length === 0) return null;
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {}, 'К оплате'),
      el('p', { class: 'card-sum' }, formatMoney(due.total, 'KGS'))),
    el('ul', { class: 'rows' }, due.items.map(dueRow)));
}

function dueRow(item) {
  const overdue = item.overdue ? ' overdue' : '';
  const content = [
    el('div', { class: 'row-main' },
      el('p', { class: 'row-title' }, item.name),
      el('p', { class: 'row-sub' }, dueLabel(item))),
    el('p', { class: 'row-amount' }, formatMoney(item.amount_kgs, 'KGS')),
  ];
  const href = item.planned ? `#/expense/new?planned=${item.planned.id}` : `#/expense/new?instance=${item.instance.id}`;
  return el('li', {}, el('a', { class: `row row-button${overdue}`, 'data-due': item.name, href }, content));
}

function objectCostRow({ object, amount, paid, owed }) {
  return el('li', { class: `row${owed > 0 ? '' : ' row-compact'}`, 'data-object': object.name },
    el('div', { class: 'row-main' },
      el('p', { class: 'row-title' }, object.name),
      owed > 0 && el('p', { class: 'row-sub' }, `Оплачено ${formatMoney(paid, 'KGS')}, ещё должны ${formatMoney(owed, 'KGS')}`)),
    el('p', { class: 'row-amount' }, formatMoney(amount, 'KGS')));
}

function spendingCard({ summary, today }) {
  if (summary.top_objects.length === 0) return null;
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {}, `Затраты за ${monthName(monthOf(today))}`),
      el('a', { class: 'card-sum card-sum-link', href: '#/analytics?split=groups', 'data-testid': 'month-cost' }, formatMoney(summary.total, 'KGS'))),
    summary.owed > 0 && el('p', { class: 'card-note' }, `Оплачено ${formatMoney(summary.paid, 'KGS')}, ещё должны ${formatMoney(summary.owed, 'KGS')}`),
    summary.top_objects.length > 0 && el('ul', { class: 'rows' }, summary.top_objects.map(objectCostRow)));
}

async function changeLocation(asset, refresh) {
  const places = await knownLocations();
  const picked = await openPicker({
    title: 'Где находится машина',
    items: places.map((place) => ({ id: place, label: place })),
    selectedId: asset.location,
    searchPlaceholder: 'Найти или ввести новое место',
    canCreate: true,
  });
  const place = picked?.create ?? picked;
  if (!place || place === asset.location) return;
  await moveAsset(asset.id, place);
  await refresh();
  toast(`${asset.name}: ${place}`);
}

function barterCard({ held }, refresh) {
  if (held.length === 0) return null;
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {}, 'Имущество по бартеру'),
      el('a', { class: 'card-action', href: '#/barter' }, 'Реестр')),
    el('p', { class: 'card-note' }, 'Оценка машин у компании, не входит в деньги'),
    el('ul', { class: 'rows' }, held.map(({ asset, days_held: daysHeld, overdue }) => el('li', {},
      el('button', {
        class: `row row-button${overdue ? ' stale' : ''}`, type: 'button', 'data-barter': asset.name, onClick: () => changeLocation(asset, refresh),
      },
      el('span', { class: 'row-main' },
        el('span', { class: 'row-title' }, asset.name),
        el('span', { class: 'row-place' },
          `Где: ${asset.location || 'не указано'}`,
          el('span', { class: 'row-link' }, 'изменить')),
        el('span', { class: 'row-sub' }, `${daysHeld} дн. у компании, с ${formatDayMonth(asset.received_date)}`)),
      el('span', { class: 'row-amount' }, formatMoney(asset.valuation, asset.currency)))))));
}

function operationsCard({ latest, refs }) {
  if (latest.length === 0) return null;
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h2', {}, 'Последние операции'),
      el('a', { class: 'card-action', href: '#/journal' }, 'Журнал')),
    // By day, as in the journal: the date is said once, the rows keep their place names.
    groupByDay(latest).flatMap(({ date, rows }) => [
      el('h3', { class: 'rows-day' }, dayTitle(date)),
      el('ul', { class: 'rows' }, rows.map((tx) => operationRow(tx, refs, { showDate: false }))),
    ]));
}

function groupByDay(operations) {
  const days = [];
  for (const tx of operations) {
    if (days.at(-1)?.date !== tx.date) days.push({ date: tx.date, rows: [] });
    days.at(-1).rows.push(tx);
  }
  return days;
}

function dayTitle(date) {
  const today = todayIso();
  if (date === today) return 'Сегодня';
  if (date === addDays(today, -1)) return 'Вчера';
  return date.startsWith(today.slice(0, 4)) ? formatDayMonth(date) : formatDate(date);
}

// The main actions sit on the screen itself, one tap away, without a second bar
// over the tabs. Expense is the main scenario, so it is the filled one.
function actionBar() {
  const tile = (label, href, name, primary = false) => el('a', { class: `quick-action${primary ? ' primary' : ''}`, href },
    icon(name, 'quick-icon'), el('span', {}, label));
  return el('nav', { class: 'quick-actions action-bar', 'aria-label': 'Действия' },
    tile('Расход', '#/expense/new', 'expense', true),
    tile('Приход', '#/income', 'income'),
    tile('Перевод', '#/transfer', 'transfer'),
    tile('Выдать', '#/issue', 'give'));
}

async function loadHome(today) {
  const [accounts, objects, categories, counterparties, settings, balances, due, summary, held, latest, debts, templates, lenders, overview] = await Promise.all([
    db.accounts.toArray(),
    db.objects.toArray(),
    db.categories.toArray(),
    db.counterparties.toArray(),
    getSettings(),
    allBalances(),
    dueSoon(today),
    monthExpenseSummary(monthOf(today)),
    heldAssets(today),
    latestTransactions(LATEST_COUNT),
    openDebts(),
    db.recurring_templates.count(),
    lenderBalances(),
    debtsOverview(),
  ]);
  const byId = (rows) => new Map(rows.map((row) => [row.id, row]));
  return {
    accounts,
    balances,
    settings,
    due,
    summary,
    held,
    latest,
    debts,
    lenders,
    overview,
    templates,
    today,
    refs: { accounts: byId(accounts), objects: byId(objects), categories: byId(categories), counterparties: byId(counterparties) },
  };
}

export function renderHome({ view, isCurrent }) {
  const today = todayIso();

  async function show() {
    const data = await loadHome(today);
    if (!isCurrent()) return;
    const scrollTop = view.scrollTop;
    view.replaceChildren(...[
      el('header', { class: 'home-head' },
        el('p', { class: 'home-company' }, data.settings.company_name),
        el('p', { class: 'home-date' }, formatDayMonth(today))),
      totalCard(data),
      actionBar(),
      setupCard(data),
      data.latest.length > 0 && backupBanner(data.settings, today, show),
      accountsCard(data),
      peopleCard(data),
      debtsCard(data),
      owedCard(data),
      dueCard(data),
      spendingCard(data),
      barterCard(data, show),
      operationsCard(data),
    ].filter(Boolean));
    view.scrollTop = scrollTop;
  }

  show();
}
