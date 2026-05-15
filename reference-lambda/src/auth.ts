import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

export type AuthResult =
  | { ok: true }
  | { ok: false; error: 'missing_authorization' | 'invalid_authorization_scheme' | 'invalid_token' };

export function verifyBearer(authorizationHeader: string | undefined, expectedToken: string): AuthResult {
  if (!authorizationHeader) {
    return { ok: false, error: 'missing_authorization' };
  }
  if (!authorizationHeader.startsWith('Bearer ')) {
    return { ok: false, error: 'invalid_authorization_scheme' };
  }
  const presented = authorizationHeader.slice('Bearer '.length).trim();
  if (presented.length === 0 || !constantTimeEqual(presented, expectedToken)) {
    return { ok: false, error: 'invalid_token' };
  }
  return { ok: true };
}

// A random key generated once per process lifetime. Its only purpose is to
// make the two HMAC digests the same length regardless of the input strings,
// eliminating the length oracle that a naive timingSafeEqual(aBuf, bBuf) has
// when the buffers differ in length.
const HMAC_KEY = randomBytes(32);

function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHmac('sha256', HMAC_KEY).update(a, 'utf8').digest();
  const digestB = createHmac('sha256', HMAC_KEY).update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}
