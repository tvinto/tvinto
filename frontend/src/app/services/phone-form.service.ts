import { Injectable, inject } from '@angular/core';
import { Capacitor, PluginListenerHandle } from '@capacitor/core';
import qrcode from 'qrcode-generator';
import { PhoneForm } from './native/phoneFormPlugin';
import { TvNavigationService } from './tv-navigation.service';
import { PHONE_FIELDS, PHONE_LINKS, PhoneFormKind, PhoneFormPage, newPhoneKey, openForm, phoneFormAddress } from '../utils/phone-form.utils';
import { t } from '../utils/i18n';

/** An offer on screen: the QR code for the phone, and the address it holds without its key. */
export interface PhoneOffer {
  /** An SVG of the QR code, for an <img>. Holds the key: never logged. */
  qr: string;
  /** "http://192.168.1.20:8790", for someone who wants to know where it goes. */
  address: string;
  /** Ends the offer: the page goes off the network. */
  close(): void;
}

/**
 * Typing a form on a phone instead of with the remote (phone-form.utils.ts):
 * a television only, since a phone or a computer has a keyboard. The TV
 * serves the page, the phone seals what was typed, and this opens it and
 * hands the fields to the screen, which fills its own form -- nothing is used
 * until the person confirms on the TV.
 */
@Injectable({ providedIn: 'root' })
export class PhoneFormService {
  private readonly tv = inject(TvNavigationService);
  private template: Promise<string | null> | null = null;

  /** Whether this device offers it at all: an Android television. */
  available(): boolean {
    return Capacitor.getPlatform() === 'android' && this.tv.isTelevision();
  }

  /**
   * Puts the form for `kind` on the home network and says where. `arrived` is
   * called with the fields once a phone sends them; the offer then closes.
   * Null when this device cannot offer it, or is not on a network.
   */
  async offer(kind: PhoneFormKind, arrived: (fields: Record<string, string>) => void): Promise<PhoneOffer | null> {
    if (!this.available()) {
      return null;
    }
    const template = await (this.template ??= fetch('assets/phone-form.html')
      .then(response => (response.ok ? response.text() : null))
      .catch(() => null));
    if (!template) {
      return null;
    }
    const key = newPhoneKey();
    const handles: PluginListenerHandle[] = [];
    let open = true;
    const close = () => {
      if (!open) {
        return;
      }
      open = false;
      handles.forEach(handle => void handle.remove());
      void PhoneForm.stop().catch(() => undefined);
    };
    try {
      const { address } = await PhoneForm.start({ html: pageFor(template, kind) });
      handles.push(
        await PhoneForm.addListener('formArrived', sent => {
          let body: unknown = null;
          try {
            body = JSON.parse(sent.body);
          } catch {
            return;
          }
          // Sealed with another key, or not a form at all: nothing is filled, and the page stays up.
          const fields = openForm(key, body, kind);
          if (fields && open) {
            close();
            arrived(fields);
          }
        }),
        await PhoneForm.addListener('closed', () => close())
      );
      return { qr: qrSvg(phoneFormAddress(address, key)), address, close };
    } catch {
      close();
      return null;
    }
  }
}

/** The page with this form's fields and words, as the phone shows them. */
function pageFor(template: string, kind: PhoneFormKind): string {
  const page: PhoneFormPage = {
    kind,
    title: t(`phoneForm.title.${kind}`),
    fields: PHONE_FIELDS[kind].map(field => ({ ...field, label: t(`phoneForm.field.${field.name}`) })),
    ...(PHONE_LINKS[kind] ? { link: { href: PHONE_LINKS[kind], words: t(`phoneForm.link.${kind}`) } } : {}),
    send: t('phoneForm.send'),
    sent: t('phoneForm.sent'),
    noKey: t('phoneForm.noKey'),
    failed: t('phoneForm.failed')
  };
  // Kept inside the <script> it goes into: no "</script>" can close it early.
  const json = JSON.stringify(page).replace(/</g, '\\u003c');
  return template.replace('__TVINTO_FORM__', () => json);
}

/** A QR code for `text`, as an SVG data address for an <img>. */
export function qrSvg(text: string): string {
  const code = qrcode(0, 'M');
  code.addData(text);
  code.make();
  const svg = code.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
