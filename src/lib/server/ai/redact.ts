export function redactSecrets(
  value: string,
  extraSecrets: Array<string | undefined> = [],
): string {
  let redacted = value;
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 4) {
      redacted = redacted.split(secret).join('[REDACTED]');
    }
  }
  return redacted
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{8,})\b/g, '[REDACTED]')
    .replace(/([?&](?:api_?key|key|token|secret)=)[^&\s]+/gi, '$1[REDACTED]');
}
