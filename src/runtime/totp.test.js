import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  normalizeTotpCode,
  otpauthUri,
  totpCode,
  verifyTotp,
} from './totp.js';

test('base32 round-trips arbitrary bytes', () => {
  const bytes = Buffer.from([0, 1, 2, 0x7f, 0x80, 0xff, 0x41, 0x42]);
  assert.equal(base32Encode(bytes), 'AAAQE74A75AUE');
  assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
  // Decoding tolerates lowercase and padding noise.
  assert.deepEqual(base32Decode('aaaQE74a75aue==='), bytes);
});

test('generateTotpSecret returns a 32-char base32 secret of 20 bytes', () => {
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(base32Decode(secret).length, 20);
});

// RFC 6238 test vectors (Appendix B), SHA-1, 20-byte ASCII secret
// "12345678901234567890" — encoded in base32 as the well-known
// GEZDGNBVGY3TQOJQ GEZDGNBVGY3TQOJQ.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('totpCode matches the RFC 6238 vectors (8 digits, then 6)', () => {
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [time, expected8] of vectors) {
    assert.equal(totpCode(RFC_SECRET, time * 1000, { digits: 8 }), expected8, `T=${time}`);
    assert.equal(totpCode(RFC_SECRET, time * 1000), expected8.slice(2), `T=${time} 6 digits`);
  }
});

test('verifyTotp accepts the current step and the ±1 window', () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000;
  const code = totpCode(secret, now);
  assert.equal(verifyTotp(secret, code, { timestamp: now }), true);
  assert.equal(verifyTotp(secret, code, { timestamp: now + 30_000 }), true);
  assert.equal(verifyTotp(secret, code, { timestamp: now - 30_000 }), true);
  assert.equal(verifyTotp(secret, code, { timestamp: now + 60_000 }), false);
  assert.equal(verifyTotp(secret, code, { timestamp: now - 60_000 }), false);
});

test('verifyTotp normalizes spacing and a wrong code is refused', () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000;
  const code = totpCode(secret, now);
  assert.equal(verifyTotp(secret, ` ${code.slice(0, 3)} ${code.slice(3)} `, { timestamp: now }), true);
  assert.equal(verifyTotp(secret, '000000', { timestamp: now }), false);
});

test('normalizeTotpCode keeps six digits', () => {
  assert.equal(normalizeTotpCode(' 123 456 '), '123456');
  assert.equal(normalizeTotpCode('42'), '000042');
  assert.equal(normalizeTotpCode('1234567'), '123456');
});

test('otpauthUri carries the standard parameters', () => {
  const uri = otpauthUri('ABCDEF', { label: 'demo', issuer: 'wikiLLM' });
  assert.ok(uri.startsWith('otpauth://totp/wikiLLM%3Ademo?'));
  assert.ok(uri.includes('secret=ABCDEF'));
  assert.ok(uri.includes('issuer=wikiLLM'));
  assert.ok(uri.includes('digits=6'));
  assert.ok(uri.includes('period=30'));
  assert.ok(uri.includes('algorithm=SHA1'));
});
