import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

/*
 RFC 6238 TOTP with the defaults every authenticator app ships:
 HMAC-SHA1, 6 digits, 30-second period. Self-contained — no dependency.

 The secret is base32 (RFC 4648, no padding, uppercase), 20 bytes by default.
 Verification accepts a ±1 window so a drifting clock or a code typed at the
 end of its period is not a refusal, and compares DIGESTS (constant-time),
 never the raw strings.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input) {
  const clean = String(input ?? '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const output = [];
  for (const char of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function generateTotpSecret(bytes = 20) {
  return base32Encode(randomBytes(bytes));
}

export function totpCode(secret, timestamp = Date.now(), { digits = 6, period = 30 } = {}) {
  const counter = Math.floor(Number(timestamp) / 1000 / period);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function digestEqual(left, right) {
  const a = createHash('sha256').update(String(left ?? '')).digest();
  const b = createHash('sha256').update(String(right ?? '')).digest();
  return timingSafeEqual(a, b);
}

export function normalizeTotpCode(code) {
  return String(code ?? '').replace(/\D/g, '').padStart(6, '0').slice(0, 6);
}

export function verifyTotp(secret, code, { window = 1, period = 30, timestamp = Date.now() } = {}) {
  const wanted = normalizeTotpCode(code);
  for (let step = -window; step <= window; step++) {
    const candidate = totpCode(secret, timestamp + step * period * 1000, { period });
    if (digestEqual(candidate, wanted)) return true;
  }
  return false;
}

export function otpauthUri(secret, { label = 'wiki', issuer = 'wikiLLM' } = {}) {
  const params = new URLSearchParams({ secret, issuer, digits: '6', period: '30', algorithm: 'SHA1' });
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${label}`)}?${params.toString()}`;
}
