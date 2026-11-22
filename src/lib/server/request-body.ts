/**
 * Parse a request body that must be a JSON object.
 *
 * Returns null for anything else: malformed or empty JSON, `null`, arrays and
 * primitives. `request.json()` happily resolves `null`, so a handler that only
 * guards the parse would throw on its first property access and answer 500.
 */
export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
