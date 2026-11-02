// App start and the hash router. Routes render synchronously inside the click that
// opened them: iOS only shows the keyboard for focus() within a user gesture.
import { backupAgeDays, quickBackup, snapshotBeforeMigration } from './backup.js';
import { Dexie, db, ensureDefaults, getSettings } from './db.js';
import { askPersistentStorage, registerServiceWorker, showInstallGuide } from './install.js';
import { updateSettings } from './ledger.js';
import { todayIso } from './money.js';
import { generateInstances } from './recurring.js';
import { renderBarter, renderBarterAsset } from './screens/barter-screen.js';
import { renderCloseMonth } from './screens/close-month.js';
import { renderExpense } from './screens/expense.js';
import { renderHome } from './screens/home.js';
import { renderIncome } from './screens/income.js';
import { renderIssue } from './screens/issue.js';
import { renderJournal } from './screens/journal.js';
import { renderLender } from './screens/lender.js';
import { renderMore } from './screens/more.js';
import { renderObject, renderObjects } from './screens/objects.js';
import { renderPerson } from './screens/person.js';
import { showPinScreen } from './screens/pin.js';
import { renderRecurring } from './screens/recurring-screen.js';
import { renderRefs } from './screens/refs.js';
import { renderReport, renderReports } from './screens/reports-screen.js';
import { renderRestore } from './screens/restore.js';
import { renderTransaction } from './screens/transaction.js';
import { renderTransfer } from './screens/transfer.js';
import { renderWelcome } from './screens/welcome.js';
import { isPinSet } from './security.js';
import { confirmSheet } from './ui/confirm.js';
import { el } from './ui/dom.js';

const ROUTES = {
  '/': { render: renderHome, nav: 'home' },
  '/journal': { render: renderJournal, nav: 'journal' },
  '/objects': { render: renderObjects, nav: 'objects' },
  '/reports': { render: renderReports, nav: 'reports' },
  '/more': { render: renderMore, nav: 'more' },
  '/income': { render: renderIncome, nav: null },
  '/transfer': { render: renderTransfer, nav: null },
  '/tx': { render: renderTransaction, nav: null },
  '/object': { render: renderObject, nav: null },
  '/report': { render: renderReport, nav: null },
  '/recurring': { render: renderRecurring, nav: null },
  '/barter': { render: renderBarter, nav: null },
  '/barter-asset': { render: renderBarterAsset, nav: null },
  '/refs': { render: renderRefs, nav: null },
  '/close': { render: renderCloseMonth, nav: null },
  '/restore': { render: renderRestore, nav: null },
  '/welcome': { render: renderWelcome, nav: null },
  '/expense/new': { render: renderExpense, nav: null },
  '/issue': { render: renderIssue, nav: null },
  '/person': { render: renderPerson, nav: null },
  '/lender': { render: renderLender, nav: null },
};

const view = document.getElementById('view');
const actions = document.getElementById('actions');
const nav = document.getElementById('nav');
let leaveScreen = null;
let visit = 0;

function currentRoute() {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  return { path: path || '/', params: new URLSearchParams(query) };
}

function showRoute() {
  const { path, params } = currentRoute();
  const route = ROUTES[path] ?? ROUTES['/'];
  leaveScreen?.();
  leaveScreen = null;
  visit += 1;
  const thisVisit = visit;
  view.scrollTop = 0;
  actions.replaceChildren();
  document.body.classList.toggle('focused', route.nav === null);
  for (const link of nav.querySelectorAll('a')) {
    const active = link.dataset.nav === route.nav;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  leaveScreen = route.render({ view, actions, params, isCurrent: () => thisVisit === visit }) ?? null;
}

export function navigate(path) {
  history.pushState(null, '', `#${path}`);
  showRoute();
}

document.addEventListener('click', (event) => {
  const link = event.target.closest?.('a[href^="#/"]');
  if (!link || event.defaultPrevented) return;
  event.preventDefault();
  navigate(link.getAttribute('href').slice(1));
});

window.addEventListener('hashchange', showRoute);

function showFatal(error) {
  console.error(error);
  document.body.classList.add('focused');
  view.replaceChildren(el('div', { class: 'fatal' },
    el('h1', {}, 'Приложение не запустилось'),
    el('p', {}, 'Данные не тронуты. Перезапустите приложение. Если ошибка повторяется, покажите этот текст разработчику.'),
    el('pre', {}, String(error?.message ?? error))));
}

const LOCK_AFTER_MS = 5 * 60 * 1000;
let hiddenAt = null;

const SNOOZE_KEY = 'backup-snoozed-until';
const SNOOZE_MS = 60 * 60 * 1000;
const BACKUP_INSIST_DAYS = 3;

async function lockIfNeeded() {
  if (await isPinSet() && !document.querySelector('.pin-screen')) showPinScreen({ onDone: () => {} });
}

// Past three days the app insists: the window can only be put off for an hour (SPEC §10).
async function insistOnBackup(settings) {
  if (!settings.started || await db.transactions.count() === 0) return;
  const age = backupAgeDays(settings, todayIso());
  if (age !== null && age <= BACKUP_INSIST_DAYS) return;
  if (Number(localStorage.getItem(SNOOZE_KEY)) > Date.now()) return;
  const accepted = await confirmSheet({
    title: 'Сделайте бэкап',
    message: age === null ? 'Бэкапа ещё не было. Если телефон потеряется, учёт пропадёт.' : `Последний бэкап был ${age} дн. назад. Если телефон потеряется, эти дни пропадут.`,
    confirmLabel: 'Сделать бэкап',
    cancelLabel: 'Через час',
  });
  if (accepted) await quickBackup();
  else localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAt = Date.now();
  } else if (hiddenAt && Date.now() - hiddenAt > LOCK_AFTER_MS) {
    lockIfNeeded();
  }
});

// Prototype versions had no start mark. Their data must not land on the first-start
// screen, where "Начать работу" would clear it.
async function adoptPrototypeData() {
  const settings = await getSettings();
  if (settings.started === undefined) await updateSettings({ started: true, is_demo: true });
}

async function start() {
  await snapshotBeforeMigration(Dexie);
  await db.open();
  await ensureDefaults();
  await generateInstances(todayIso());
  await askPersistentStorage();
  await adoptPrototypeData();
  const settings = await getSettings();
  if (!settings.started && currentRoute().path !== '/restore') history.replaceState(null, '', '#/welcome');
  showRoute();
  await lockIfNeeded();
  showInstallGuide();
  await registerServiceWorker();
  await insistOnBackup(settings);
}

start().catch(showFatal);
