// Recurring payments: this and next month's reminders and the templates (SPEC §7).
import { db } from '../db.js';
import { accountName, sortAccounts, shortName } from '../ledger.js';
import {
  addDays, daysBetween, formatDate, formatDayMonth, formatMoney, monthOf, todayIso,
} from '../money.js';
import {
  buildIcs, createTemplate, generateInstances, skipInstance, updateTemplate,
} from '../recurring.js';
import { monthTitle } from '../reports.js';
import { el } from '../ui/dom.js';
import { askReason, editSheet } from '../ui/edit-sheet.js';
import { formHead } from '../ui/form.js';
import { openSheet } from '../ui/sheet.js';
import { deliverFile } from '../ui/share.js';

const STATUS_TEXT = { paid: 'Оплачено', skipped: 'Пропущено' };

const WEEK = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

// Month grid: a coloured day has a payment, red means overdue.
function monthCalendar(month, instances, today) {
  const [year, number] = month.split('-').map(Number);
  const days = new Date(Date.UTC(year, number, 0)).getUTCDate();
  const offset = (new Date(Date.UTC(year, number - 1, 1)).getUTCDay() + 6) % 7;
  const cells = Array.from({ length: offset }, () => el('span', {}));
  for (let day = 1; day <= days; day += 1) {
    const date = `${month}-${String(day).padStart(2, '0')}`;
    const due = instances.filter((row) => row.due_date === date);
    const late = due.some((row) => row.status === 'pending' && date < today);
    const open = due.some((row) => row.status === 'pending');
    const state = late ? ' late' : open ? ' due' : due.length > 0 ? ' settled' : '';
    cells.push(el('span', { class: `calendar-day${state}${date === today ? ' today' : ''}`, 'data-day': date }, String(day)));
  }
  return el('div', { class: 'calendar' }, WEEK.map((name) => el('span', { class: 'calendar-head' }, name)), cells);
}

const DUE_SOON_DAYS = 7;

// Templates in the order the month goes.
function byDay(templates) {
  return [...templates].sort((a, b) => a.day_of_month - b.day_of_month || a.name.localeCompare(b.name, 'ru'));
}

function plural(count, [one, few, many]) {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

// "Просрочено на 3 дн., 31.10.2026", the way the home screen says it.
function dueText(date, today) {
  const days = daysBetween(today, date);
  if (days < 0) return `Просрочено на ${-days} дн., ${formatDate(date)}`;
  if (days === 0) return `Сегодня, ${formatDate(date)}`;
  if (days === 1) return `Завтра, ${formatDate(date)}`;
  return `Через ${days} дн., ${formatDate(date)}`;
}

// In the month list the date is enough for a payment that is simply ahead.
function monthNote(instance, today) {
  const date = formatDayMonth(instance.due_date);
  if (instance.status === 'pending') return instance.due_date < today ? `${date}, просрочено` : date;
  const status = STATUS_TEXT[instance.status].toLowerCase();
  return `${date}, ${status}${instance.skip_reason ? `: ${instance.skip_reason}` : ''}`;
}

export function renderRecurring({ view, isCurrent }) {
  const today = todayIso();
  const expanded = new Set();
  let refs = null;

  async function skip(instance, template) {
    const reason = await askReason({
      title: `Пропустить: ${template.name}`, message: 'Напоминание закроется без расхода.', confirmLabel: 'Пропустить',
    });
    if (!reason) return;
    await skipInstance(instance.id, reason);
    show();
  }

  // Due soon or overdue: the actions are on the row itself, on a line of their own so
  // the name and the date keep the whole width.
  function dueRow(instance, template, paid) {
    const overdue = instance.due_date < today;
    return el('li', { class: `row recurring-row${overdue ? ' overdue' : ''}`, 'data-instance': template.name },
      el('div', { class: 'row-main' },
        el('p', { class: 'row-title' }, template.name),
        el('p', { class: 'row-sub' }, dueText(instance.due_date, today))),
      el('p', { class: 'row-amount' }, formatMoney(paid?.amount ?? template.amount, 'KGS')),
      el('div', { class: 'row-buttons' },
        el('button', { class: 'mini-button', type: 'button', onClick: () => skip(instance, template) }, 'Пропустить'),
        el('a', { class: 'mini-button primary', href: `#/expense/new?instance=${instance.id}` }, 'Оплатить')));
  }

  // The month list: one line per payment. A paid one opens its operation, a pending
  // one offers the same two actions in a sheet.
  function monthRow(instance, template, paid) {
    const overdue = instance.status === 'pending' && instance.due_date < today;
    const done = instance.status !== 'pending';
    const content = [
      el('span', { class: 'row-main' },
        el('span', { class: 'row-title' }, template.name),
        el('span', { class: 'row-sub' }, monthNote(instance, today))),
      el('span', { class: `row-amount${done ? ' muted' : ''}` }, formatMoney(paid?.amount ?? template.amount, 'KGS')),
    ];
    const attrs = { class: `row row-button${overdue ? ' overdue' : ''}${done ? ' settled' : ''}`, 'data-instance': template.name };
    if (paid) return el('li', {}, el('a', { ...attrs, href: `#/tx?id=${paid.id}` }, ...content));
    if (done) return el('li', {}, el('div', { ...attrs, class: attrs.class.replace(' row-button', '') }, ...content));
    return el('li', {}, el('button', { ...attrs, type: 'button', onClick: () => actions(instance, template) }, ...content));
  }

  function actions(instance, template) {
    const sheet = openSheet({
      title: template.name,
      body: el('div', { class: 'edit-sheet' },
        el('p', { class: 'confirm-text' }, `${formatDate(instance.due_date)}, ${formatMoney(template.amount, 'KGS')}${template.amount_is_fixed ? '' : ', сумма примерная'}`),
        el('a', { class: 'button button-primary', href: `#/expense/new?instance=${instance.id}`, onClick: () => sheet.close() }, 'Оплатить'),
        el('button', {
          class: 'button',
          type: 'button',
          onClick: () => {
            sheet.close();
            skip(instance, template);
          },
        }, 'Пропустить')),
    });
  }

  function templateFields(template) {
    const select = (rows) => rows.map((row) => ({ value: row.id, label: shortName(row.name) }));
    return [
      { key: 'name', label: 'Название', type: 'text', value: template?.name },
      { key: 'amount', label: 'Сумма', type: 'amount', value: template?.amount },
      {
        key: 'fixed',
        label: 'Сумма',
        type: 'select',
        value: template?.amount_is_fixed === false ? 'approx' : 'fixed',
        options: [{ value: 'fixed', label: 'Фиксированная' }, { value: 'approx', label: 'Примерная' }],
      },
      { key: 'day_of_month', label: 'Число месяца', type: 'number', value: template?.day_of_month },
      { key: 'account_id', label: 'Счёт', type: 'pick', value: template?.account_id ?? refs.accounts[0]?.id, options: refs.accounts.map((row) => ({ value: row.id, label: accountName(row) })) },
      {
        key: 'category_id',
        label: 'Статья',
        type: 'pick',
        value: template?.category_id,
        options: refs.categories.map((row) => ({ value: row.id, label: shortName(row.name), group: refs.groups.get(row.parent_id) })),
      },
      { key: 'object_id', label: 'Объект', type: 'pick', value: template?.object_id ?? refs.overheadId, options: select(refs.objects) },
      {
        key: 'counterparty_id',
        label: 'Контрагент',
        type: 'counterparty',
        counterpartyType: 'service',
        createLabel: 'Новый контрагент',
        value: template?.counterparty_id,
        options: select(refs.counterparties),
        optional: true,
      },
      { key: 'start_date', label: 'С какого числа', type: 'date', value: template?.start_date ?? today },
      { key: 'end_date', label: 'До какого числа', type: 'date', value: template?.end_date, optional: true },
    ];
  }

  async function editTemplate(template) {
    const saved = await editSheet({
      title: template ? template.name : 'Новый шаблон',
      fields: templateFields(template),
      onSave: async ({ fixed, ...values }) => {
        const fields = { ...values, amount_is_fixed: fixed === 'fixed' };
        if (template) await updateTemplate(template.id, fields);
        else await createTemplate(fields);
        await generateInstances(today);
      },
      extraAction: template && {
        label: template.is_active ? 'Отключить шаблон' : 'Включить шаблон',
        run: async () => {
          await updateTemplate(template.id, { is_active: !template.is_active });
          return true;
        },
      },
      secondAction: template && {
        label: 'Добавить в календарь телефона',
        run: async () => {
          await deliverFile(new Blob([buildIcs(template)], { type: 'text/calendar' }), `${template.name}.ics`);
          return false;
        },
      },
    });
    if (saved) show();
  }

  async function show() {
    const [templates, instances, accounts, categories, objects, counterparties, payments] = await Promise.all([
      db.recurring_templates.toArray(), db.recurring_instances.toArray(), db.accounts.toArray(),
      db.categories.where('kind').equals('expense').toArray(), db.objects.toArray(), db.counterparties.toArray(),
      db.transactions.where('recurring_instance_id').above('').toArray(),
    ]);
    if (!isCurrent()) return;
    refs = {
      accounts: sortAccounts(accounts.filter((row) => row.type !== 'barter' && !row.is_archived)),
      categories: categories.filter((row) => row.parent_id && !row.is_archived).sort((a, b) => a.position - b.position),
      groups: new Map(categories.filter((row) => !row.parent_id).map((row) => [row.id, row.name])),
      objects: objects.filter((row) => row.status === 'active'),
      counterparties: counterparties.filter((row) => !row.is_archived),
      overheadId: objects.find((row) => row.is_overhead)?.id,
    };
    const byTemplate = new Map(templates.map((row) => [row.id, row]));
    const byInstance = new Map(payments.map((row) => [row.recurring_instance_id, row]));
    const months = [...new Set(instances.map((row) => monthOf(row.due_date)))].filter((month) => month >= monthOf(today)).sort();
    const soon = addDays(today, DUE_SOON_DAYS);
    const due = instances.filter((row) => row.status === 'pending' && row.due_date <= soon).sort((x, y) => x.due_date.localeCompare(y.due_date));
    const dueTotal = due.reduce((sum, row) => sum + byTemplate.get(row.template_id).amount, 0);
    const listOf = (rows, render) => el('ul', { class: 'rows' }, [...rows].sort((x, y) => x.due_date.localeCompare(y.due_date))
      .map((row) => render(row, byTemplate.get(row.template_id), byInstance.get(row.id))));

    const monthCard = (month) => {
      const rows = instances.filter((row) => monthOf(row.due_date) === month);
      if (rows.length === 0) return null;
      const pending = rows.filter((row) => row.status === 'pending').reduce((sum, row) => sum + byTemplate.get(row.template_id).amount, 0);
      const current = month === monthOf(today);
      const open = current || expanded.has(month);
      return el('section', { class: 'card', 'data-month': month },
        el('div', { class: 'card-head' },
          el('h2', {}, monthTitle(month)),
          el('p', { class: 'card-sum muted' }, pending > 0 ? `осталось ${formatMoney(pending, 'KGS')}` : 'всё закрыто')),
        open ? [monthCalendar(month, rows, today), listOf(rows, monthRow)] : el('button', {
          class: 'list-action',
          type: 'button',
          'data-action': 'expand-month',
          onClick: () => {
            expanded.add(month);
            show();
          },
        }, `Показать ${rows.length} ${plural(rows.length, ['платёж', 'платежа', 'платежей'])}`));
    };

    view.replaceChildren(...[
      formHead('Регулярные платежи', { href: '#/more' }),
      due.length > 0 && el('section', { class: 'card', 'data-section': 'due' },
        el('div', { class: 'card-head' },
          el('h2', {}, 'К оплате'),
          el('p', { class: 'card-sum' }, formatMoney(dueTotal, 'KGS'))),
        listOf(due, dueRow)),
      ...months.map(monthCard),
      el('section', { class: 'card' },
        el('div', { class: 'card-head' },
          el('h2', {}, 'Шаблоны'),
          el('button', { class: 'card-action', type: 'button', 'data-action': 'add-template', onClick: () => editTemplate(null) }, 'Добавить')),
        el('ul', { class: 'rows' }, byDay(templates).map((template) => el('li', {}, el('button', {
          class: 'row row-button', type: 'button', 'data-template': template.name, onClick: () => editTemplate(template),
        },
        el('span', { class: 'row-main' },
          el('span', { class: 'row-title' }, template.name),
          el('span', { class: 'row-sub' }, `${template.day_of_month}-го числа${template.amount_is_fixed ? '' : ', сумма примерная'}${template.is_active ? '' : ', отключён'}`)),
        el('span', { class: 'row-amount' }, formatMoney(template.amount, 'KGS'))))))),
    ].filter(Boolean));
  }

  show();
}
