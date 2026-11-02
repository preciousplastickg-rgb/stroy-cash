// Recurring payments: this and next month's reminders and the templates (SPEC §7).
import { db } from '../db.js';
import { sortAccounts, shortName } from '../ledger.js';
import { formatDate, formatMoney, monthOf, todayIso } from '../money.js';
import {
  buildIcs, createTemplate, generateInstances, skipInstance, updateTemplate,
} from '../recurring.js';
import { monthTitle } from '../reports.js';
import { el } from '../ui/dom.js';
import { askReason, editSheet } from '../ui/edit-sheet.js';
import { formHead } from '../ui/form.js';
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

function statusText(instance, today) {
  if (instance.status !== 'pending') {
    return instance.skip_reason ? `${STATUS_TEXT[instance.status]}: ${instance.skip_reason}` : STATUS_TEXT[instance.status];
  }
  return instance.due_date < today ? 'Просрочено' : 'К оплате';
}

export function renderRecurring({ view, isCurrent }) {
  const today = todayIso();
  let refs = null;

  async function skip(instance, template) {
    const reason = await askReason({
      title: `Пропустить: ${template.name}`, message: 'Напоминание закроется без расхода.', confirmLabel: 'Пропустить',
    });
    if (!reason) return;
    await skipInstance(instance.id, reason);
    show();
  }

  function instanceRow(instance, template, paid) {
    const overdue = instance.status === 'pending' && instance.due_date < today;
    return el('li', { class: `row recurring-row${overdue ? ' overdue' : ''}`, 'data-instance': template.name },
      el('div', { class: 'row-main' },
        el('p', { class: 'row-title' }, template.name),
        el('p', { class: 'row-sub' }, `${formatDate(instance.due_date)}, ${statusText(instance, today)}`),
        instance.status === 'pending' && el('div', { class: 'row-buttons' },
          el('a', { class: 'mini-button primary', href: `#/expense/new?instance=${instance.id}` }, 'Оплатить'),
          el('button', { class: 'mini-button', type: 'button', onClick: () => skip(instance, template) }, 'Пропустить'))),
      el('p', { class: 'row-amount' }, formatMoney(paid?.amount ?? template.amount, 'KGS')));
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
      { key: 'account_id', label: 'Счёт', type: 'select', value: template?.account_id, options: select(refs.accounts) },
      { key: 'category_id', label: 'Статья', type: 'select', value: template?.category_id, options: select(refs.categories) },
      { key: 'object_id', label: 'Объект', type: 'select', value: template?.object_id ?? refs.overheadId, options: select(refs.objects) },
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
      objects: objects.filter((row) => row.status === 'active'),
      counterparties: counterparties.filter((row) => !row.is_archived),
      overheadId: objects.find((row) => row.is_overhead)?.id,
    };
    const byTemplate = new Map(templates.map((row) => [row.id, row]));
    const byInstance = new Map(payments.map((row) => [row.recurring_instance_id, row]));
    const months = [...new Set(instances.map((row) => monthOf(row.due_date)))].filter((month) => month >= monthOf(today)).sort();
    const overdue = instances.filter((row) => row.status === 'pending' && monthOf(row.due_date) < monthOf(today));
    const section = (title, rows, calendar = null) => rows.length > 0 && el('section', { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', {}, title)),
      calendar,
      el('ul', { class: 'rows' }, rows.sort((a, b) => a.due_date.localeCompare(b.due_date))
        .map((row) => instanceRow(row, byTemplate.get(row.template_id), byInstance.get(row.id)))));

    view.replaceChildren(...[
      formHead('Регулярные платежи', { href: '#/more' }),
      section('Просрочено', overdue),
      ...months.map((month) => {
        const rows = instances.filter((row) => monthOf(row.due_date) === month);
        return section(monthTitle(month), rows, monthCalendar(month, rows, today));
      }),
      el('section', { class: 'card' },
        el('div', { class: 'card-head' },
          el('h2', {}, 'Шаблоны'),
          el('button', { class: 'card-action', type: 'button', 'data-action': 'add-template', onClick: () => editTemplate(null) }, 'Добавить')),
        el('ul', { class: 'rows' }, templates.map((template) => el('li', {}, el('button', {
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
