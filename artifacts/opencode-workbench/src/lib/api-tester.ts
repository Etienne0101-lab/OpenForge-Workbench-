// A small HTTP client for testing APIs from the workbench.
//
// Requests run through the browser's fetch, so the target API must allow
// CORS from this origin — public APIs and your own dev servers (with CORS
// enabled) work; APIs without CORS headers fail at the browser, and the
// error says so honestly instead of pretending the API is down.

export type ApiResponse = {
  status: number;
  statusText: string;
  timeMs: number;
  sizeBytes: number;
  headers: Array<[string, string]>;
  body: string;
};

export function parseHeaderLines(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) throw new Error(`Header line is missing a colon: "${trimmed}" — use "Name: value" per line.`);
    const name = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (name) headers[name] = value;
  }
  return headers;
}

export function prettyBody(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export async function sendApiRequest(input: { method: string; url: string; headersText: string; bodyText: string }): Promise<ApiResponse> {
  const url = input.url.trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('Enter a full URL starting with http:// or https://');
  const headers = parseHeaderLines(input.headersText);
  const method = input.method.toUpperCase();
  const hasBody = !['GET', 'HEAD'].includes(method) && input.bodyText.trim().length > 0;
  if (hasBody && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
    try {
      JSON.parse(input.bodyText);
      headers['Content-Type'] = 'application/json';
    } catch {
      // not JSON — send as-is without a guessed content type
    }
  }
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(url, { method, headers, body: hasBody ? input.bodyText : undefined });
  } catch {
    throw new Error('The request never completed. Most often this is CORS: the API did not allow calls from this origin. It can also be a wrong URL or no connection. Check the API\'s CORS settings (for your own API, allow this origin) and try again.');
  }
  const text = await response.text();
  const headerPairs: Array<[string, string]> = [];
  response.headers.forEach((value, name) => headerPairs.push([name, value]));
  return {
    status: response.status,
    statusText: response.statusText,
    timeMs: Math.round(performance.now() - started),
    sizeBytes: new Blob([text]).size,
    headers: headerPairs,
    body: text,
  };
}

export const API_TESTER_STORAGE_KEY = 'openforge-workbench-api-tester';
export const API_SAMPLE_URL = 'https://jsonplaceholder.typicode.com/todos/1';
