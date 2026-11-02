// Barter operations (SPEC §8). Each step is a normal ledger operation on a
// service account plus a change to the barter asset card.
import { db, insertRow, updateRow } from './db.js';
import {
  LedgerError, balanceFromTransactions, createExpense, createIncome, createTransfer, ledgerTransaction,
} from './ledger.js';
import { daysBetween, formatMoney } from './money.js';

export const HELD_WARNING_DAYS = 60;

const DEFAULT_LOCATIONS = ['У распорядителя', 'У шефа'];

async function barterAccount(currency) {
  const accounts = await db.accounts.where('type').equals('barter').toArray();
  return accounts.find((account) => account.currency === currency);
}

async function categoryByCode(code) {
  return db.categories.where('code').equals(code).first();
}

// Step 1: the car arrives from an apartment buyer.
export async function receiveAsset({ name, vin = '', plate = '', location = '', currency, valuation, rate, buyer_id, object_id, apartment, date }, { confirmed = [] } = {}) {
  return ledgerTransaction([], async () => {
    const asset = await insertRow('barter_assets', {
      name,
      vin,
      plate,
      location,
      currency,
      valuation,
      buyer_id,
      object_id,
      apartment,
      received_date: date,
      transferred_to_id: null,
      transferred_date: null,
      reimbursed_total: 0,
      status: 'held',
    });
    const account = await barterAccount(currency);
    const category = await categoryByCode('apartment_barter');
    await createIncome({
      date,
      account_id: account.id,
      amount: valuation,
      rate,
      object_id,
      category_id: category.id,
      counterparty_id: buyer_id,
      description: `${name}, кв. ${apartment}`,
      barter_asset_id: asset.id,
    }, { confirmed });
    return asset;
  });
}

// Step 2: a car always moves for its full valuation. When the work costs less, the
// expense is the work only and the rest of the valuation stays on the barter account
// under this car: the contractor owes it until settled by work or money.
export async function transferToContractor(assetId, { contractor_id, category_id, rate, date, doc_type, doc_number = '', work_amount = null }) {
  return ledgerTransaction([], async () => {
    const asset = await db.barter_assets.get(assetId);
    if (asset.status !== 'held') {
      throw new LedgerError('invalid', [{ code: 'not_held', message: 'Машина уже не у компании' }]);
    }
    const work = work_amount ?? asset.valuation;
    if (!(work > 0)) throw new LedgerError('invalid', [{ field: 'work_amount', code: 'required', message: 'Укажите стоимость работ' }]);
    if (work > asset.valuation) {
      throw new LedgerError('invalid', [{
        field: 'work_amount',
        code: 'over_valuation',
        message: 'Работы дороже машины. Передайте её на полную оценку, а остаток запишите долгом подрядчику',
      }]);
    }
    const account = await barterAccount(asset.currency);
    await createExpense({
      date,
      account_id: account.id,
      amount: work,
      rate,
      object_id: asset.object_id,
      category_id,
      counterparty_id: contractor_id,
      description: `Передача: ${asset.name}`,
      doc_type,
      doc_number,
      barter_asset_id: asset.id,
    }, { confirmed: ['large_amount'] }); // the valuation was confirmed on receipt
    return updateRow('barter_assets', assetId, {
      transferred_to_id: contractor_id, transferred_date: date, status: 'transferred',
    }, 'transfer');
  });
}

// Step 3 (optional): the company covers part of the difference, possibly in parts.
export async function reimburseDifference(assetId, { account_id, amount, rate, sale_price, reason, approved_by, date, doc_type }, { confirmed = [] } = {}) {
  return ledgerTransaction([], async () => {
    const asset = await db.barter_assets.get(assetId);
    const issues = [];
    if (asset.status !== 'transferred') issues.push({ code: 'not_transferred', message: 'Машина ещё не передана подрядчику' });
    if (!reason?.trim()) issues.push({ field: 'reason', code: 'required', message: 'Укажите причину' });
    if (!approved_by?.trim()) issues.push({ field: 'approved_by', code: 'required', message: 'Укажите, кто согласовал' });
    const limit = asset.valuation - sale_price - asset.reimbursed_total;
    if (amount > limit) issues.push({ field: 'amount', code: 'over_limit', message: 'Возмещение больше разницы между оценкой и ценой продажи' });
    if (issues.length > 0) throw new LedgerError('invalid', issues);

    const category = await categoryByCode('barter_difference');
    await createExpense({
      date,
      account_id,
      amount,
      rate,
      object_id: asset.object_id,
      category_id: category.id,
      counterparty_id: asset.transferred_to_id,
      description: `Возмещение: ${asset.name}. ${reason.trim()}`,
      doc_type,
      barter_asset_id: asset.id,
      barter_meta: { sale_price, reason: reason.trim(), approved_by: approved_by.trim() },
    }, { confirmed });
    return updateRow('barter_assets', assetId, { reimbursed_total: asset.reimbursed_total + amount }, 'reimburse');
  });
}

// What the contractor still owes for one car: the part of its valuation left on the
// barter account after the handover. Computed from operations, never stored.
function debtOf(asset, account, transactions) {
  const own = transactions.filter((tx) => tx.barter_asset_id === asset.id);
  return balanceFromTransactions({ id: account.id, opening_balance: 0 }, own);
}

// Contractors who owe the company for cars given against cheaper work, oldest first.
export async function barterDebts() {
  const [assets, accounts] = await Promise.all([
    db.barter_assets.where('status').equals('transferred').toArray(),
    db.accounts.where('type').equals('barter').toArray(),
  ]);
  if (assets.length === 0) return [];
  const transactions = await db.transactions.where('barter_asset_id').anyOf(assets.map((asset) => asset.id)).toArray();
  return assets
    .map((asset) => ({
      asset,
      contractor_id: asset.transferred_to_id,
      owed: debtOf(asset, accounts.find((account) => account.currency === asset.currency), transactions),
    }))
    .filter((entry) => entry.owed > 0)
    .sort((a, b) => a.asset.transferred_date.localeCompare(b.asset.transferred_date));
}

export async function assetDebt(assetId) {
  const asset = await db.barter_assets.get(assetId);
  if (asset?.status !== 'transferred') return 0;
  const [account, transactions] = await Promise.all([
    barterAccount(asset.currency), db.transactions.where('barter_asset_id').equals(assetId).toArray(),
  ]);
  return debtOf(asset, account, transactions);
}

async function owingAsset(assetId, amount) {
  const asset = await db.barter_assets.get(assetId);
  const owed = await assetDebt(assetId);
  if (owed <= 0) throw new LedgerError('invalid', [{ code: 'no_debt', message: 'По этой машине долга нет' }]);
  if (!(amount > 0)) throw new LedgerError('invalid', [{ field: 'amount', code: 'required', message: 'Укажите сумму' }]);
  if (amount > owed) {
    throw new LedgerError('invalid', [{ field: 'amount', code: 'over_owed', message: `Долг подрядчика — только ${formatMoney(owed, asset.currency)}` }]);
  }
  return asset;
}

// The contractor works off the debt: a cost of the object, paid with the car.
export async function settleDebtByWork(assetId, { amount, category_id, object_id, rate, date, doc_type, doc_number = '' }, { confirmed = [] } = {}) {
  return ledgerTransaction([], async () => {
    const asset = await owingAsset(assetId, amount);
    const account = await barterAccount(asset.currency);
    return createExpense({
      date,
      account_id: account.id,
      amount,
      rate,
      object_id: object_id ?? asset.object_id,
      category_id,
      counterparty_id: asset.transferred_to_id,
      description: `Зачёт работ за ${asset.name}`,
      doc_type,
      doc_number,
      barter_asset_id: asset.id,
      barter_kind: 'debt_work',
    }, { confirmed });
  });
}

// The contractor pays the debt back: money arrives from the barter account, like a sale.
export async function settleDebtByMoney(assetId, { amount, account_id, to_amount, rate, date }, { confirmed = [] } = {}) {
  return ledgerTransaction([], async () => {
    const asset = await owingAsset(assetId, amount);
    const barter = await barterAccount(asset.currency);
    return createTransfer({
      date,
      account_id: barter.id,
      to_account_id: account_id,
      amount,
      to_amount,
      rate,
      counterparty_id: asset.transferred_to_id,
      description: `Долг за ${asset.name}`,
      barter_asset_id: asset.id,
      barter_kind: 'debt_return',
    }, { confirmed });
  });
}

// The company sells the car itself: money arrives by a transfer from the barter
// account, the difference to the valuation zeroes that account (SPEC §8).
export async function soldByCompany(assetId, { account_id, sale_price, to_amount, rate, date, doc_type }, { confirmed = [] } = {}) {
  return ledgerTransaction([], async () => {
    const asset = await db.barter_assets.get(assetId);
    if (asset.status !== 'held') {
      throw new LedgerError('invalid', [{ code: 'not_held', message: 'Машина уже не у компании' }]);
    }
    if (!(sale_price > 0)) {
      throw new LedgerError('invalid', [{ field: 'sale_price', code: 'required', message: 'Укажите цену продажи' }]);
    }
    const barter = await barterAccount(asset.currency);
    await createTransfer({
      date,
      account_id: barter.id,
      to_account_id: account_id,
      amount: sale_price,
      to_amount,
      rate,
      description: `Продажа: ${asset.name}`,
      barter_asset_id: asset.id,
    }, { confirmed: [...confirmed, 'large_amount'] });
    const difference = asset.valuation - sale_price;
    const common = {
      date, account_id: barter.id, amount: Math.abs(difference), rate, object_id: asset.object_id, barter_asset_id: asset.id,
    };
    if (difference > 0) {
      const category = await categoryByCode('barter_difference');
      await createExpense({ ...common, category_id: category.id, doc_type, description: `Разница при продаже: ${asset.name}` }, { confirmed: ['large_amount'] });
    } else if (difference < 0) {
      const category = await categoryByCode('barter_income');
      await createIncome({ ...common, category_id: category.id, description: `Доход при продаже: ${asset.name}` }, { confirmed: ['large_amount'] });
    }
    return updateRow('barter_assets', assetId, { status: 'sold_by_company', sold_date: date, sale_price }, 'sell');
  });
}

// Documents of the car itself: registration, acts of receipt and handover.
export async function addAssetPhoto(assetId, blob) {
  return db.transaction('rw', db.attachments, db.audit_log, () => insertRow('attachments', {
    transaction_id: null, barter_asset_id: assetId, blob, size: blob.size,
  }));
}

// Where the car stands now: a dealership, the manager or the director. The move
// history stays in audit_log.
export async function moveAsset(assetId, location) {
  const trimmed = location?.trim();
  if (!trimmed) throw new LedgerError('invalid', [{ field: 'location', code: 'required', message: 'Укажите, где находится машина' }]);
  return db.transaction('rw', db.barter_assets, db.audit_log, () => updateRow('barter_assets', assetId, { location: trimmed }, 'move'));
}

// Places for the picker: the two standard ones plus everything used before.
export async function knownLocations() {
  const assets = await db.barter_assets.toArray();
  const used = assets.map((asset) => asset.location).filter(Boolean);
  return [...new Set([...DEFAULT_LOCATIONS, ...used])].sort((a, b) => a.localeCompare(b, 'ru'));
}

// Cars still at the company, with the over-60-days flag for the home screen.
export async function heldAssets(today) {
  const assets = await db.barter_assets.where('status').equals('held').toArray();
  return assets
    .map((asset) => {
      const days = daysBetween(asset.received_date, today);
      return { asset, days_held: days, overdue: days > HELD_WARNING_DAYS };
    })
    .sort((a, b) => b.days_held - a.days_held);
}
