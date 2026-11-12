import crypto from 'crypto';
import { decryptSecret, encryptSecret, resetKeyCache } from './credentialCipher';

const KEY_A = crypto.randomBytes(32).toString('base64');
const KEY_B = crypto.randomBytes(32).toString('base64');

const withKey = (key: string | undefined, run: () => void) => {
  const previous = process.env.CREDENTIAL_KEY;
  if (key === undefined) {
    delete process.env.CREDENTIAL_KEY;
  } else {
    process.env.CREDENTIAL_KEY = key;
  }
  resetKeyCache();
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env.CREDENTIAL_KEY;
    } else {
      process.env.CREDENTIAL_KEY = previous;
    }
    resetKeyCache();
  }
};

describe('encryptSecret', () => {
  it('round-trips a password', () => {
    withKey(KEY_A, () => {
      const encrypted = encryptSecret('provider-password');
      expect(decryptSecret(encrypted)).toBe('provider-password');
    });
  });

  it('does not leave the secret readable in the stored value', () => {
    withKey(KEY_A, () => {
      const encrypted = encryptSecret('hunter2');
      expect(encrypted).not.toContain('hunter2');
      expect(Buffer.from(encrypted).toString('utf8')).not.toContain('hunter2');
    });
  });

  it('produces a different payload each time, so equal passwords are not equal rows', () => {
    withKey(KEY_A, () => {
      expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
    });
  });

  it('handles unicode and empty values', () => {
    withKey(KEY_A, () => {
      expect(decryptSecret(encryptSecret('pÄssword-日本'))).toBe('pÄssword-日本');
      expect(decryptSecret(encryptSecret(''))).toBe('');
    });
  });

  it('is tagged with a version so a later format can be told apart', () => {
    withKey(KEY_A, () => {
      expect(encryptSecret('x').startsWith('v1$')).toBe(true);
    });
  });
});

describe('decryptSecret', () => {
  it('refuses a payload encrypted under a different key', () => {
    let encrypted = '';
    withKey(KEY_A, () => {
      encrypted = encryptSecret('provider-password');
    });

    withKey(KEY_B, () => {
      expect(decryptSecret(encrypted)).toBeNull();
    });
  });

  it('refuses a payload whose ciphertext was altered', () => {
    withKey(KEY_A, () => {
      const parts = encryptSecret('provider-password').split('$');
      const tampered = Buffer.from(parts[3], 'base64');
      tampered[0] = tampered[0] ^ 0xff;
      parts[3] = tampered.toString('base64');

      expect(decryptSecret(parts.join('$'))).toBeNull();
    });
  });

  it('refuses a payload whose authentication tag was altered', () => {
    withKey(KEY_A, () => {
      const parts = encryptSecret('provider-password').split('$');
      const tag = Buffer.from(parts[2], 'base64');
      tag[0] = tag[0] ^ 0xff;
      parts[2] = tag.toString('base64');

      expect(decryptSecret(parts.join('$'))).toBeNull();
    });
  });

  it('refuses anything malformed rather than throwing', () => {
    withKey(KEY_A, () => {
      for (const value of ['', 'plain text', 'v1$only$three', 'v2$a$b$c', null as never]) {
        expect(decryptSecret(value)).toBeNull();
      }
    });
  });
});

describe('key configuration', () => {
  it('accepts a hex key as well as base64', () => {
    const hex = crypto.randomBytes(32).toString('hex');
    withKey(hex, () => {
      expect(decryptSecret(encryptSecret('works'))).toBe('works');
    });
  });

  it('refuses a key of the wrong size rather than quietly using another', () => {
    withKey(Buffer.from('too short').toString('base64'), () => {
      expect(() => encryptSecret('x')).toThrow(/must be 32 bytes/);
    });
  });

  it('generates and reuses a key when none is configured', () => {
    withKey(undefined, () => {
      const encrypted = encryptSecret('generated-key-path');
      expect(decryptSecret(encrypted)).toBe('generated-key-path');
    });
  });
});
