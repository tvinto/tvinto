import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';

/**
 * Typing on a television from a phone (private plan: sign-in-from-phone).
 *
 * The TV serves a small page on the home network and shows a QR code for it.
 * The address in the code ends in `#k=<key>`: a one-time key the browser never
 * sends over the network. The page seals what was typed with that key and
 * posts it to the TV, which opens it here and fills its own form -- the
 * person still confirms on the TV.
 *
 * Sealed rather than sent plain because the page is plain http on the home
 * network, where anything else on it could read a provider's password. And by
 * a library rather than the browser's own: a browser offers WebCrypto only to
 * https pages and localhost, which a page on 192.168.x.x is not.
 * XChaCha20-Poly1305: a random 24-byte nonce is safe, and a forged or altered
 * message is refused rather than misread.
 */

/** What is being typed: a provider, signing in to a sync service, or that service's address. */
export type PhoneFormKind = 'xtream' | 'm3u' | 'stalker' | 'signin' | 'server';

export interface PhoneField {
  name: string;
  label: string;
  type: 'url' | 'text' | 'password';
}

/** What the page shows, in the app's words. Never the key, which travels only in the address's fragment. */
export interface PhoneFormPage {
  kind: PhoneFormKind;
  title: string;
  fields: PhoneField[];
  send: string;
  sent: string;
  noKey: string;
  failed: string;
}

/** What the page posts back. Both base64url. */
export interface SealedForm {
  nonce: string;
  box: string;
}

/** The fields each kind of form has, by name; labels are the app's. */
export const PHONE_FIELDS: Record<PhoneFormKind, readonly { name: string; type: PhoneField['type'] }[]> = {
  xtream: [
    { name: 'server', type: 'url' },
    { name: 'username', type: 'text' },
    { name: 'password', type: 'password' }
  ],
  m3u: [{ name: 'playlist', type: 'url' }],
  stalker: [
    { name: 'server', type: 'url' },
    { name: 'mac', type: 'text' }
  ],
  // The server is changed on its own, before signing in: changing it starts the app again.
  signin: [
    { name: 'name', type: 'text' },
    { name: 'password', type: 'password' }
  ],
  server: [{ name: 'server', type: 'url' }]
};

/** The largest form accepted, sealed: far more than three fields need, far less than a burden. */
export const MOST_SEALED_BYTES = 8 * 1024;

export function newPhoneKey(): Uint8Array {
  return randomBytes(32);
}

export function toBase64Url(bytes: Uint8Array): string {
  let text = '';
  bytes.forEach(byte => (text += String.fromCharCode(byte)));
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) {
    return null;
  }
  try {
    const plain = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(plain, char => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The page's address with the key in its fragment, for the QR code. */
export function phoneFormAddress(base: string, key: Uint8Array): string {
  return `${base.replace(/\/+$/, '')}/#k=${toBase64Url(key)}`;
}

/** The key from a page's fragment, or null when there is none or it is not one. */
export function keyFromFragment(hash: string): Uint8Array | null {
  const found = /(?:^#|&)k=([A-Za-z0-9_-]+)/.exec(hash)?.[1];
  const key = found ? fromBase64Url(found) : null;
  return key && key.length === 32 ? key : null;
}

/** Seals what was typed, on the phone. */
export function sealForm(key: Uint8Array, values: Record<string, string>): SealedForm {
  const nonce = randomBytes(24);
  const box = xchacha20poly1305(key, nonce).encrypt(new TextEncoder().encode(JSON.stringify(values)));
  return { nonce: toBase64Url(nonce), box: toBase64Url(box) };
}

/**
 * Opens what the phone sent, on the TV: the fields of this kind of form, as
 * strings, or null when it was sealed with another key, altered on the way,
 * or is not a form of this kind.
 */
export function openForm(key: Uint8Array, sealed: unknown, kind: PhoneFormKind): Record<string, string> | null {
  const given = sealed as Partial<SealedForm> | null;
  const nonce = typeof given?.nonce === 'string' ? fromBase64Url(given.nonce) : null;
  const box = typeof given?.box === 'string' && given.box.length <= MOST_SEALED_BYTES * 2 ? fromBase64Url(given.box) : null;
  if (!nonce || nonce.length !== 24 || !box) {
    return null;
  }
  let values: unknown;
  try {
    values = JSON.parse(new TextDecoder().decode(xchacha20poly1305(key, nonce).decrypt(box)));
  } catch {
    return null;
  }
  if (!values || typeof values !== 'object') {
    return null;
  }
  const form: Record<string, string> = {};
  for (const field of PHONE_FIELDS[kind]) {
    const value = (values as Record<string, unknown>)[field.name];
    form[field.name] = typeof value === 'string' ? value.slice(0, 2048) : '';
  }
  return form;
}
