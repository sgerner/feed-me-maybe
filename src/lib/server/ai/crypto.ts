import crypto from 'node:crypto';
import { env } from '$env/dynamic/private';

const APP_SECRET = env.APP_SECRET || 'dev-secret-key-32-chars-min!!';

export function encrypt(text: string): { encrypted: string; nonce: string } {
  const key = crypto.createHash('sha256').update(APP_SECRET).digest();
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return { encrypted: encrypted + authTag, nonce: nonce.toString('hex') };
}

export function decrypt(encrypted: string, nonceHex: string): string {
  try {
    const key = crypto.createHash('sha256').update(APP_SECRET).digest();
    const nonce = Buffer.from(nonceHex, 'hex');
    const authTag = Buffer.from(encrypted.slice(-32), 'hex');
    const ciphertext = encrypted.slice(0, -32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(authTag);
    let dec = decipher.update(ciphertext, 'hex', 'utf8');
    dec += decipher.final('utf8');
    return dec;
  } catch {
    return '';
  }
}
