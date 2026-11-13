/**
 * The page a phone opens from the QR code on the TV (phone-form.utils.ts):
 * the TV's form, typed on the phone, sealed with the key in the address's
 * fragment and posted back to the TV that served it.
 *
 * Bundled into src/assets/phone-form.html by scripts/build-phone-page.mjs.
 * The TV puts the form's words into the page as it serves it; nothing here
 * is fetched from anywhere else.
 */
import { PhoneFormPage, keyFromFragment, sealForm } from '../src/app/utils/phone-form.utils';

const form = (window as unknown as { TVINTO_FORM?: PhoneFormPage }).TVINTO_FORM;
const root = document.getElementById('form') as HTMLElement;
const status = document.getElementById('status') as HTMLElement;

function say(text: string, kind: 'info' | 'done' | 'error'): void {
  status.textContent = text;
  status.className = `status ${kind}`;
}

function build(page: PhoneFormPage, key: Uint8Array): void {
  (document.getElementById('title') as HTMLElement).textContent = page.title;
  // Where to get what is asked for (a TMDB key), opened here on the phone.
  if (page.link && /^https:\/\//.test(page.link.href)) {
    const link = document.createElement('a');
    link.className = 'link';
    link.href = page.link.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = page.link.words;
    root.append(link);
  }
  const element = document.createElement('form');
  element.autocomplete = 'off';
  for (const field of page.fields) {
    const label = document.createElement('label');
    const words = document.createElement('span');
    words.textContent = field.label;
    const input = document.createElement('input');
    input.name = field.name;
    input.type = field.type;
    input.autocapitalize = 'off';
    input.spellcheck = false;
    if (field.type === 'url') {
      input.inputMode = 'url';
      input.placeholder = 'http://';
    }
    label.append(words, input);
    element.append(label);
  }
  const send = document.createElement('button');
  send.type = 'submit';
  send.textContent = page.send;
  element.append(send);
  element.addEventListener('submit', event => {
    event.preventDefault();
    const values: Record<string, string> = {};
    for (const field of page.fields) {
      values[field.name] = ((element.elements.namedItem(field.name) as HTMLInputElement | null)?.value ?? '').trim();
    }
    send.disabled = true;
    fetch('/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sealForm(key, values)) })
      .then(response => {
        if (!response.ok) {
          throw new Error(String(response.status));
        }
        element.remove();
        say(page.sent, 'done');
      })
      .catch(() => {
        send.disabled = false;
        say(page.failed, 'error');
      });
  });
  root.append(element);
  (element.querySelector('input') as HTMLInputElement | null)?.focus();
}

const key = keyFromFragment(location.hash);
if (!form) {
  say('This page is opened from the QR code on your TV.', 'error');
} else if (!key) {
  (document.getElementById('title') as HTMLElement).textContent = form.title;
  say(form.noKey, 'error');
} else {
  build(form, key);
  // The key has done its job once the form exists; it need not stay in the address bar or history.
  history.replaceState(null, '', location.pathname);
}
