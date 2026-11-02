// Charts behind the home totals: where the money is and where it went, who the
// company owes and who owes the company. State lives in the address, so back from
// a drilled row returns to the same chart.
import { db, getSettings } from '../db.js';
import { allBalances, isMoneyAccount, personName, sortAccounts } from '../ledger.js';
import { formatMoney, monthOf, toKgs, todayIso } from '../money.js';
import { replaceParams } from '../nav.js';
import { costBreakdown, debtsOverview, monthInText, monthTitle, reportMonths } from '../reports.js';
import { barList } from '../ui/bars.js';
import { debtDueText, debtRow } from '../ui/debt-row.js';
import { el } from '../ui/dom.js';
import { formHead } from '../ui/form.js';
import { openPicker } from '../ui/picker.js';

const MONEY_SPLITS = [['accounts', 'Счета'], ['groups', 'Статьи'], ['objects', 'Объекты']];
const DEBT_SPLITS = [['creditors', 'Кому'], ['objects', 'Объекты'], ['owed', 'Нам должны']];
const KIND_NOTES = { founder: 'Личные деньги учредителя', loan: 'Взято в долг', own_money: 'Потрачены свои деньги' };

function segments(options, selected, onPick, name) {
  return el('div', { class: `segments segments-${options.length}`, role: 'tablist', 'data-segments': name },
    options.map(([key, label]) => el('button', {
      class: `segment${key === selected ? ' selected' : ''}`,
      type: 'button',
      role: 'tab',
      'aria-selected': String(key === selected),
      'data-segment': key,
      onClick: () => onPick(key),
    }, label)));
}

function hero(label, value, note, testId) {
  return el('section', { class: 'total chart-hero' },
    el('p', { class: 'total-label' }, label),
    el('p', { class: 'total-value', 'data-testid': testId }, value),
    note && el('p', { class: 'total-note' }, note));
}

function emptyNote(text) {
  return el('p', { class: 'card-note card-empty' }, text);
}

function chartCard(title, sum, note, body) {
  return el('section', { class: 'card chart-card' },
    el('div', { class: 'card-head' }, el('h2', {}, title), sum && el('p', { class: 'card-sum' }, sum)),
    note && el('p', { class: 'card-note' }, note),
    body);
}

function moneyTotal(accounts, balances, rate) {
  return accounts.reduce((sum, account) => {
    const balance = balances.get(account.id);
    return sum + (account.currency === 'USD' ? toKgs(balance, rate ?? 0) : balance);
  }, 0);
}

async function accountsChart() {
  const [accounts, balances, settings] = await Promise.all([db.accounts.toArray(), allBalances(), getSettings()]);
  const rate = settings.last_usd_rate;
  const money = sortAccounts(accounts.filter((account) => isMoneyAccount(account) && !account.is_archived));
  const items = money
    .map((account) => {
      const balance = balances.get(account.id);
      const inSoms = account.currency === 'USD' ? toKgs(balance, rate ?? 0) : balance;
      return {
        key: account.id,
        label: account.type === 'imprest' ? personName(account) : account.name,
        sub: account.type === 'imprest' ? 'Деньги у человека' : account.currency === 'USD' ? formatMoney(inSoms, 'KGS') : null,
        amount: inSoms,
        display: formatMoney(balance, account.currency),
        href: account.type === 'imprest' ? `#/person?id=${account.id}` : `#/journal?account=${account.id}&month=`,
      };
    })
    .filter((item) => item.amount !== 0)
    .sort((a, b) => b.amount - a.amount);
  return {
    total: moneyTotal(money, balances, rate),
    rate,
    card: chartCard('Где деньги', null, null, items.length > 0 ? barList(items) : emptyNote('Денег на счетах нет')),
  };
}

async function costsChart(state, chooseMonth, setGroup) {
  const month = state.month === 'all' ? null : state.month;
  const by = state.split === 'objects' ? 'objects' : state.group ? 'categories' : 'groups';
  const result = await costBreakdown({ month, by, group: state.group });
  const groupName = state.group
    ? (await db.categories.get(state.group))?.name ?? 'Прочее'
    : null;
  // A group opens its articles on the same chart; back returns to the groups.
  const hrefOf = (key) => {
    if (by === 'objects') return key ? `#/object?id=${key}` : null;
    if (by === 'categories') return `#/journal?category=${key}&month=${month ?? ''}`;
    return `#/analytics?view=money&split=groups&month=${state.month}&group=${key}`;
  };
  const rows = result.items.map((item) => ({ ...item, display: formatMoney(item.amount, 'KGS'), href: hrefOf(item.key) }));
  const period = month ? monthInText(month) : 'всё время';
  const title = state.split === 'objects' ? 'Затраты по объектам' : groupName ?? 'Затраты по статьям';
  const note = result.owed > 0
    ? `Оплачено ${formatMoney(result.paid, 'KGS')}, ещё должны ${formatMoney(result.owed, 'KGS')}`
    : null;
  return el('div', { class: 'chart-stack' },
    el('div', { class: 'chart-filters' },
      el('button', { class: 'chip filter-chip selected', type: 'button', 'data-action': 'chart-period', onClick: chooseMonth }, month ? monthTitle(month) : 'За всё время'),
      state.group && el('button', { class: 'chip filter-chip', type: 'button', 'data-action': 'all-groups', onClick: () => setGroup(null) }, 'Все статьи')),
    chartCard(title, formatMoney(result.total, 'KGS'), note,
      rows.length > 0 ? barList(rows) : emptyNote(`Затрат за ${period} нет`)));
}

function creditorItems(overview, refs, today) {
  const byCreditor = new Map();
  for (const row of overview.we_owe) {
    const entry = byCreditor.get(row.creditor_key) ?? { key: row.creditor_key, label: row.creditor, amount: 0, rows: [] };
    entry.amount += row.amount;
    entry.rows.push(row);
    byCreditor.set(row.creditor_key, entry);
  }
  return [...byCreditor.values()].sort((a, b) => b.amount - a.amount).map((entry) => {
    const debts = entry.rows.filter((row) => row.kind === 'debt');
    const other = entry.rows.find((row) => row.kind !== 'debt');
    const nearest = debts.map((row) => row.tx).find((tx) => tx.due_date);
    const subs = [
      debts.length > 0 && (debts.length === 1 ? 'Покупка в долг' : `Покупок в долг: ${debts.length}`),
      nearest && debtDueText(nearest, today).text,
      other && KIND_NOTES[other.kind],
    ].filter(Boolean);
    const item = { key: entry.key, label: entry.label, amount: entry.amount, display: formatMoney(entry.amount, 'KGS'), sub: subs.join(' · ') };
    if (debts.length === 0 && other) {
      item.href = other.kind === 'own_money' ? `#/person?id=${other.account.id}` : `#/lender?id=${other.creditor_key}`;
    } else {
      item.children = [
        ...debts.map((row) => debtRow(row.tx, refs, today)),
        ...entry.rows.filter((row) => row.kind !== 'debt').map((row) => el('li', {}, el('a', {
          class: 'row row-button', href: row.kind === 'own_money' ? `#/person?id=${row.account.id}` : `#/lender?id=${row.creditor_key}`,
        }, el('p', { class: 'row-title' }, KIND_NOTES[row.kind]), el('p', { class: 'row-amount' }, formatMoney(row.amount, 'KGS'))))),
      ];
    }
    return item;
  });
}

function objectItems(overview, refs, today) {
  const byObject = new Map();
  for (const row of overview.we_owe) {
    const key = row.object_id ?? 'none';
    const entry = byObject.get(key) ?? {
      key, label: refs.objects.get(row.object_id)?.name ?? 'Без объекта: займы и свои деньги', amount: 0, rows: [],
    };
    entry.amount += row.amount;
    entry.rows.push(row);
    byObject.set(key, entry);
  }
  return [...byObject.values()].sort((a, b) => b.amount - a.amount).map((entry) => ({
    key: entry.key,
    label: entry.label,
    amount: entry.amount,
    display: formatMoney(entry.amount, 'KGS'),
    sub: entry.key === 'none' ? null : `Долгов: ${entry.rows.length}`,
    children: entry.rows.map((row) => (row.kind === 'debt' ? debtRow(row.tx, refs, today) : el('li', {}, el('a', {
      class: 'row row-button', href: row.kind === 'own_money' ? `#/person?id=${row.account.id}` : `#/lender?id=${row.creditor_key}`,
    }, el('div', { class: 'row-main' }, el('p', { class: 'row-title' }, row.creditor), el('p', { class: 'row-sub' }, KIND_NOTES[row.kind])),
    el('p', { class: 'row-amount' }, formatMoney(row.amount, 'KGS')))))),
  }));
}

function owedItems(overview) {
  const byDebtor = new Map();
  for (const row of overview.owed_to_us) {
    const entry = byDebtor.get(row.debtor_key) ?? { key: row.debtor_key, label: row.debtor, amount: 0, rows: [] };
    entry.amount += row.amount;
    entry.rows.push(row);
    byDebtor.set(row.debtor_key, entry);
  }
  return [...byDebtor.values()].sort((a, b) => b.amount - a.amount).map((entry) => {
    const currencies = new Set(entry.rows.map((row) => row.currency));
    const display = currencies.size === 1
      ? formatMoney(entry.rows.reduce((sum, row) => sum + row.owed, 0), entry.rows[0].currency)
      : formatMoney(entry.amount, 'KGS');
    const item = {
      key: entry.key, label: entry.label, amount: entry.amount, display, sub: `За ${entry.rows.map((row) => row.asset.name).join(', ')}`,
    };
    if (entry.rows.length === 1) item.href = `#/barter-asset?id=${entry.rows[0].asset.id}`;
    else {
      item.children = entry.rows.map((row) => el('li', {}, el('a', { class: 'row row-button', href: `#/barter-asset?id=${row.asset.id}` },
        el('p', { class: 'row-title' }, row.asset.name), el('p', { class: 'row-amount' }, formatMoney(row.owed, row.currency)))));
    }
    return item;
  });
}

async function debtsView(state) {
  const today = todayIso();
  const [overview, accounts, objects, categories, counterparties] = await Promise.all([
    debtsOverview(), db.accounts.toArray(), db.objects.toArray(), db.categories.toArray(), db.counterparties.toArray(),
  ]);
  const byId = (rows) => new Map(rows.map((row) => [row.id, row]));
  const refs = { accounts: byId(accounts), objects: byId(objects), categories: byId(categories), counterparties: byId(counterparties) };
  const owedNote = overview.owed_to_us_total > 0 ? `Нам должны ${formatMoney(overview.owed_to_us_total, 'KGS')}` : null;
  let card;
  if (state.split === 'owed') {
    const items = owedItems(overview);
    card = chartCard('Нам должны', formatMoney(overview.owed_to_us_total, 'KGS'), 'Подрядчики, которым машина ушла дороже их работ',
      items.length > 0 ? barList(items, { tone: 'owed' }) : emptyNote('Долгов перед компанией нет'));
  } else {
    const items = state.split === 'objects' ? objectItems(overview, refs, today) : creditorItems(overview, refs, today);
    card = chartCard(state.split === 'objects' ? 'Долги по объектам' : 'Кому должны', formatMoney(overview.we_owe_total, 'KGS'), null,
      items.length > 0 ? barList(items, { tone: 'owe' }) : emptyNote('Долгов нет'));
  }
  return {
    hero: hero('Мы должны', formatMoney(overview.we_owe_total, 'KGS'), owedNote, 'chart-debt-total'),
    card,
  };
}

export function renderAnalytics({ view, params, isCurrent }) {
  const state = {
    view: params?.get('view') === 'debts' ? 'debts' : 'money',
    split: params?.get('split') ?? null,
    month: params?.get('month') || monthOf(todayIso()),
    group: params?.get('group') || null,
  };

  function remember() {
    const query = new URLSearchParams({ view: state.view });
    if (state.split) query.set('split', state.split);
    query.set('month', state.month);
    if (state.group) query.set('group', state.group);
    replaceParams('/analytics', query);
  }

  function update(changes) {
    Object.assign(state, changes);
    remember();
    show();
  }

  async function chooseMonth() {
    const months = await reportMonths();
    const picked = await openPicker({
      title: 'Период',
      items: [{ id: 'all', label: 'За всё время' }, ...months.map((id) => ({ id, label: monthTitle(id) }))],
      selectedId: state.month,
    });
    if (picked) update({ month: picked });
  }

  async function show() {
    const split = state.split ?? (state.view === 'debts' ? 'creditors' : 'accounts');
    const top = segments([['money', 'Деньги'], ['debts', 'Долги']], state.view, (key) => update({ view: key, split: null, group: null }), 'view');
    let body;
    if (state.view === 'debts') {
      const { hero: head, card } = await debtsView({ ...state, split });
      body = [head, segments(DEBT_SPLITS, split, (key) => update({ split: key }), 'split'), card];
    } else {
      const accounts = await accountsChart();
      const head = hero('Деньги сейчас', formatMoney(accounts.total, 'KGS'),
        accounts.rate ? 'Касса, счета и деньги у людей' : null, 'chart-money-total');
      const card = split === 'accounts'
        ? accounts.card
        : await costsChart({ ...state, split }, chooseMonth, (group) => update({ group }));
      body = [head, segments(MONEY_SPLITS, split, (key) => update({ split: key, group: null }), 'split'), card];
    }
    if (!isCurrent()) return;
    const scrollTop = view.scrollTop;
    view.replaceChildren(formHead('Деньги и долги', { href: '#/' }), top, ...body);
    view.scrollTop = scrollTop;
  }

  show();
}
