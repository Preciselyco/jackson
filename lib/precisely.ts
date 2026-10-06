// Shared helpers for the Precisely-only API under pages/api/precisely/.
import type { NextApiRequest, NextApiResponse } from 'next';

const pageLimit = 25;
const maxConsecutiveErrors = 3;

// Thrown by fetchAllPages when a page keeps failing. Handlers answer it with a 502.
export class PageFetchError extends Error {
  constructor(public readonly reason: unknown) {
    super('Failed to fetch a page from the directory');
  }
}

// Answers anything but GET with a 405. Returns false when the handler should stop.
export function allowGet(req: NextApiRequest, res: NextApiResponse): boolean {
  if (req.method === 'GET') {
    return true;
  }
  res.setHeader('Allow', 'GET');
  res.status(405).json({ error: { message: `Method ${req.method} not allowed` } });
  return false;
}

// The HTTP status for an error thrown by a Polis controller, 500 when it carries none.
export function errorStatus(err: any): number {
  const status = Number(err?.statusCode);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

// Collects every page of a paginated Polis call. A failing page is retried, and after
// maxConsecutiveErrors failures in a row a PageFetchError is thrown, so the caller never
// returns a partial result as a success.
export async function fetchAllPages<T>(
  fetchPage: (opts: { pageLimit: number; pageOffset: number }) => Promise<{ data?: T[] | null; error?: any }>
): Promise<T[]> {
  const items: T[] = [];
  let pageOffset = 0;
  let errors = 0;

  while (true) {
    const { data, error } = await fetchPage({ pageLimit, pageOffset });
    if (error) {
      if (++errors >= maxConsecutiveErrors) {
        throw new PageFetchError(error);
      }
      continue;
    }
    errors = 0;
    if (!data || data.length == 0) {
      return items;
    }
    items.push(...data);
    pageOffset += pageLimit;
  }
}

// Sends the response for an error thrown while building a handler's result.
export function sendError(res: NextApiResponse, err: any) {
  if (err instanceof PageFetchError) {
    res.status(502).json({ error: { message: err.message } });
    return;
  }
  res.status(errorStatus(err)).json({ error: { message: err?.message ?? 'Internal error' } });
}
