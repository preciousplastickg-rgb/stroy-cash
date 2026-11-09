// Backups (SPEC §10). The quick one is every table as readable JSON without photos,
// the photo backup is a ZIP per month. A restore replaces everything, in one transaction.
import {
  Dexie, SCHEMA_VERSION, clearAllData, db, ensureDefaults, getSettings, nowIso,
} from './db.js';
import { balanceFromTransactions, isMoneyAccount, updateSettings } from './ledger.js';
import { monthOf, todayIso } from './money.js';
import { deliverFile } from './ui/share.js';

export async function buildBackup() {
  const tables = {};
  for (const table of db.tables) {
    const rows = await table.toArray();
    tables[table.name] = table.name === 'attachments' ? rows.map(({ blob, ...row }) => row) : rows;
  }
  return { app: 'stroy-cash', schema_version: SCHEMA_VERSION, created_at: nowIso(), tables };
}

async function backupFile() {
  const json = JSON.stringify(await buildBackup(), null, 1);
  return new Blob([json], { type: 'application/json' });
}

export async function quickBackup() {
  const delivered = await deliverFile(await backupFile(), `kassa-backup-${todayIso()}.json`);
  if (delivered) await updateSettings({ last_backup_at: nowIso() });
  return delivered;
}

// The data as it is right before a restore replaces it or an erase removes it.
// Resolves to false when the share menu is closed without saving.
export async function saveCopyBefore(reason) {
  return deliverFile(await backupFile(), `kassa-before-${reason}-${todayIso()}.json`);
}

const SNAPSHOTS_DB = 'stroy-cash-snapshots';

// «Удалить все данные» (SPEC §10): the app goes back to its first start, with only
// the defaults of an empty app. The copies kept before schema upgrades go too, so
// nothing of the old data stays on the phone. The screen saves a backup first.
export async function eraseAllData() {
  await clearAllData();
  await Dexie.delete(SNAPSHOTS_DB);
  await ensureDefaults();
}

export function backupAgeDays(settings, today) {
  if (!settings.last_backup_at) return null;
  const last = new Date(settings.last_backup_at);
  const start = Date.UTC(last.getFullYear(), last.getMonth(), last.getDate());
  const [year, month, day] = today.split('-').map(Number);
  return Math.round((Date.UTC(year, month - 1, day) - start) / 86400000);
}

function loadJsZip() {
  if (globalThis.JSZip) return Promise.resolve(globalThis.JSZip);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'vendor/jszip.min.js';
    script.onload = () => resolve(globalThis.JSZip);
    script.onerror = () => reject(new Error('Не удалось загрузить модуль архива'));
    document.head.append(script);
  });
}

// File names are operation numbers; the manifest ties them back to attachments.
export async function buildPhotoArchive(month) {
  const JSZip = await loadJsZip();
  const zip = new JSZip();
  const transactions = (await db.transactions.where('date').between(`${month}-01`, `${month}-31`, true, true).toArray())
    .filter((tx) => tx.number != null).sort((a, b) => a.number - b.number);
  const manifest = {};
  for (const tx of transactions) {
    const photos = await db.attachments.where('transaction_id').equals(tx.id).toArray();
    photos.forEach((photo, index) => {
      const name = `${tx.number}${index > 0 ? `_${index + 1}` : ''}.jpg`;
      zip.file(`photos/${name}`, photo.blob);
      manifest[name] = photo.id;
    });
  }
  zip.file('manifest.json', JSON.stringify(manifest, null, 1));
  return { count: Object.keys(manifest).length, blob: await zip.generateAsync({ type: 'blob' }) };
}

export async function photoBackup(month) {
  const { count, blob } = await buildPhotoArchive(month);
  const delivered = await deliverFile(blob, `kassa-photos-${month}.zip`);
  if (delivered) await updateSettings({ last_full_backup_month: month });
  return { count, delivered };
}

export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Это не файл бэкапа');
  }
  if (data?.app !== 'stroy-cash' || !data.tables?.transactions) throw new Error('Это не файл бэкапа');
  if (data.schema_version > SCHEMA_VERSION) throw new Error('Бэкап сделан более новой версией приложения. Сначала обновите приложение.');
  return data;
}

// What the file holds, shown before anything is replaced.
export function backupSummary(data) {
  const posted = data.tables.transactions.filter((tx) => tx.number != null);
  const dates = posted.map((tx) => tx.date).sort();
  return {
    operations: posted.length,
    last_date: dates.at(-1) ?? null,
    balances: data.tables.accounts.filter(isMoneyAccount).map((account) => ({
      account,
      balance: balanceFromTransactions(account, data.tables.transactions),
    })),
  };
}

export async function restoreBackup(data) {
  await db.transaction('rw', db.tables, async () => {
    await Promise.all(db.tables.map((table) => table.clear()));
    for (const table of db.tables) {
      const rows = data.tables[table.name] ?? [];
      await table.bulkAdd(table.name === 'attachments' ? rows.map((row) => ({ ...row, blob: null })) : rows);
    }
    const at = nowIso();
    await db.audit_log.add({
      id: crypto.randomUUID(), table_name: 'settings', row_id: 'restore', action: 'restore', before: null, after: { from: data.created_at }, at, created_at: at, updated_at: at,
    });
  });
  await ensureDefaults();
  const settings = await getSettings();
  if (!settings.started) await updateSettings({ started: true });
}

export async function restorePhotos(file) {
  const JSZip = await loadJsZip();
  const zip = await JSZip.loadAsync(file);
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  let restored = 0;
  for (const [name, id] of Object.entries(manifest)) {
    const entry = zip.file(`photos/${name}`);
    const row = await db.attachments.get(id);
    if (!entry || !row) continue;
    const blob = new Blob([await entry.async('uint8array')], { type: 'image/jpeg' });
    await db.attachments.update(id, { blob });
    restored += 1;
  }
  return restored;
}

// Before a schema upgrade the old data is copied aside, the app cannot ask for a file
// at that moment (SPEC §10).
export async function snapshotBeforeMigration(DexieClass, name = 'stroy-cash', targetVersion = SCHEMA_VERSION) {
  if (!(await DexieClass.exists(name))) return false;
  const current = new DexieClass(name);
  await current.open();
  const version = current.verno;
  if (version >= targetVersion) {
    current.close();
    return false;
  }
  const tables = {};
  for (const table of current.tables) {
    const rows = await table.toArray();
    tables[table.name] = table.name === 'attachments' ? rows.map(({ blob, ...row }) => row) : rows;
  }
  current.close();
  const snapshots = new DexieClass(SNAPSHOTS_DB);
  snapshots.version(1).stores({ snapshots: 'created_at' });
  await snapshots.table('snapshots').put({ created_at: nowIso(), schema_version: version, tables });
  snapshots.close();
  return true;
}

export function currentMonth() {
  return monthOf(todayIso());
}
