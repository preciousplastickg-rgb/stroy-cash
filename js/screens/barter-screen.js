// Barter register and the card of one car (SPEC §8).
import {
  addAssetPhoto, assetDebt, barterDebts, knownLocations, moveAsset, receiveAsset, reimburseDifference, settleDebtByMoney, settleDebtByWork,
  soldByCompany, transferToContractor,
} from '../barter.js';
import { db, getSettings } from '../db.js';
import { DOC_TYPES, allBalances, shortName, sortAccounts } from '../ledger.js';
import { formatDate, formatMoney, todayIso } from '../money.js';
import { navigate } from '../nav.js';
import { el } from '../ui/dom.js';
import { editSheet } from '../ui/edit-sheet.js';
import { formHead } from '../ui/form.js';
import { photoThumbs } from '../ui/photo-viewer.js';
import { operationRow } from '../ui/operation-row.js';
import { compressPhoto } from '../ui/photo.js';
import { openPicker } from '../ui/picker.js';
import { toast } from '../ui/toast.js';

const STATUS_LABELS = { held: 'У компании', transferred: 'Передана подрядчику', sold_by_company: 'Продана компанией' };
const FILTERS = [['all', 'Все'], ['held', 'У компании'], ['owes', 'Должны'], ['transferred', 'Переданы'], ['sold_by_company', 'Проданы']];

const toOptions = (rows) => rows.map((row) => ({ value: row.id, label: shortName(row.name) }));
// Articles of work grouped as in the directory, the way the expense form shows them.
const workOptions = (refs) => refs.works.map((row) => ({ value: row.id, label: shortName(row.name), group: refs.groups.get(row.parent_id) }));
// Money accounts with their balance, the main cash desk preselected as before.
const moneyOptions = (refs) => refs.money.map((row) => ({ value: row.id, label: row.name, sub: formatMoney(refs.balances.get(row.id), row.currency) }));
const docOptions = () => DOC_TYPES.map((doc) => ({ value: doc.code, label: doc.label }));

async function references() {
  const [accounts, categories, objects, counterparties, settings, balances] = await Promise.all([
    db.accounts.toArray(), db.categories.where('kind').equals('expense').toArray(), db.objects.toArray(), db.counterparties.toArray(), getSettings(),
    allBalances(),
  ]);
  return {
    balances,
    groups: new Map(categories.filter((row) => !row.parent_id).map((row) => [row.id, row.name])),
    money: sortAccounts(accounts.filter((row) => row.type !== 'barter' && row.type !== 'imprest' && !row.is_archived)),
    works: categories.filter((row) => row.parent_id && !row.is_archived).sort((a, b) => a.position - b.position),
    objects: objects.filter((row) => row.status === 'active'),
    counterparties: counterparties.filter((row) => !row.is_archived),
    lastRate: settings.last_usd_rate,
  };
}

export function renderBarter({ view, isCurrent }) {
  let filter = 'all';

  async function receive() {
    const refs = await references();
    const saved = await editSheet({
      title: 'Получить машину',
      fields: [
        { key: 'name', label: 'Машина', type: 'text' },
        { key: 'vin', label: 'VIN', type: 'text', optional: true },
        { key: 'plate', label: 'Госномер', type: 'text', optional: true },
        { key: 'location', label: 'Где находится', type: 'text', optional: true },
        { key: 'currency', label: 'Валюта оценки', type: 'select', value: 'USD', options: [{ value: 'USD', label: 'USD' }, { value: 'KGS', label: 'KGS' }] },
        { key: 'valuation', label: 'Оценка', type: 'amount' },
        { key: 'rate', label: 'Курс к сому', type: 'rate', value: refs.lastRate },
        {
          key: 'buyer_id',
          label: 'Покупатель',
          type: 'counterparty',
          counterpartyType: 'buyer',
          createLabel: 'Новый покупатель',
          options: toOptions(refs.counterparties.filter((row) => row.type === 'buyer')),
        },
        { key: 'object_id', label: 'Объект', type: 'pick', options: toOptions(refs.objects) },
        { key: 'apartment', label: 'Номер квартиры', type: 'text' },
        { key: 'date', label: 'Дата получения', type: 'date', value: todayIso() },
      ],
      saveLabel: 'Получить',
      onSave: (values, options) => receiveAsset({ ...values, vin: values.vin ?? '', plate: values.plate ?? '', location: values.location ?? '' }, options),
    });
    if (saved) show();
  }

  async function show() {
    const [assets, counterparties, debts] = await Promise.all([db.barter_assets.toArray(), db.counterparties.toArray(), barterDebts()]);
    if (!isCurrent()) return;
    const names = new Map(counterparties.map((row) => [row.id, row.name]));
    const owed = new Map(debts.map((entry) => [entry.asset.id, entry.owed]));
    const rows = assets
      .filter((asset) => filter === 'all' || (filter === 'owes' ? owed.has(asset.id) : asset.status === filter))
      .sort((a, b) => b.received_date.localeCompare(a.received_date));
    view.replaceChildren(
      formHead('Бартер', { href: '#/more' }),
      el('button', { class: 'button button-primary', type: 'button', 'data-action': 'receive', onClick: receive }, 'Получить машину'),
      el('div', { class: 'filter-chips' }, FILTERS.map(([key, label]) => el('button', {
        class: `chip filter-chip${filter === key ? ' selected' : ''}`,
        type: 'button',
        onClick: () => {
          filter = key;
          show();
        },
      }, label))),
      rows.length === 0
        ? el('p', { class: 'stub-note' }, 'Машин нет')
        : el('section', { class: 'card' }, el('ul', { class: 'rows' }, rows.map((asset) => el('li', {}, el('a', {
          class: 'row row-button', href: `#/barter-asset?id=${asset.id}`, 'data-asset': asset.name,
        },
        el('div', { class: 'row-main' },
          el('p', { class: 'row-title' }, asset.name),
          el('p', { class: 'row-sub' }, `${names.get(asset.buyer_id) ?? ''}, кв. ${asset.apartment}`),
          el('p', { class: 'row-sub' }, asset.status === 'held'
            ? `${STATUS_LABELS.held}${asset.location ? `, ${asset.location}` : ''}`
            : asset.transferred_to_id ? `Передана: ${names.get(asset.transferred_to_id)}` : STATUS_LABELS[asset.status]),
          owed.has(asset.id) && el('p', { class: 'pill pill-warn' }, `Долг ${formatMoney(owed.get(asset.id), asset.currency)}`)),
        el('p', { class: 'row-amount' }, formatMoney(asset.valuation, asset.currency))))))),
    );
  }

  show();
}

export function renderBarterAsset({ view, params, isCurrent }) {
  const id = params?.get('id');
  const urls = [];

  async function addPhoto(event) {
    const [file] = event.target.files;
    if (!file) return;
    try {
      await addAssetPhoto(id, await compressPhoto(file));
      show();
    } catch (error) {
      toast(error.message);
    }
  }

  async function changeLocation(asset) {
    const places = await knownLocations();
    const picked = await openPicker({
      title: 'Где находится машина',
      items: places.map((place) => ({ id: place, label: place })),
      selectedId: asset.location,
      searchPlaceholder: 'Найти или ввести новое место',
      canCreate: true,
    });
    const place = picked?.create ?? picked;
    if (place) {
      await moveAsset(asset.id, place);
      show();
    }
  }

  async function giveToContractor(asset) {
    const refs = await references();
    const saved = await editSheet({
      title: 'Передать подрядчику',
      fields: [
        {
          key: 'contractor_id',
          label: 'Подрядчик',
          type: 'counterparty',
          counterpartyType: 'contractor',
          createLabel: 'Новый подрядчик',
          options: toOptions(refs.counterparties.filter((row) => row.type === 'contractor')),
        },
        { key: 'category_id', label: 'Статья работ', type: 'pick', options: workOptions(refs) },
        {
          key: 'work_amount',
          label: `Работы стоят, ${asset.currency}`,
          type: 'amount',
          optional: true,
          hint: `Пусто — работы на всю оценку ${formatMoney(asset.valuation, asset.currency)}. Если меньше, разница станет долгом подрядчика`,
        },
        { key: 'rate', label: 'Курс к сому', type: 'rate', value: refs.lastRate },
        { key: 'date', label: 'Дата передачи', type: 'date', value: todayIso() },
        { key: 'doc_type', label: 'Документ', type: 'select', value: 'act', options: docOptions() },
        { key: 'doc_number', label: 'Номер документа', type: 'text', optional: true },
      ],
      saveLabel: 'Передать',
      onSave: (values) => transferToContractor(asset.id, { ...values, work_amount: values.work_amount ?? null, doc_number: values.doc_number ?? '' }),
    });
    if (saved) show();
  }

  async function reimburse(asset) {
    const refs = await references();
    const saved = await editSheet({
      title: 'Возместить разницу',
      fields: [
        { key: 'sale_price', label: `Цена продажи подрядчиком, ${asset.currency}`, type: 'amount' },
        { key: 'amount', label: 'Сумма возмещения', type: 'amount' },
        { key: 'account_id', label: 'Счёт', type: 'pick', value: refs.money[0]?.id, options: moneyOptions(refs) },
        { key: 'rate', label: 'Курс к сому', type: 'rate', value: refs.lastRate },
        { key: 'reason', label: 'Причина', type: 'text' },
        { key: 'approved_by', label: 'Кто согласовал', type: 'text' },
        { key: 'date', label: 'Дата', type: 'date', value: todayIso() },
        { key: 'doc_type', label: 'Документ', type: 'select', value: 'none', options: docOptions() },
      ],
      saveLabel: 'Возместить',
      onSave: (values, options) => reimburseDifference(asset.id, values, options),
    });
    if (saved) show();
  }

  async function settleByWork(asset, owed) {
    const refs = await references();
    const saved = await editSheet({
      title: 'Зачесть работы',
      fields: [
        { key: 'amount', label: `Работы на сумму, ${asset.currency}`, type: 'amount', hint: `Долг подрядчика ${formatMoney(owed, asset.currency)}` },
        { key: 'category_id', label: 'Статья работ', type: 'pick', options: workOptions(refs) },
        { key: 'object_id', label: 'Объект', type: 'pick', value: asset.object_id, options: toOptions(refs.objects) },
        { key: 'rate', label: 'Курс к сому', type: 'rate', value: refs.lastRate },
        { key: 'date', label: 'Дата', type: 'date', value: todayIso() },
        { key: 'doc_type', label: 'Документ', type: 'select', value: 'act', options: docOptions() },
      ],
      saveLabel: 'Зачесть',
      onSave: (values, options) => settleDebtByWork(asset.id, values, options),
    });
    if (saved) show();
  }

  async function settleByMoney(asset, owed) {
    const refs = await references();
    const saved = await editSheet({
      title: 'Вернул деньгами',
      fields: [
        { key: 'amount', label: `Сумма, ${asset.currency}`, type: 'amount', hint: `Долг подрядчика ${formatMoney(owed, asset.currency)}` },
        { key: 'account_id', label: 'Куда пришли деньги', type: 'pick', value: refs.money[0]?.id, options: moneyOptions(refs) },
        { key: 'to_amount', label: 'Зачислено, если валюта счёта другая', type: 'amount', optional: true },
        { key: 'rate', label: 'Курс к сому', type: 'rate', value: refs.lastRate },
        { key: 'date', label: 'Дата', type: 'date', value: todayIso() },
      ],
      saveLabel: 'Записать',
      onSave: (values, options) => settleDebtByMoney(asset.id, { ...values, to_amount: values.to_amount ?? undefined }, options),
    });
    if (saved) show();
  }

  async function sell(asset) {
    const refs = await references();
    const saved = await editSheet({
      title: 'Продано компанией',
      fields: [
        { key: 'sale_price', label: `Цена продажи, ${asset.currency}`, type: 'amount' },
        { key: 'account_id', label: 'Куда пришли деньги', type: 'pick', value: refs.money[0]?.id, options: moneyOptions(refs) },
        { key: 'to_amount', label: 'Зачислено, если валюта счёта другая', type: 'amount', optional: true },
        { key: 'rate', label: 'Курс к сому', type: 'rate', value: refs.lastRate },
        { key: 'date', label: 'Дата продажи', type: 'date', value: todayIso() },
        { key: 'doc_type', label: 'Документ', type: 'select', value: 'none', options: docOptions() },
      ],
      saveLabel: 'Продано',
      onSave: (values, options) => soldByCompany(asset.id, { ...values, to_amount: values.to_amount ?? undefined }, options),
    });
    if (saved) show();
  }

  async function show() {
    const [asset, photos, operations, accounts, objects, categories, counterparties, owed] = await Promise.all([
      db.barter_assets.get(id),
      db.attachments.where('barter_asset_id').equals(id).toArray(),
      db.transactions.where('barter_asset_id').equals(id).sortBy('number'),
      db.accounts.toArray(), db.objects.toArray(), db.categories.toArray(), db.counterparties.toArray(),
      assetDebt(id),
    ]);
    if (!isCurrent()) return;
    if (!asset) {
      navigate('/barter', { replace: true });
      return;
    }
    const byId = (rows) => new Map(rows.map((row) => [row.id, row]));
    const refs = { accounts: byId(accounts), objects: byId(objects), categories: byId(categories) };
    const names = byId(counterparties);
    const fact = (label, value) => (value ? [el('dt', {}, label), el('dd', {}, value)] : []);
    for (const url of urls.splice(0)) URL.revokeObjectURL(url);
    const images = photoThumbs(photos.filter((photo) => photo.blob).map((photo) => {
      const url = URL.createObjectURL(photo.blob);
      urls.push(url);
      return url;
    }), 'Документ машины');
    const button = (label, action, onClick, primary = false) => el('button', {
      class: `button${primary ? ' button-primary' : ''}`, type: 'button', 'data-action': action, onClick,
    }, label);
    view.replaceChildren(...[
      formHead(asset.name, { href: '#/barter' }),
      el('section', { class: 'total' },
        el('p', { class: 'total-label' }, STATUS_LABELS[asset.status]),
        el('p', { class: 'total-value', 'data-testid': 'asset-valuation' }, formatMoney(asset.valuation, asset.currency)),
        owed > 0 && el('p', { class: 'pill pill-warn asset-owed', 'data-testid': 'asset-owed' },
          `Долг: ${names.get(asset.transferred_to_id)?.name ?? 'подрядчик'}, ${formatMoney(owed, asset.currency)}`)),
      el('dl', { class: 'facts' },
        fact('Покупатель', names.get(asset.buyer_id)?.name),
        fact('Квартира', asset.apartment),
        fact('Объект', refs.objects.get(asset.object_id)?.name),
        fact('Получена', formatDate(asset.received_date)),
        fact('Где находится', asset.status === 'held' ? (asset.location || 'Не указано') : null),
        fact('VIN', asset.vin),
        fact('Госномер', asset.plate),
        fact('Передана', names.get(asset.transferred_to_id)?.name),
        fact('Дата передачи', asset.transferred_date ? formatDate(asset.transferred_date) : null),
        fact('Возмещено', asset.reimbursed_total > 0 ? formatMoney(asset.reimbursed_total, asset.currency) : null),
        fact('Цена продажи', asset.sale_price ? formatMoney(asset.sale_price, asset.currency) : null)),
      el('div', { class: 'tx-actions stacked' },
        asset.status === 'held' && button('Передать подрядчику', 'give', () => giveToContractor(asset), true),
        asset.status === 'held' && button('Продано компанией', 'sell', () => sell(asset)),
        asset.status === 'held' && button('Изменить место', 'move', () => changeLocation(asset)),
        owed > 0 && button('Зачесть работы', 'settle-work', () => settleByWork(asset, owed), true),
        owed > 0 && button('Вернул деньгами', 'settle-money', () => settleByMoney(asset, owed)),
        asset.status === 'transferred' && owed <= 0 && button('Возместить разницу', 'reimburse', () => reimburse(asset), true)),
      images.length > 0 && el('div', { class: 'photo-grid', 'data-testid': 'asset-photos' }, images),
      el('label', { class: 'photo-button secondary' },
        el('input', { class: 'file-input', type: 'file', accept: 'image/*', 'data-photo': 'asset', onChange: addPhoto }), 'Добавить фото документа'),
      el('section', { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', {}, 'Операции')),
        el('ul', { class: 'rows' }, operations.map((tx) => operationRow(tx, refs)))),
    ].filter(Boolean));
  }

  show();
  return () => {
    for (const url of urls) URL.revokeObjectURL(url);
  };
}
