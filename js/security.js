// PIN: a salted SHA-256, as a guard against casual viewing. The data itself is not
// encrypted, the phone passcode protects it (SPEC §10).
import { getSettings } from './db.js';
import { updateSettings } from './ledger.js';

async function digest(pin, salt) {
  const bytes = new TextEncoder().encode(`${salt}:${pin}`);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function setPin(pin) {
  const salt = crypto.randomUUID();
  await updateSettings({ pin_hash: await digest(pin, salt), pin_salt: salt });
}

export async function clearPin() {
  await updateSettings({ pin_hash: null, pin_salt: null });
}

export async function verifyPin(pin) {
  const settings = await getSettings();
  return (await digest(pin, settings.pin_salt)) === settings.pin_hash;
}

export async function isPinSet() {
  return Boolean((await getSettings()).pin_hash);
}
