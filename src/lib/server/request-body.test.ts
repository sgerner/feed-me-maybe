import { describe, expect, it } from 'vitest';
import { readJsonObject } from './request-body';

function requestWith(body: string | undefined) {
  return new Request('http://localhost/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

describe('readJsonObject', () => {
  it('returns a plain JSON object', async () => {
    expect(await readJsonObject(requestWith('{"a":1,"b":[2]}'))).toEqual({
      a: 1,
      b: [2],
    });
    expect(await readJsonObject(requestWith('{}'))).toEqual({});
  });

  it.each([
    ['JSON null', 'null'],
    ['a JSON array', '[1,2]'],
    ['an empty array', '[]'],
    ['a JSON string', '"text"'],
    ['a JSON number', '123'],
    ['JSON true', 'true'],
    ['malformed JSON', '{"a":'],
    ['plain text', 'not json'],
    ['an empty body', ''],
  ])('returns null for %s', async (_label, body) => {
    expect(await readJsonObject(requestWith(body))).toBeNull();
  });

  it('returns null when the request has no body at all', async () => {
    expect(await readJsonObject(requestWith(undefined))).toBeNull();
  });
});
