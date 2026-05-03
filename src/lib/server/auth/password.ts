import crypto from 'node:crypto';
import { env } from '$env/dynamic/private';

const appAuthSecret = process.env.APP_PASSWORD || env.APP_PASSWORD;

export function verifyPassword(input: string): boolean {
  if (!appAuthSecret) {
    console.error(
      '[auth] APP_PASSWORD environment variable is not set. All login attempts will be rejected.',
    );
    return false;
  }
  return timingSafeEqual(input, appAuthSecret);
}

function timingSafeEqual(a: string, b: string): boolean {
  const encodedA = Buffer.from(a);
  const encodedB = Buffer.from(b);
  if (encodedA.length !== encodedB.length) {
    // Compare against self to keep timing consistent
    crypto.timingSafeEqual(encodedA, encodedA);
    return false;
  }
  return crypto.timingSafeEqual(encodedA, encodedB);
}

export function isPasswordSet(): boolean {
  return !!(process.env.APP_PASSWORD || env.APP_PASSWORD);
}
