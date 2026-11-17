// Shared HTTP plumbing for the forge's handlers: one request shape, JSON
// answers that always carry X-GitHub-Request-Id, and body reading.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: Buffer;
  requestId: string;
}

let requestCounter = 0;

export function newRequestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter}-${randomBytes(4).toString('hex')}`;
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (Buffer.concat(chunks).length > 64 * 1024 * 1024) {
        req.destroy(new Error('request body too large'));
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function parsePath(rawUrl: string | undefined): { path: string; query: URLSearchParams } {
  try {
    const url = new URL(rawUrl ?? '/', 'http://entry');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

const JSON_TYPE = 'application/json; charset=utf-8';

export function sendJson(res: ServerResponse, requestId: string, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...extraHeaders,
  });
  res.end(text);
}

export function sendBuffer(res: ServerResponse, requestId: string, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
  });
  res.end(body);
}

export function jsonError(res: ServerResponse, requestId: string, status: number, message: string): void {
  sendJson(res, requestId, status, { message });
}

/** Parse a request body as JSON. Returns null when the body is empty. */
export function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false; error: string } {
  const text = body.toString('utf8').trim();
  if (text === '') return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'invalid JSON' };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function bearerToken(headers: IncomingMessage['headers']): string | null {
  const auth = headers.authorization;
  if (typeof auth !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(auth.trim());
  return match ? (match[1] as string).trim() : null;
}

/** Decode one path segment (percent-decoding, tolerant of bad input). */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
