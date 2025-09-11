export async function exponentialRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 4,
  baseDelay = 500,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status;
      if (attempt >= maxRetries || ![429, 502, 503, 504].includes(status)) {
        throw err;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, baseDelay * 2 ** attempt));
    }
  }
}
