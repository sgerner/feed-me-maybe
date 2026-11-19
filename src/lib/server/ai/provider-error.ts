/** A provider rejection whose HTTP status survives wrapping by processing jobs. */
export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAt?: number,
  ) {
    super(message);
  }

  get permanent(): boolean {
    return (
      this.status >= 400 &&
      this.status < 500 &&
      ![408, 425, 429].includes(this.status)
    );
  }
}

export function retryAtFromHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const time = /^\d+$/.test(value)
    ? Date.now() + Number(value) * 1000
    : Date.parse(value);
  return Number.isSafeInteger(time) && time > 0 ? time : undefined;
}
