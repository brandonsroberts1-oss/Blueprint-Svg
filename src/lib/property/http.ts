export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/**
 * fetch + JSON with a timeout. Runs in the browser (and in Node for tests), so it
 * sends no custom User-Agent; browsers identify the page via the Referer header.
 */
export async function fetchJson<T = unknown>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 15000, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new Error('Timed out');
    // In a browser this is usually the service not allowing requests from web pages (CORS) or no network.
    throw new Error('Could not reach the service from this browser (blocked or offline)');
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new HttpError(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
  }
  return (await res.json()) as T;
}

/** Serialise calls to a host so we respect one-request-per-second style usage policies. */
export function throttle(minIntervalMs: number) {
  let last = 0;
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(async () => {
      const wait = last + minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return fn();
    });
    chain = run.catch(() => undefined);
    return run;
  };
}
