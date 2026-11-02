// Demo data from docs/STAGE1.md. All names are fictional. Everything goes through
// ledger.js with the normal checks, so the seed cannot produce what the app forbids.
import { receiveAsset, reimburseDifference, transferToContractor } from './barter.js';
import { clearAllData, db, ensureDefaults, getSettings, insertRow, updateRow } from './db.js';
import {
  balanceFromTransactions, createCounterparty, createDebt, createExpense, createIncome, createTransfer, ledgerTransaction,
  reverseTransaction, setLastUsdRate,
} from './ledger.js';
import { createTemplate, ensureInstancesForMonth } from './recurring.js';

const RATE_AUTUMN = 874500; // 87,45
const RATE_NOVEMBER = 875000; // 87,50
const OPENING_DATE = '2026-09-01';

export const DEMO_ACCOUNTS = [
  { key: 'cash', name: 'Касса', type: 'cash', currency: 'KGS', opening: 850000 },
  { key: 'usd', name: 'Касса USD', type: 'cash', currency: 'USD', opening: 12000 },
  { key: 'bank', name: 'Р/с Бакай Банк', type: 'bank', currency: 'KGS', opening: 4200000 },
  { key: 'card', name: 'Карта Mbank', type: 'card', currency: 'KGS', opening: 150000 },
  { key: 'imprest', name: 'Подотчёт: Жумабеков (прораб)', type: 'imprest', currency: 'KGS', opening: 0 },
];

const DEMO_OBJECTS = [
  { key: 'ala', name: 'ЖК Ала-Тоо, блок А', address: 'Бишкек, ул. Ала-Тоо', customer: null },
  { key: 'dom', name: 'Частный дом, Кок-Жар', address: 'Бишкек, ж/м Кок-Жар', customer: 'nur' },
];

const DEMO_COUNTERPARTIES = [
  { key: 'beton', name: 'ОсОО «БетонСтрой»', type: 'supplier', note: 'Поставщик бетона' },
  { key: 'mamatov', name: 'ИП Маматов', type: 'supplier', note: 'Арматура' },
  { key: 'brigada', name: 'Бригада Калыбекова', type: 'contractor', note: 'Подрядчик СМР' },
  { key: 'tehnika', name: 'Ак-Жол Техника', type: 'service', note: 'Спецтехника' },
  { key: 'nurlan', name: 'Нурлан, портер', type: 'service', note: 'Доставка' },
  { key: 'sadykova', name: 'ИП Садыкова', type: 'service', note: 'Уборка' },
  { key: 'ofis', name: 'ОсОО «Офис-Центр»', type: 'service', note: 'Аренда' },
  { key: 'toktogulov', name: 'Токтогулов Б.', type: 'buyer', note: 'кв. 12' },
  { key: 'asanova', name: 'Асанова Г.', type: 'buyer', note: 'кв. 45' },
  { key: 'nur', name: 'ОсОО «Нур-Строй Инвест»', type: 'customer', note: 'Заказчик частного дома' },
];

const TEMPLATES = [
  { key: 'rent', name: 'Аренда офиса', amount: 60000, fixed: true, day: 5, account: 'bank', category: 'Аренда офиса', counterparty: 'ofis' },
  { key: 'internet', name: 'Интернет', amount: 2500, fixed: true, day: 10, account: 'card', category: 'Интернет и связь', counterparty: null },
  { key: 'utilities', name: 'Коммунальные', amount: 8000, fixed: false, day: 15, account: 'bank', category: 'Коммунальные', counterparty: null },
  { key: 'cleaning', name: 'Уборка', amount: 15000, fixed: true, day: 25, account: 'cash', category: 'Уборка', counterparty: 'sadykova' },
  { key: 'mobile', name: 'Мобильная связь', amount: 3000, fixed: true, day: 1, account: 'card', category: 'Интернет и связь', counterparty: null },
  { key: 'salary', name: 'Зарплата штата', amount: 450000, fixed: true, day: 30, account: 'bank', category: 'Зарплата штата', counterparty: null },
];

const CAMRY = {
  key: 'camry', name: 'Toyota Camry, 2019', plate: '01KG 145 ABK', location: 'Салон «Жибек Авто»', valuation: 14000, buyer: 'asanova', apartment: '45',
};
const BMW = {
  key: 'bmw', name: 'BMW X5, 2018', plate: '01KG 702 ADC', location: 'У шефа', valuation: 10000, buyer: 'toktogulov', apartment: '12',
};

const CONCRETE = 'Бетон и раствор';
const REBAR = 'Арматура и металл';
const DELIVERY = 'Доставка и грузоперевозки (портер, грузовое такси)';
const TAXI = 'Такси и поездки';
const WORKS = 'Строительно-монтажные работы';
const MACHINERY = 'Спецтехника (экскаватор, кран, бетононасос)';
const APARTMENTS = 'Оплата за квартиры';

function bought(date, account, amount, object, category, counterparty, docType, description, docNumber = '') {
  return { kind: 'expense', date, account, amount, object, category, counterparty, docType, description, docNumber };
}

function paid(date, template, amount, docType) {
  return { kind: 'recurring', date, template, amount, docType };
}

function received(date, amount, object, category, counterparty, description) {
  return { kind: 'income', date, account: 'bank', amount, object, category, counterparty, description };
}

// Amounts are in major units of the account currency, in date order. The list is
// exported so that tests/seed-balances.md can be recalculated without ledger.js.
export const DEMO_OPERATIONS = [
  paid('2026-09-01', 'mobile', 3000, 'transfer_screenshot'),
  { kind: 'barter_receive', date: '2026-09-01', asset: CAMRY },
  bought('2026-09-02', 'bank', 420000, 'ala', CONCRETE, 'beton', 'waybill', 'Бетон М300, 60 м³', '1184'),
  bought('2026-09-03', 'bank', 310000, 'ala', REBAR, 'mamatov', 'esf', 'Арматура А500, ф14', 'ЭСФ-2207'),
  bought('2026-09-03', 'cash', 2200, 'ala', DELIVERY, 'nurlan', 'cash_order', 'Арматура на блок А'),
  received('2026-09-04', 1200000, 'ala', APARTMENTS, 'asanova', 'Кв. 45, взнос деньгами'),
  bought('2026-09-04', 'cash', 450, 'ala', TAXI, null, 'transfer_screenshot', 'На объект и обратно'),
  paid('2026-09-05', 'rent', 60000, 'payment_order'),
  { kind: 'barter_receive', date: '2026-09-05', asset: BMW },
  bought('2026-09-08', 'bank', 265000, 'dom', CONCRETE, 'beton', 'waybill', 'Бетон М250 на фундамент', '1231'),
  bought('2026-09-09', 'cash', 1800, 'dom', DELIVERY, 'nurlan', 'none', 'Опалубка'),
  paid('2026-09-10', 'internet', 2500, 'transfer_screenshot'),
  bought('2026-09-10', 'usd', 1500, 'ala', MACHINERY, 'tehnika', 'act', 'Экскаватор, 3 смены', 'А-77'),
  received('2026-09-11', 1500000, 'dom', 'Оплата заказчика', 'nur', 'Аванс по договору'),
  bought('2026-09-12', 'bank', 580000, 'ala', WORKS, 'brigada', 'act', 'Монолит, этап 1', 'КС-1'),
  bought('2026-09-14', 'cash', 2100, 'dom', DELIVERY, 'nurlan', 'cash_order', 'Песок, 2 рейса'),
  { kind: 'barter_transfer', date: '2026-09-15', asset: BMW },
  paid('2026-09-15', 'utilities', 7860, 'payment_order'),
  { kind: 'transfer', date: '2026-09-16', from: 'bank', to: 'cash', amount: 300000, fee: 1500, description: 'Снятие наличных' },
  bought('2026-09-17', 'cash', 380, 'office', TAXI, null, 'none', 'В банк и обратно'),
  bought('2026-09-18', 'cash', 2600, 'ala', DELIVERY, 'nurlan', 'cash_order', 'Блоки'),
  bought('2026-09-21', 'bank', 175000, 'dom', REBAR, 'mamatov', 'waybill', 'Арматура ф12', '640'),
  bought('2026-09-22', 'card', 520, 'dom', TAXI, null, 'transfer_screenshot', 'Замер на объекте'),
  bought('2026-09-23', 'bank', 210000, 'dom', CONCRETE, 'beton', 'waybill', 'Бетон М250', '1302'),
  paid('2026-09-25', 'cleaning', 15000, 'cash_order'),
  received('2026-09-28', 800000, 'ala', APARTMENTS, 'toktogulov', 'Кв. 12, доплата деньгами'),
  paid('2026-09-30', 'salary', 450000, 'payment_order'),

  paid('2026-10-01', 'mobile', 3000, 'transfer_screenshot'),
  bought('2026-10-02', 'bank', 390000, 'ala', CONCRETE, 'beton', 'waybill', 'Бетон М300, 55 м³', '1377'),
  bought('2026-10-02', 'cash', 1500, 'ala', DELIVERY, 'nurlan', 'cash_order', 'Вязальная проволока'),
  paid('2026-10-05', 'rent', 60000, 'payment_order'),
  bought('2026-10-06', 'bank', 240000, 'dom', REBAR, 'mamatov', 'esf', 'Арматура А500, ф12', 'ЭСФ-2389'),
  { kind: 'transfer', date: '2026-10-07', from: 'cash', to: 'imprest', amount: 100000, fee: 0, description: 'Выдача под отчёт' },
  bought('2026-10-08', 'imprest', 600, 'ala', TAXI, null, 'transfer_screenshot', 'Поездка за крепежом'),
  bought('2026-10-09', 'imprest', 12000, 'ala', 'Крепёж и расходники', null, 'fiscal_receipt', 'Анкеры, диски'),
  bought('2026-10-09', 'cash', 560, 'ala', TAXI, null, 'transfer_screenshot', 'На объект'),
  paid('2026-10-10', 'internet', 2500, 'transfer_screenshot'),
  bought('2026-10-12', 'bank', 450000, 'dom', WORKS, 'brigada', 'act', 'Кладка, этап 1', 'КС-2'),
  received('2026-10-13', 2000000, 'dom', 'Оплата заказчика', 'nur', 'Второй транш'),
  bought('2026-10-14', 'imprest', 8000, 'ala', 'Погрузка и разгрузка (грузчики)', null, 'none', 'Разгрузка блоков'),
  paid('2026-10-15', 'utilities', 8740, 'payment_order'),
  received('2026-10-16', 950000, 'ala', APARTMENTS, 'asanova', 'Кв. 45, остаток деньгами'),
  bought('2026-10-17', 'bank', 185000, 'ala', REBAR, 'mamatov', 'waybill', 'Арматура ф16', '702'),
  bought('2026-10-19', 'cash', 2800, 'dom', DELIVERY, 'nurlan', 'cash_order', 'Кирпич, 2 рейса'),
  { kind: 'barter_reimburse', date: '2026-10-20', asset: BMW, account: 'usd', amount: 1000, salePrice: 9000 },
  bought('2026-10-20', 'imprest', 6500, 'ala', 'Хозяйственные', null, 'fiscal_receipt', 'Перчатки, плёнка'),
  { kind: 'transfer', date: '2026-10-21', from: 'usd', to: 'cash', amount: 2000, toAmount: 174900, fee: 0, description: 'Обмен $2 000 по 87,45' },
  bought('2026-10-22', 'bank', 520000, 'ala', CONCRETE, 'beton', 'waybill', 'Бетон М300, 75 м³', '1410'),
  { ...bought('2026-10-23', 'bank', 165000, 'ala', REBAR, 'mamatov', 'esf', 'Арматура ф10', 'ЭСФ-2451'), reversalReason: 'Накладная внесена дважды' },
  bought('2026-10-23', 'bank', 165000, 'ala', REBAR, 'mamatov', 'esf', 'Арматура ф10', 'ЭСФ-2451'),
  bought('2026-10-26', 'cash', 340, 'dom', TAXI, null, 'transfer_screenshot', 'На объект'),
  bought('2026-10-27', 'bank', 600000, 'ala', WORKS, 'brigada', 'act', 'Монолит, этап 2', 'КС-3'),
  bought('2026-10-28', 'card', 2400, 'ala', DELIVERY, 'nurlan', 'transfer_screenshot', 'Сетка кладочная'),
  received('2026-10-29', 400000, 'ala', APARTMENTS, 'toktogulov', 'Кв. 12, остаток деньгами'),
  paid('2026-10-30', 'salary', 450000, 'payment_order'),

  bought('2026-11-01', 'bank', 180000, 'ala', REBAR, 'mamatov', 'waybill', 'Арматура ф14', '755'),
  bought('2026-11-01', 'bank', 155000, 'dom', CONCRETE, 'beton', 'waybill', 'Бетон М250', '1466'),
  bought('2026-11-01', 'cash', 2500, 'ala', DELIVERY, 'nurlan', 'cash_order', 'Арматура на блок А'),
  bought('2026-11-01', 'cash', 480, 'dom', TAXI, null, 'transfer_screenshot', 'На объект'),
];

// Taken but not paid yet: no money moves, so they stay out of DEMO_OPERATIONS.
const DEMO_DEBTS = [
  { date: '2026-11-01', due: '2026-11-03', account: 'imprest', amount: 85000, object: 'ala', category: 'Кирпич и блоки', counterparty: 'mamatov', description: 'Блоки, 12 поддонов' },
  { date: '2026-11-01', due: '2026-11-15', account: 'bank', amount: 42000, object: 'dom', category: REBAR, counterparty: 'mamatov', description: 'Арматура ф8' },
];

const minor = (major) => major * 100;

const CONFIRM_ALL = { confirmed: ['large_amount', 'rate_jump', 'negative_balance'] };

async function insertAccounts() {
  const byKey = {};
  for (const { key, name, type, currency, opening } of DEMO_ACCOUNTS) {
    byKey[key] = await insertRow('accounts', {
      name, type, currency, opening_balance: minor(opening), opening_date: OPENING_DATE, is_archived: false,
    });
  }
  return byKey;
}

async function insertObjects(counterparties) {
  const byKey = { office: (await db.objects.toArray()).find((object) => object.is_overhead) };
  for (const { key, name, address, customer } of DEMO_OBJECTS) {
    byKey[key] = await insertRow('objects', {
      name, address, customer_id: customer ? counterparties[customer].id : null, status: 'active', is_overhead: false,
    });
  }
  return byKey;
}

async function insertCounterparties() {
  const byKey = {};
  for (const { key, ...fields } of DEMO_COUNTERPARTIES) byKey[key] = await createCounterparty(fields);
  return byKey;
}

async function insertTemplates(refs) {
  const byKey = {};
  for (const { key, name, amount, fixed, day, account, category, counterparty } of TEMPLATES) {
    const template = await createTemplate({
      name,
      amount: minor(amount),
      amount_is_fixed: fixed,
      day_of_month: day,
      account_id: refs.accounts[account].id,
      category_id: refs.categoryByName(category).id,
      object_id: refs.objects.office.id,
      counterparty_id: counterparty ? refs.counterparties[counterparty].id : null,
      start_date: OPENING_DATE,
    });
    for (const month of ['2026-09', '2026-10']) await ensureInstancesForMonth(template, month);
    byKey[key] = template;
  }
  return byKey;
}

function rateFor(date) {
  return date >= '2026-11-01' ? RATE_NOVEMBER : RATE_AUTUMN;
}

const OPERATION_WRITERS = {
  async expense(op, refs) {
    const row = await createExpense({
      date: op.date,
      account_id: refs.accounts[op.account].id,
      amount: minor(op.amount),
      rate: rateFor(op.date),
      object_id: refs.objects[op.object].id,
      category_id: refs.categoryByName(op.category).id,
      counterparty_id: op.counterparty ? refs.counterparties[op.counterparty].id : null,
      description: op.description,
      doc_type: op.docType,
      doc_number: op.docNumber,
    }, CONFIRM_ALL);
    if (op.reversalReason) await reverseTransaction(row.id, op.reversalReason);
  },

  async recurring(op, refs) {
    const template = refs.templates[op.template];
    const instance = await ensureInstancesForMonth(template, op.date.slice(0, 7));
    await createExpense({
      date: op.date,
      account_id: template.account_id,
      amount: minor(op.amount),
      object_id: template.object_id,
      category_id: template.category_id,
      counterparty_id: template.counterparty_id,
      description: template.name,
      doc_type: op.docType,
      recurring_instance_id: instance.id,
    }, CONFIRM_ALL);
  },

  async income(op, refs) {
    await createIncome({
      date: op.date,
      account_id: refs.accounts[op.account].id,
      amount: minor(op.amount),
      object_id: refs.objects[op.object].id,
      category_id: refs.categoryByName(op.category).id,
      counterparty_id: refs.counterparties[op.counterparty].id,
      description: op.description,
    }, CONFIRM_ALL);
  },

  async transfer(op, refs) {
    await createTransfer({
      date: op.date,
      account_id: refs.accounts[op.from].id,
      to_account_id: refs.accounts[op.to].id,
      amount: minor(op.amount),
      to_amount: op.toAmount ? minor(op.toAmount) : undefined,
      fee: minor(op.fee),
      description: op.description,
    }, CONFIRM_ALL);
  },

  async barter_receive(op, refs) {
    const { key, valuation, buyer, name, plate, location, apartment } = op.asset;
    refs.assets[key] = await receiveAsset({
      name,
      plate,
      location,
      currency: 'USD',
      valuation: minor(valuation),
      rate: rateFor(op.date),
      buyer_id: refs.counterparties[buyer].id,
      object_id: refs.objects.ala.id,
      apartment,
      date: op.date,
    }, CONFIRM_ALL);
  },

  async barter_transfer(op, refs) {
    await transferToContractor(refs.assets[op.asset.key].id, {
      contractor_id: refs.counterparties.brigada.id,
      category_id: refs.categoryByName(WORKS).id,
      rate: rateFor(op.date),
      date: op.date,
      doc_type: 'act',
      doc_number: 'АПП-3',
    });
  },

  async barter_reimburse(op, refs) {
    await reimburseDifference(refs.assets[op.asset.key].id, {
      account_id: refs.accounts[op.account].id,
      amount: minor(op.amount),
      rate: rateFor(op.date),
      sale_price: minor(op.salePrice),
      reason: 'Технические проблемы двигателя',
      approved_by: 'Директор',
      date: op.date,
      doc_type: 'cash_order',
    }, CONFIRM_ALL);
  },
};

async function insertPeriods() {
  const accounts = await db.accounts.toArray();
  const september = (await db.transactions.toArray()).filter((tx) => tx.date <= '2026-09-30');
  const closingBalances = Object.fromEntries(accounts.map((account) => [
    account.id, balanceFromTransactions(account, september),
  ]));
  await insertRow('periods', {
    month: '2026-09', status: 'closed', closed_at: '2026-10-01T10:00:00.000Z', closing_balances: closingBalances,
  });
  await insertRow('periods', { month: '2026-10', status: 'open', closed_at: null, closing_balances: null });
  await insertRow('periods', { month: '2026-11', status: 'open', closed_at: null, closing_balances: null });
}

export async function seedDemo() {
  await clearAllData();
  await ensureDefaults();
  await ledgerTransaction(['periods', 'recurring_templates'], async () => {
    const categories = await db.categories.toArray();
    const counterparties = await insertCounterparties();
    const refs = {
      accounts: await insertAccounts(),
      counterparties,
      objects: await insertObjects(counterparties),
      categoryByName: (name) => categories.find((category) => category.name === name),
      assets: {},
    };
    refs.templates = await insertTemplates(refs);

    for (const op of DEMO_OPERATIONS) await OPERATION_WRITERS[op.kind](op, refs);
    for (const debt of DEMO_DEBTS) {
      await createDebt({
        date: debt.date,
        due_date: debt.due,
        account_id: refs.accounts[debt.account].id,
        amount: minor(debt.amount),
        object_id: refs.objects[debt.object].id,
        category_id: refs.categoryByName(debt.category).id,
        counterparty_id: refs.counterparties[debt.counterparty].id,
        description: debt.description,
      });
    }

    await setLastUsdRate(RATE_NOVEMBER);
    await insertPeriods();
    const settings = await getSettings();
    await updateRow('settings', settings.id, {
      company_name: 'ОсОО «Демо-Строй»',
      started: true,
      is_demo: true,
      last_backup_at: new Date(Date.now() - 2 * 86400000).toISOString(),
    });
  });
}

// Leaves the demo for real work: the app starts empty, the defaults come back.
export async function startClean() {
  await clearAllData();
  await ensureDefaults();
  const settings = await getSettings();
  await db.transaction('rw', db.settings, db.audit_log, () => updateRow('settings', settings.id, { started: true }));
}
