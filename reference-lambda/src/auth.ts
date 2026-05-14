import { timingSafeEqual } from 'node:crypto';

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

function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    // Still consume time proportional to bBuf to avoid leaking length.
    timingSafeEqual(bBuf, bBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
