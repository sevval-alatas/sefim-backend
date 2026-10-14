import { createHmac, timingSafeEqual } from 'node:crypto';

export interface AccessTokenClaims {
  sub: number;
  iat: number;
  exp: number;
}

function secret() {
  const value = process.env['JWT_SECRET'];
  if (!value) throw new Error('JWT_SECRET is not configured');
  return value;
}

function base64Url(value: string) {
  return Buffer.from(value).toString('base64url');
}

export function createAccessToken(userId: number) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({ sub: userId, iat: now, exp: now + 604800 }));
  const unsignedToken = `${header}.${payload}`;
  const signature = createHmac('sha256', secret()).update(unsignedToken).digest('base64url');
  return `${unsignedToken}.${signature}`;
}

export function verifyAccessToken(token: string): AccessTokenClaims | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    if (!encodedHeader || !encodedPayload || !encodedSignature) return null;

    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as {
      alg?: unknown;
      typ?: unknown;
    };
    if (header.alg !== 'HS256' || header.typ !== 'JWT') return null;

    const unsignedToken = `${encodedHeader}.${encodedPayload}`;
    const expected = createHmac('sha256', secret()).update(unsignedToken).digest();
    const supplied = Buffer.from(encodedSignature, 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;

    const claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Partial<AccessTokenClaims>;
    const now = Math.floor(Date.now() / 1000);
    if (
      !Number.isSafeInteger(claims.sub) ||
      (claims.sub ?? 0) <= 0 ||
      typeof claims.exp !== 'number' ||
      claims.exp <= now
    ) {
      return null;
    }

    return { sub: claims.sub!, iat: typeof claims.iat === 'number' ? claims.iat : 0, exp: claims.exp };
  } catch {
    return null;
  }
}
