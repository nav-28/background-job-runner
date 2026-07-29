import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashPassword, verifyPassword } from '#src/lib/password.ts';

/** Pure unit test — no database, runs under `pnpm test`. */
describe('password hashing', () => {
  it('round trips a password', async () => {
    const stored = await hashPassword('correct horse battery staple');

    assert.equal(await verifyPassword('correct horse battery staple', stored), true);
  });

  it('rejects the wrong password', async () => {
    const stored = await hashPassword('correct horse battery staple');

    assert.equal(await verifyPassword('Correct horse battery staple', stored), false);
    assert.equal(await verifyPassword('', stored), false);
  });

  it('never stores the plaintext', async () => {
    const stored = await hashPassword('password123');

    assert.ok(!stored.includes('password123'));
  });

  it('describes the algorithm and parameters it used', async () => {
    const stored = await hashPassword('password123');

    assert.match(stored, /^scrypt\$\d+\$\d+\$\d+\$[^$]+\$[^$]+$/);
  });

  it('salts randomly: the same password hashes to two different strings, both valid', async () => {
    const first = await hashPassword('password123');
    const second = await hashPassword('password123');

    assert.notEqual(first, second, 'a random salt must make the stored strings differ');
    assert.equal(await verifyPassword('password123', first), true);
    assert.equal(await verifyPassword('password123', second), true);
  });

  it('returns false for a malformed or absent stored hash instead of throwing', async () => {
    const malformed = [
      '',
      '   ',
      'not-a-hash',
      'scrypt$',
      'scrypt$16384$8$1$onlyfivefields',
      'scrypt$16384$8$1$c2FsdA==$', // empty key
      'scrypt$16384$8$1$$a2V5', // empty salt
      'scrypt$0$8$1$c2FsdA==$a2V5', // cost below the floor
      'scrypt$99999999$8$1$c2FsdA==$a2V5', // cost above the ceiling
      'scrypt$abc$8$1$c2FsdA==$a2V5', // non-numeric cost
      'argon2$16384$8$1$c2FsdA==$a2V5', // unknown algorithm
      null,
      undefined,
    ];

    for (const stored of malformed) {
      assert.equal(
        await verifyPassword('password123', stored),
        false,
        `expected false for ${JSON.stringify(stored)}`,
      );
    }
  });
});
