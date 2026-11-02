import { currentMonth, photoBackup, quickBackup } from '../backup.js';
import { getSettings } from '../db.js';
import { switchTab } from '../nav.js';
import { setLastUsdRate, updateSettings } from '../ledger.js';
import { todayIso } from '../money.js';
import { generateInstances } from '../recurring.js';
import { monthTitle, reportMonths } from '../reports.js';
import { clearPin, isPinSet } from '../security.js';
import { seedDemo, startClean } from '../seed.js';
import { confirmSheet } from '../ui/confirm.js';
import { el } from '../ui/dom.js';
import { badge } from '../ui/icons.js';
import { editSheet } from '../ui/edit-sheet.js';
import { firstIssue } from '../ui/form.js';
import { openPicker } from '../ui/picker.js';
import { toast } from '../ui/toast.js';
import { APP_VERSION } from '../version.js';
import { showPinScreen } from './pin.js';

async function resetDemo() {
  const confirmed = await confirmSheet({
    title: 'Сбросить демо-данные?',
    message: 'Все демо-операции будут заменены исходным набором.',
    confirmLabel: 'Сбросить',
    cancelLabel: 'Отмена',
    danger: true,
  });
  if (!confirmed) return;
  await seedDemo();
  await generateInstances(todayIso());
  toast('Демо-данные восстановлены');
}

async function leaveDemo() {
  const confirmed = await confirmSheet({
    title: 'Начать работу?',
    message: 'Демо-данные удалятся, приложение станет пустым. Дальше вносите свои счета и объекты.',
    confirmLabel: 'Начать работу',
    cancelLabel: 'Отмена',
    danger: true,
  });
  if (!confirmed) return;
  await startClean();
  switchTab('/');
}

async function backupNow() {
  try {
    if (await quickBackup()) toast('Бэкап сохранён');
  } catch (error) {
    toast(firstIssue(error));
  }
}

async function backupPhotos() {
  const months = await reportMonths();
  const picked = await openPicker({
    title: 'Фото за месяц',
    items: (months.length > 0 ? months : [currentMonth()]).map((id) => ({ id, label: monthTitle(id) })),
  });
  if (!picked) return;
  try {
    const { count, delivered } = await photoBackup(picked);
    if (delivered) toast(`В архиве фото: ${count}`);
  } catch (error) {
    toast(firstIssue(error));
  }
}

function menu(title, rows) {
  return el('section', { class: 'card' },
    title && el('div', { class: 'card-head' }, el('h2', {}, title)),
    el('ul', { class: 'rows' }, rows));
}

// Each item gets the coloured icon of iOS settings: the eye finds a row by colour first.
const ICONS = {
  'Регулярные платежи': ['repeat', 'blue'],
  'Бартер': ['car', 'brown'],
  'Закрытие месяца': ['calendar', 'red'],
  'Счета': ['bank', 'blue'],
  'Объекты': ['building', 'orange'],
  'Статьи и группы': ['tag', 'purple'],
  'Контрагенты': ['briefcase', 'teal'],
  'Люди': ['people', 'gray'],
  'Сделать быстрый бэкап': ['backup', 'green'],
  'Фото за месяц': ['photo', 'indigo'],
  'Восстановить из бэкапа': ['restore', 'gray'],
  'Включить PIN': ['lock', 'gray'],
  'Сменить PIN': ['lock', 'gray'],
  'Отключить PIN': ['lock', 'gray'],
  'Название компании': ['briefcase', 'gray'],
  'Курс доллара': ['rate', 'green'],
  'Сбросить демо-данные': ['restore', 'red'],
  'Начать работу со своими данными': ['play', 'red'],
};

function lead(label) {
  const [name, tone] = ICONS[label] ?? ['list', 'gray'];
  return badge(name, tone);
}

function link(label, href) {
  return el('li', {}, el('a', { class: 'row row-compact row-button menu-row chevron', href, 'data-menu': label },
    lead(label), el('p', { class: 'row-title' }, label)));
}

function action(label, onClick, danger = false) {
  return el('li', {}, el('button', {
    class: `row row-compact row-button menu-row${danger ? ' danger-text' : ''}`, type: 'button', 'data-menu': label, onClick,
  }, lead(label), el('span', { class: 'row-title' }, label)));
}

export function renderMore({ view, isCurrent }) {
  async function renameCompany() {
    const settings = await getSettings();
    await editSheet({
      title: 'Название компании',
      fields: [{ key: 'company_name', label: 'Название', type: 'text', value: settings.company_name }],
      onSave: (values) => updateSettings(values),
    });
  }

  async function changeRate() {
    const settings = await getSettings();
    const saved = await editSheet({
      title: 'Курс доллара',
      fields: [{ key: 'rate', label: 'Сомов за доллар', type: 'rate', value: settings.last_usd_rate }],
      onSave: (values) => setLastUsdRate(values.rate),
    });
    if (saved) toast('Курс сохранён');
  }

  function turnPinOn() {
    showPinScreen({
      mode: 'set',
      onDone: () => {
        toast('PIN включён');
        show();
      },
      onCancel: () => {},
    });
  }

  function changePin() {
    showPinScreen({ onDone: turnPinOn, onCancel: () => {} });
  }

  function turnPinOff() {
    showPinScreen({
      onDone: async () => {
        await clearPin();
        toast('PIN отключён');
        show();
      },
      onCancel: () => {},
    });
  }

  async function show() {
    const [settings, pinSet] = await Promise.all([getSettings(), isPinSet()]);
    if (!isCurrent()) return;
    view.replaceChildren(...[
      el('header', { class: 'page-head' }, el('h1', {}, 'Ещё')),
      menu(null, [link('Регулярные платежи', '#/recurring'), link('Бартер', '#/barter'), link('Закрытие месяца', '#/close')]),
      menu('Справочники', [
        link('Счета', '#/refs?table=accounts'), link('Объекты', '#/refs?table=objects'),
        link('Статьи и группы', '#/refs?table=categories'), link('Контрагенты', '#/refs?table=counterparties'),
        link('Люди', '#/refs?table=people'),
      ]),
      menu('Бэкап', [action('Сделать быстрый бэкап', backupNow), action('Фото за месяц', backupPhotos), link('Восстановить из бэкапа', '#/restore')]),
      menu('Настройки', [
        ...(pinSet ? [action('Сменить PIN', changePin), action('Отключить PIN', turnPinOff)] : [action('Включить PIN', turnPinOn)]),
        action('Название компании', renameCompany),
        action('Курс доллара', changeRate),
      ]),
      settings.is_demo && menu('Демо', [action('Сбросить демо-данные', resetDemo, true), action('Начать работу со своими данными', leaveDemo, true)]),
      el('p', { class: 'version' }, `Версия ${APP_VERSION}`),
    ].filter(Boolean));
  }

  show();
}
