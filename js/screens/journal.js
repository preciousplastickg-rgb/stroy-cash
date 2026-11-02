// Journal: everything that happened, with filters, search and a total (SPEC §5.6).
import { db } from '../db.js';
import { replaceParams } from '../nav.js';
import { openDebts, shortName, sortAccounts } from '../ledger.js';
import { formatDate, formatDayMonth, formatMoney, monthOf, todayIso } from '../money.js';
import { monthTitle } from '../reports.js';
import { debtRow } from '../ui/debt-row.js';
import { el } from '../ui/dom.js';
import { operationRow } from '../ui/operation-row.js';
import { openPicker } from '../ui/picker.js';

const PAGE = 60;
const TYPE_LABELS = { expense: 'Расходы', income: 'Поступления', transfer: 'Переводы', planned: 'Планы и долги' };

function matchesSearch(tx, query, refs) {
  if (!query) return true;
  const text = `${tx.number ?? ''} ${tx.description} ${refs.categories.get(tx.category_id)?.name ?? ''} ${refs.counterparties.get(tx.counterparty_id)?.name ?? ''}`;
  return text.toLowerCase().includes(query);
}

function plannedRow(tx, refs) {
  const name = tx.description || shortName(refs.categories.get(tx.category_id)?.name ?? '');
  return el('li', {}, el('a', { class: 'row row-button', href: `#/expense/new?planned=${tx.id}`, 'data-plan': name },
    el('div', { class: 'row-main' },
      el('p', { class: 'row-title' }, name),
      el('p', { class: 'row-sub one-line' }, `План на ${formatDate(tx.date)}, ${refs.objects.get(tx.object_id)?.name ?? ''}`)),
    el('p', { class: 'row-amount' }, formatMoney(-tx.amount, 'KGS'))));
}

export function renderJournal({ view, params, isCurrent }) {
  const filters = {
    month: params?.get('month') ?? monthOf(todayIso()),
    account_id: params?.get('account') ?? null,
    object_id: params?.get('object') ?? null,
    category_id: params?.get('category') ?? null,
    counterparty_id: params?.get('counterparty') ?? null,
    type: params?.get('type') ?? null,
    no_document: params?.get('nodoc') === '1',
    query: (params?.get('q') ?? '').trim().toLowerCase(),
  };
  const today = todayIso();
  let shown = PAGE;
  let data = null;

  const list = el('div', { class: 'journal-list' });
  const chips = el('div', { class: 'filter-chips' });
  const totals = el('div', { class: 'journal-total', 'data-testid': 'journal-total' });
  const search = el('input', {
    class: 'input',
    id: 'journal-search',
    type: 'search',
    placeholder: 'Поиск по описанию или номеру',
    autocomplete: 'off',
    'aria-label': 'Поиск',
    value: params?.get('q') ?? '',
    onInput: () => {
      filters.query = search.value.trim().toLowerCase();
      shown = PAGE;
      render();
    },
  });

  // Filters live in the address: back from an operation shows the same list.
  function rememberFilters() {
    const query = new URLSearchParams();
    query.set('month', filters.month ?? '');
    for (const [key, value] of [['type', filters.type], ['account', filters.account_id], ['object', filters.object_id],
      ['category', filters.category_id], ['counterparty', filters.counterparty_id], ['q', search.value.trim()]]) {
      if (value) query.set(key, value);
    }
    if (filters.no_document) query.set('nodoc', '1');
    replaceParams('/journal', query);
  }

  function selected() {
    const posted = data.operations.filter((tx) => {
      if (filters.month && monthOf(tx.date) !== filters.month) return false;
      if (filters.account_id && tx.account_id !== filters.account_id && tx.to_account_id !== filters.account_id) return false;
      if (filters.object_id && tx.object_id !== filters.object_id) return false;
      if (filters.category_id && tx.category_id !== filters.category_id) return false;
      if (filters.counterparty_id && tx.counterparty_id !== filters.counterparty_id) return false;
      if (filters.type && filters.type !== tx.type) return false;
      if (filters.no_document && tx.doc_type !== 'none') return false;
      return matchesSearch(tx, filters.query, data.refs);
    });
    return posted;
  }

  function filterChip({ key, label, active, onClick }) {
    return el('button', {
      class: `chip filter-chip${active ? ' selected' : ''}`, type: 'button', 'data-filter': key, onClick,
    }, label);
  }

  async function choose(key, title, items) {
    const picked = await openPicker({
      title,
      items: [{ id: 'all', label: 'Все' }, ...items],
      selectedId: filters[key] ?? 'all',
      autofocus: items.length > 12,
    });
    if (!picked) return;
    filters[key] = picked === 'all' ? null : picked;
    shown = PAGE;
    render();
  }

  function nameOf(map, id) {
    const row = map.get(id);
    return row ? shortName(row.name) : null;
  }

  function renderChips() {
    const { refs, months } = data;
    chips.replaceChildren(
      filterChip({
        key: 'month',
        label: filters.month ? monthTitle(filters.month) : 'Весь период',
        active: Boolean(filters.month),
        onClick: () => choose('month', 'Период', months.map((month) => ({ id: month, label: monthTitle(month) }))),
      }),
      filterChip({
        key: 'type',
        label: TYPE_LABELS[filters.type] ?? 'Тип',
        active: Boolean(filters.type),
        onClick: () => choose('type', 'Тип', Object.entries(TYPE_LABELS).map(([id, label]) => ({ id, label }))),
      }),
      filterChip({
        key: 'account',
        label: nameOf(refs.accounts, filters.account_id) ?? 'Счёт',
        active: Boolean(filters.account_id),
        onClick: () => choose('account_id', 'Счёт', data.accountItems),
      }),
      filterChip({
        key: 'object',
        label: nameOf(refs.objects, filters.object_id)?.split(',')[0] ?? 'Объект',
        active: Boolean(filters.object_id),
        onClick: () => choose('object_id', 'Объект', data.objectItems),
      }),
      filterChip({
        key: 'category',
        label: nameOf(refs.categories, filters.category_id) ?? 'Статья',
        active: Boolean(filters.category_id),
        onClick: () => choose('category_id', 'Статья', data.categoryItems),
      }),
      filterChip({
        key: 'counterparty',
        label: nameOf(refs.counterparties, filters.counterparty_id) ?? 'Контрагент',
        active: Boolean(filters.counterparty_id),
        onClick: () => choose('counterparty_id', 'Контрагент', data.counterpartyItems),
      }),
      filterChip({
        key: 'no_document',
        label: 'Без документа',
        active: filters.no_document,
        onClick: () => {
          filters.no_document = !filters.no_document;
          render();
        },
      }),
    );
  }

  function plannedSection() {
    const showAll = !filters.type || filters.type === 'planned';
    if (!showAll || filters.no_document) return null;
    const rows = data.planned.filter((tx) => (!filters.account_id || tx.account_id === filters.account_id)
      && (!filters.object_id || tx.object_id === filters.object_id)
      && (!filters.category_id || tx.category_id === filters.category_id)
      && (!filters.counterparty_id || tx.counterparty_id === filters.counterparty_id)
      && matchesSearch(tx, filters.query, data.refs));
    if (rows.length === 0) return null;
    return el('section', { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', {}, 'Планы и долги')),
      el('ul', { class: 'rows' }, rows.map((tx) => (tx.plan_kind === 'debt' ? debtRow(tx, data.refs, today) : plannedRow(tx, data.refs)))));
  }

  function render() {
    if (!data) return; // typing before the load: the first render picks up the query
    rememberFilters();
    renderChips();
    const rows = filters.type === 'planned' ? [] : selected();
    const planned = plannedSection();
    const days = [];
    for (const tx of rows.slice(0, shown)) {
      if (days.at(-1)?.date !== tx.date) days.push({ date: tx.date, rows: [] });
      days.at(-1).rows.push(tx);
    }
    const year = todayIso().slice(0, 4);
    const operations = days.map((day) => {
      const spent = day.rows.filter((tx) => tx.type === 'expense' && tx.status === 'posted').reduce((sum, tx) => sum + tx.amount_kgs, 0);
      return el('section', { class: 'card', 'data-day': day.date },
        el('div', { class: 'card-head' },
          el('h2', {}, day.date.startsWith(year) ? formatDayMonth(day.date) : formatDate(day.date)),
          spent > 0 && el('p', { class: 'card-sum muted' }, formatMoney(-spent, 'KGS'))),
        el('ul', { class: 'rows' }, day.rows.map((tx) => operationRow(tx, data.refs, { showDate: false }))));
    });
    const more = rows.length > shown && el('button', {
      class: 'button journal-more',
      type: 'button',
      onClick: () => {
        shown += PAGE;
        render();
      },
    }, `Показать ещё, осталось ${rows.length - shown}`);
    const empty = !planned && rows.length === 0 && el('p', { class: 'stub-note' }, 'Ничего не найдено');
    list.replaceChildren(...[planned, ...operations, more, empty].filter(Boolean));

    const posted = rows.filter((tx) => tx.status === 'posted');
    const sum = (type) => posted.filter((tx) => tx.type === type).reduce((total, tx) => total + tx.amount_kgs, 0);
    totals.replaceChildren(
      el('span', {}, `Операций: ${rows.length}`),
      el('span', {}, `Расход ${formatMoney(sum('expense'), 'KGS')}`),
      el('span', {}, `Приход ${formatMoney(sum('income'), 'KGS')}`),
    );
  }

  view.replaceChildren(
    el('header', { class: 'page-head' }, el('h1', {}, 'Журнал')),
    search,
    chips,
    list,
    totals,
  );

  async function load() {
    const [operations, planned, accounts, objects, categories, counterparties, debts] = await Promise.all([
      db.transactions.orderBy('number').reverse().toArray(),
      db.transactions.where('status').equals('planned').toArray(),
      db.accounts.toArray(), db.objects.toArray(), db.categories.toArray(), db.counterparties.toArray(), openDebts(),
    ]);
    if (!isCurrent()) return;
    const byId = (rows) => new Map(rows.map((row) => [row.id, row]));
    const months = [...new Set(operations.map((tx) => monthOf(tx.date)))].sort().reverse();
    const toItems = (rows) => rows.map((row) => ({ id: row.id, label: shortName(row.name) })).sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    data = {
      operations,
      planned: [...debts, ...planned.filter((tx) => tx.plan_kind !== 'debt').sort((a, b) => a.date.localeCompare(b.date))],
      months,
      refs: { accounts: byId(accounts), objects: byId(objects), categories: byId(categories), counterparties: byId(counterparties) },
      accountItems: sortAccounts(accounts).map((row) => ({ id: row.id, label: row.name })),
      objectItems: toItems(objects),
      categoryItems: toItems(categories.filter((row) => row.parent_id)),
      counterpartyItems: toItems(counterparties),
    };
    render();
  }

  load();
}
