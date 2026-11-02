// Recurring payments create reminders only; an expense appears after actual
// payment through ledger.createExpense (SPEC §7).
import { db, insertRow, updateRow } from './db.js';
import { LedgerError, shortName } from './ledger.js';
import { addDays, daysBetween, monthOf } from './money.js';

export const DUE_SOON_DAYS = 7;

function nextMonth(month) {
  const [year, number] = month.split('-').map(Number);
  return number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, '0')}`;
}

// Days 29-31 move to the last day of a short month.
export function dueDateIn(month, dayOfMonth) {
  const [year, number] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return `${month}-${String(Math.min(dayOfMonth, lastDay)).padStart(2, '0')}`;
}

function isInTemplateRange(template, dueDate) {
  if (template.start_date && monthOf(dueDate) < monthOf(template.start_date)) return false;
  if (template.end_date && dueDate > template.end_date) return false;
  return true;
}

export async function ensureInstancesForMonth(template, month) {
  const dueDate = dueDateIn(month, template.day_of_month);
  if (!isInTemplateRange(template, dueDate)) return null;
  const existing = await db.recurring_instances.get({ template_id: template.id, due_date: dueDate });
  if (existing) return existing;
  return insertRow('recurring_instances', {
    template_id: template.id, due_date: dueDate, status: 'pending', transaction_id: null, skip_reason: null,
  });
}

// Runs at every start: instances for the current and the next month (SPEC §7).
export async function generateInstances(today) {
  const months = [monthOf(today), nextMonth(monthOf(today))];
  await db.transaction('rw', db.recurring_templates, db.recurring_instances, db.audit_log, async () => {
    const templates = (await db.recurring_templates.toArray()).filter((template) => template.is_active);
    for (const template of templates) {
      for (const month of months) await ensureInstancesForMonth(template, month);
    }
  });
}

export async function createTemplate(fields) {
  return db.transaction('rw', db.recurring_templates, db.audit_log, () => insertRow('recurring_templates', {
    is_active: true, end_date: null, ...fields,
  }));
}

// A calendar file: phones remind about it without internet or this app (SPEC §7).
export function buildIcs(template) {
  const pad = (value) => String(value).padStart(2, '0');
  const start = template.start_date.replace(/-/g, '').slice(0, 6) + pad(template.day_of_month);
  const text = template.name.replace(/([,;\\])/g, '\\$1');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Stroy Cash//RU',
    'BEGIN:VEVENT',
    `UID:${template.id}@stroy-cash`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]|\.\d{3}/g, '')}`,
    `DTSTART;VALUE=DATE:${start}`,
    `RRULE:FREQ=MONTHLY;BYMONTHDAY=${template.day_of_month}`,
    `SUMMARY:Оплатить: ${text}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:Оплатить: ${text}`,
    'TRIGGER:-P1D',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

export async function updateTemplate(id, fields) {
  return db.transaction('rw', db.recurring_templates, db.audit_log, () => updateRow('recurring_templates', id, fields));
}

export async function skipInstance(id, reason) {
  if (!reason?.trim()) throw new LedgerError('invalid', [{ field: 'reason', code: 'required', message: 'Укажите причину' }]);
  return db.transaction('rw', db.recurring_instances, db.audit_log, () => updateRow('recurring_instances', id, {
    status: 'skipped', skip_reason: reason.trim(),
  }, 'skip'));
}

// Pending reminders and planned expenses due up to a week ahead, overdue first,
// with the total in soms.
export async function dueSoon(today) {
  const horizon = addDays(today, DUE_SOON_DAYS);
  const pending = await db.recurring_instances.where('status').equals('pending').toArray();
  const due = pending.filter((instance) => instance.due_date <= horizon);
  const templates = await db.recurring_templates.bulkGet(due.map((instance) => instance.template_id));
  const recurring = due.map((instance, index) => ({
    name: templates[index].name,
    due_date: instance.due_date,
    amount_kgs: templates[index].amount,
    instance,
    template: templates[index],
  }));

  const plans = await db.transactions.where('status').equals('planned').toArray();
  const duePlans = plans.filter((tx) => tx.plan_kind !== 'debt' && tx.date <= horizon);
  const categories = await db.categories.bulkGet(duePlans.map((tx) => tx.category_id));
  const planned = duePlans.map((tx, index) => ({
    name: tx.description || shortName(categories[index].name), due_date: tx.date, amount_kgs: tx.amount_kgs, planned: tx,
  }));

  const items = [...recurring, ...planned].map((item) => ({
    ...item,
    overdue: item.due_date < today,
    days_left: daysBetween(today, item.due_date),
  }));
  items.sort((a, b) => a.due_date.localeCompare(b.due_date));
  return { items, total: items.reduce((sum, item) => sum + item.amount_kgs, 0) };
}
