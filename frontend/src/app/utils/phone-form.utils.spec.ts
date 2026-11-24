import { TMDB_KEY_ADDRESS, TMDB_KEY_EXAMPLES } from '@shared/tmdb/key';
import { PHONE_LINKS, fromBase64Url, signInPhoneKind, keyFromFragment, newPhoneKey, openForm, phoneFormAddress, sealForm, toBase64Url } from './phone-form.utils';

describe('typing on the TV from a phone', () => {
  it('asks the sign-in screen for everything with no server yet, the server alone while changing it, and the account otherwise', () => {
    expect(signInPhoneKind(true, false)).toBe('serverSignin');
    expect(signInPhoneKind(false, true)).toBe('server');
    expect(signInPhoneKind(false, false)).toBe('signin');
  });

  it('opens the server, name and password together when there is no server yet', () => {
    const key = newPhoneKey();
    const sealed = sealForm(key, { server: 'sync.example', name: 'ana', password: 'secret' });

    expect(openForm(key, sealed, 'serverSignin')).toEqual({ server: 'sync.example', name: 'ana', password: 'secret' });
  });

  it('puts the key in the address after the #, where the browser never sends it', () => {
    const key = newPhoneKey();
    const address = phoneFormAddress('http://192.168.1.20:8790/', key);

    expect(address.startsWith('http://192.168.1.20:8790/#k=')).toBe(true);
    expect(keyFromFragment(new URL(address).hash)).toEqual(key);
  });

  it('opens on the TV what the phone sealed with the same key', () => {
    const key = newPhoneKey();
    const sealed = sealForm(key, { server: 'http://provider.example:8080', username: 'walk', password: 'walk' });

    expect(openForm(key, sealed, 'xtream')).toEqual({ server: 'http://provider.example:8080', username: 'walk', password: 'walk' });
  });

  it('refuses a form sealed with another key, or altered on the way', () => {
    const key = newPhoneKey();
    const sealed = sealForm(key, { playlist: 'http://lists.example/a.m3u' });
    const altered = fromBase64Url(sealed.box)!;
    altered[0] ^= 1;

    expect(openForm(newPhoneKey(), sealed, 'm3u')).toBeNull();
    expect(openForm(key, { ...sealed, box: toBase64Url(altered) }, 'm3u')).toBeNull();
  });

  it('keeps only the fields of the form being filled, as strings', () => {
    const key = newPhoneKey();
    const sealed = sealForm(key, { playlist: 'http://lists.example/a.m3u', extra: 'x' });

    expect(openForm(key, sealed, 'm3u')).toEqual({ playlist: 'http://lists.example/a.m3u' });
    expect(openForm(key, sealed, 'xtream')).toEqual({ server: '', username: '', password: '' });
  });

  it("takes a TMDB key typed on the phone, which first opens TMDB's API page", () => {
    const key = newPhoneKey();
    const sealed = sealForm(key, { key: TMDB_KEY_EXAMPLES.apiKey });

    expect(openForm(key, sealed, 'tmdb')).toEqual({ key: TMDB_KEY_EXAMPLES.apiKey });
    expect(PHONE_LINKS.tmdb).toBe(TMDB_KEY_ADDRESS);
    expect(PHONE_LINKS.xtream).toBeUndefined();
  });

  it('makes nothing of what is not a sealed form', () => {
    const key = newPhoneKey();

    expect(openForm(key, null, 'm3u')).toBeNull();
    expect(openForm(key, { nonce: 'short', box: 'AAAA' }, 'm3u')).toBeNull();
    expect(openForm(key, { nonce: '!!', box: '??' }, 'm3u')).toBeNull();
  });

  it('finds no key in an address that has none, or a wrong one', () => {
    expect(keyFromFragment('')).toBeNull();
    expect(keyFromFragment('#k=abc')).toBeNull();
    expect(keyFromFragment('#other=1')).toBeNull();
  });
});
