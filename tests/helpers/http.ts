/**
 * Real loopback HTTP for the worker-isolation tests.
 *
 * Deliberately not a mocked request object: the thing under test is middleware
 * ordering and header handling, and a hand-rolled req/res stub is exactly where
 * a header-parsing bug would hide.
 */
import http from 'node:http';
import type { Express } from 'express';

export async function request(
  app: Express,
  method: string,
  path: string,
  org?: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: {
        Authorization: 'Bearer test-agent-token',
        ...(org ? { 'X-Org-Id': org } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      // Spread rather than assign: exactOptionalPropertyTypes rejects an
      // explicit `undefined` for RequestInit.body.
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}
