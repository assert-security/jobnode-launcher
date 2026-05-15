// HTTP-server entry point for the reference launcher.
//
// The launcher's protocol logic lives in handler.ts and is written against the
// AWS Lambda APIGatewayProxyEventV2 shape. This adapter lets the exact same
// handler run as a long-lived process — a container in Kubernetes / ECS, or a
// plain VM — by wrapping each inbound HTTP request in that event shape and
// translating the handler's result back into an HTTP response.
//
// No protocol concern lives here: auth, idempotency, validation and the
// response envelope all stay in handler.ts, conformance-proven and unchanged.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type {
  APIGatewayProxyEventHeaders,
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { handler } from './handler';

const DEFAULT_PORT = 8080;
const DEFAULT_STATUS = 200;
const PAYLOAD_TOO_LARGE = 413;
const INTERNAL_ERROR = 500;
const SHUTDOWN_GRACE_MS = 10 * 1000;

// Liveness / readiness probes for the launcher pod itself. They are deliberately
// unauthenticated and never reach the protocol handler — the protocol's own
// GET /health requires a Bearer token, which a kubelet probe cannot present.
const PROBE_PATHS = new Set(['/livez', '/readyz']);

// Inbound bodies are small JSON launch requests. Refuse anything that is
// obviously not a protocol call before buffering it into memory.
const MAX_BODY_BYTES = 256 * 1024;

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

class BodyTooLargeError extends Error {}

function resolvePort(): number {
  const raw = process.env['PORT'];
  if (!raw) return DEFAULT_PORT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function flattenHeaders(req: IncomingMessage): APIGatewayProxyEventHeaders {
  const headers: APIGatewayProxyEventHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

function toApiGatewayEvent(req: IncomingMessage, url: URL, body: string): APIGatewayProxyEventV2 {
  const method = req.method ?? 'GET';
  const rawPath = url.pathname;
  const rawQueryString = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  const nowMs = Date.now();
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath,
    rawQueryString,
    headers: flattenHeaders(req),
    requestContext: {
      accountId: 'self-hosted',
      apiId: 'self-hosted',
      domainName: req.headers.host ?? 'localhost',
      domainPrefix: 'self-hosted',
      http: {
        method,
        path: rawPath,
        protocol: `HTTP/${req.httpVersion}`,
        sourceIp: req.socket.remoteAddress ?? '0.0.0.0',
        userAgent: req.headers['user-agent'] ?? '',
      },
      requestId: `self-${nowMs.toString(36)}`,
      routeKey: '$default',
      stage: '$default',
      time: new Date(nowMs).toISOString(),
      timeEpoch: nowMs,
    },
    body: body.length > 0 ? body : undefined,
    isBase64Encoded: false,
  };
}

function isStructuredResult(result: APIGatewayProxyResultV2): result is APIGatewayProxyStructuredResultV2 {
  return typeof result === 'object' && result !== null;
}

function writeResult(res: ServerResponse, result: APIGatewayProxyResultV2): void {
  if (!isStructuredResult(result)) {
    res.writeHead(DEFAULT_STATUS, { 'Content-Type': JSON_CONTENT_TYPE });
    res.end(result);
    return;
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(result.headers ?? {})) {
    headers[name] = String(value);
  }
  res.writeHead(result.statusCode ?? DEFAULT_STATUS, headers);
  res.end(result.body ?? '');
}

function writeError(res: ServerResponse, statusCode: number, code: string, message: string): void {
  if (!res.headersSent) {
    res.writeHead(statusCode, { 'Content-Type': JSON_CONTENT_TYPE });
  }
  res.end(JSON.stringify({ error: code, message }));
}

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'GET' && PROBE_PATHS.has(url.pathname)) {
    res.writeHead(DEFAULT_STATUS, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      writeError(res, PAYLOAD_TOO_LARGE, 'payload_too_large', 'Request body exceeds the accepted size.');
      return;
    }
    throw err;
  }

  const result = await handler(toApiGatewayEvent(req, url, body));
  writeResult(res, result);
}

const port = resolvePort();
const server = createServer((req, res) => {
  dispatch(req, res).catch((err: unknown) => {
    console.error('launcher request failed', err);
    writeError(res, INTERNAL_ERROR, 'internal_error', 'The launcher failed to handle the request.');
  });
});

server.listen(port, () => {
  console.log(`launcher listening on port ${port}`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`received ${signal}, draining connections`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  });
}
