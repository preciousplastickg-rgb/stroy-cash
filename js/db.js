// Dexie schema. Existing versions are never edited: a change means a new
// db.version(n) with upgrade(). Non-indexed fields are not listed here, the full
// record shapes are in docs/SPEC.md §4 and §8.
import Dexie from '../vendor/dexie.mjs';

export { Dexie };

export const SCHEMA_VERSION = 1;

export const db = new Dexie('stroy-cash');

db.version(1).stores({
  accounts: 'id, type, currency',
  objects: 'id, status, customer_id',
  categories: 'id, kind, parent_id, code',
  counterparties: 'id, type, name',
  transactions:
    'id, &number, date, account_id, to_account_id, object_id, category_id, counterparty_id, ' +
    'status, reversal_of_id, recurring_instance_id, barter_asset_id, parent_transaction_id, [type+date]',
  attachments: 'id, transaction_id, barter_asset_id',
  recurring_templates: 'id',
  recurring_instances: 'id, template_id, due_date, status, transaction_id, &[template_id+due_date]',
  periods: 'id, &month, status',
  audit_log: 'id, [table_name+row_id], at',
  settings: 'id',
  barter_assets: 'id, status, buyer_id, object_id, transferred_to_id',
});

export function newId() {
  return crypto.randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}

async function writeAudit(tableName, rowId, action, before, after) {
  const at = nowIso();
  await db.audit_log.add({
    id: newId(),
    table_name: tableName,
    row_id: rowId,
    action,
    before: before ?? null,
    after: after ?? null,
    at,
    created_at: at,
    updated_at: at,
  });
}

// Both helpers must be called inside a db.transaction('rw', ...) that includes
// audit_log, so the change and its log entry commit together.
export async function insertRow(tableName, fields) {
  const at = nowIso();
  const row = { id: newId(), ...fields, created_at: at, updated_at: at };
  await db.table(tableName).add(row);
  const { blob, ...logged } = row;
  await writeAudit(tableName, row.id, 'create', null, logged);
  return row;
}

export async function updateRow(tableName, id, changes, action = 'update') {
  const table = db.table(tableName);
  const before = await table.get(id);
  const after = { ...before, ...changes, updated_at: nowIso() };
  await table.put(after);
  await writeAudit(tableName, id, action, before, after);
  return after;
}

export async function getSettings() {
  return db.settings.toCollection().first();
}

const DEFAULT_CATEGORIES = [
  {
    group: 'Материалы',
    kind: 'expense',
    items: ['Бетон и раствор', 'Арматура и металл', 'Кирпич и блоки', 'Инертные (песок, щебень, ПГС)', 'Отделочные',
      'Электрика', 'Сантехника', 'Крепёж и расходники', 'Инструмент', 'Прочие материалы'],
  },
  {
    group: 'Услуги подрядчиков',
    kind: 'expense',
    items: ['Строительно-монтажные работы', 'Спецтехника (экскаватор, кран, бетононасос)', 'Проектирование и экспертиза'],
  },
  {
    group: 'Прочие услуги',
    kind: 'expense',
    items: ['Доставка и грузоперевозки (портер, грузовое такси)', 'Такси и поездки', 'Погрузка и разгрузка (грузчики)',
      'Вывоз мусора', 'Ремонт техники и инструмента', 'Прочие услуги'],
  },
  { group: 'Персонал', kind: 'expense', items: ['Зарплата штата', 'Оплата рабочим (подённо)'] },
  {
    group: 'Постоянные',
    kind: 'expense',
    items: ['Аренда офиса', 'Интернет и связь', 'Уборка', 'Коммунальные', ['Банковские комиссии', 'bank_fee']],
  },
  {
    group: 'Прочие расходы',
    kind: 'expense',
    items: ['Топливо', 'Налоги и взносы', 'Хозяйственные', ['Курсовая разница', 'fx_difference'],
      ['Разница по бартеру', 'barter_difference'], ['Расхождение кассы', 'cash_discrepancy'], 'Прочее'],
  },
  {
    group: 'Поступления',
    kind: 'income',
    items: [['Оплата заказчика', 'customer_payment'], 'Оплата за квартиры',
      ['Оплата за квартиры бартером', 'apartment_barter'], 'Средства от учредителя или директора',
      'Возврат от поставщика', ['Доход по бартеру', 'barter_income'], 'Прочие поступления'],
  },
];

// Records the app cannot work without: settings, the overhead object, default
// categories and the service barter accounts (SPEC §4, §8). Idempotent.
export async function ensureDefaults() {
  await db.transaction('rw', db.settings, db.objects, db.categories, db.accounts, db.audit_log, async () => {
    if (!(await getSettings())) {
      await insertRow('settings', {
        company_name: 'Строительная компания',
        started: false,
        is_demo: false,
        pin_hash: null,
        pin_salt: null,
        last_usd_rate: null,
        last_backup_at: null,
        last_full_backup_month: null,
      });
    }
    if (!(await db.objects.toArray()).some((object) => object.is_overhead)) {
      await insertRow('objects', {
        name: 'Офис / общие', address: '', customer_id: null, status: 'active', is_overhead: true,
      });
    }
    if ((await db.categories.count()) === 0) {
      // Ids are random, so position keeps the order of the list above.
      let position = 0;
      for (const { group, kind, items } of DEFAULT_CATEGORIES) {
        position += 1;
        const parent = await insertRow('categories', { name: group, kind, parent_id: null, code: null, position });
        for (const item of items) {
          const [name, code] = Array.isArray(item) ? item : [item, null];
          position += 1;
          await insertRow('categories', { name, kind, parent_id: parent.id, code, position });
        }
      }
    }
    // Added after the first release, so it also has to appear in existing data.
    if (!(await db.categories.where('code').equals('loan_repayment').first())) {
      const position = Math.max(...(await db.categories.toArray()).map((row) => row.position));
      const parent = await insertRow('categories', { name: 'Возврат займов', kind: 'expense', parent_id: null, code: null, position: position + 1 });
      await insertRow('categories', { name: 'Возврат займов', kind: 'expense', parent_id: parent.id, code: 'loan_repayment', position: position + 2 });
    }
    const accounts = await db.accounts.toArray();
    for (const currency of ['USD', 'KGS']) {
      if (!accounts.some((account) => account.type === 'barter' && account.currency === currency)) {
        await insertRow('accounts', {
          name: `Бартер ${currency}`, type: 'barter', currency, opening_balance: 0, opening_date: null, is_archived: false,
        });
      }
    }
  });
}

// Wipes the whole ledger at once: demo reset (STAGE1 §4) and «Удалить все данные»
// after a backup file (SPEC §10). Single operations are never deleted anywhere.
export async function clearAllData() {
  await db.transaction('rw', db.tables, async () => {
    await Promise.all(db.tables.map((table) => table.clear()));
  });
}
