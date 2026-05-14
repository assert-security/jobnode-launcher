import { describe, expect, it, beforeEach } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handler, resetDepsForTest } from '../src/handler';
import { setSpawnerForTest, StubSpawner } from '../src/spawner';
import { clearCachedTokenForTest } from '../src/secret-loader';
import { PROTOCOL_VERSION } from '../src/types';

const TENANT = 'test-tenant';
const GROUP = 'Test Group';
const TOKEN = 'test-token-aaaaaaaaaaaaaaaaaa';

function makeEvent(opts: {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  headers?: Record<string, string>;
  body?: object;
}): APIGatewayProxyEventV2 {
  const baseHeaders: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: opts.path,
    rawQueryString: '',
    headers: { ...baseHeaders, ...(opts.headers ?? {}) },
    requestContext: {
      accountId: '0',
      apiId: 'test',
      domainName: 'test',
      domainPrefix: 'test',
      http: { method: opts.method, path: opts.path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'test',
      routeKey: '$default',
      stage: '$default',
      time: '',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  } as APIGatewayProxyEventV2;
}

function parse(body: string | undefined): any {
  return JSON.parse(body ?? '{}');
}

function uuid(): string {
  // Crypto-quality UUID generation is fine; we just need the pattern to match.
  return ([1e7] as any + -1e3 + -4e3 + -8e3 + -1e11)
    .replace(/[018]/g, (c: any) => (c ^ (Math.random() * 16 >> (c / 4))).toString(16));
}

describe('reference launcher handler', () => {
  beforeEach(() => {
    process.env['LAUNCHER_BEARER_TOKEN'] = TOKEN;
    process.env['LAUNCHER_TENANT_SLUG'] = TENANT;
    process.env['LAUNCHER_GROUP_NAME'] = GROUP;
    delete process.env['LAUNCHER_BEARER_TOKEN_SECRET_ARN'];
    delete process.env['IDEMPOTENCY_TABLE_NAME'];
    clearCachedTokenForTest();
    resetDepsForTest();
    setSpawnerForTest(new StubSpawner({ maxWorkers: 4, minWorkers: 0 }));
  });

  it('GET /health returns shape', async () => {
    const r = await handler(makeEvent({ method: 'GET', path: '/health' }));
    expect((r as any).statusCode).toBe(200);
    const body = parse((r as any).body);
    expect(body.status).toBe('healthy');
    expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(body.capabilities).toContain('launch');
    expect(body.capabilities).toContain('list');
  });

  it('GET /workers returns array + limits', async () => {
    const r = await handler(makeEvent({ method: 'GET', path: '/workers' }));
    expect((r as any).statusCode).toBe(200);
    const body = parse((r as any).body);
    expect(Array.isArray(body.workers)).toBe(true);
    expect(body.limits.maxWorkers).toBe(4);
    expect(body.limits.minWorkers).toBe(0);
  });

  it('rejects missing Authorization', async () => {
    const event = makeEvent({ method: 'GET', path: '/health' });
    delete event.headers!['authorization'];
    const r = await handler(event);
    expect((r as any).statusCode).toBe(401);
    expect(parse((r as any).body).error).toBe('missing_authorization');
  });

  it('rejects wrong bearer token', async () => {
    const r = await handler(makeEvent({ method: 'GET', path: '/health', headers: { authorization: 'Bearer nope' } }));
    expect((r as any).statusCode).toBe(401);
    expect(parse((r as any).body).error).toBe('invalid_token');
  });

  it('POST /workers/launch spawns workers', async () => {
    const requestId = uuid();
    const r = await handler(makeEvent({
      method: 'POST',
      path: '/workers/launch',
      body: { requestId, desiredCount: 2, tenantSlug: TENANT, groupName: GROUP },
    }));
    expect((r as any).statusCode).toBe(200);
    const body = parse((r as any).body);
    expect(body.accepted).toBe(true);
    expect(body.requestId).toBe(requestId);
    expect(body.workerInstances).toHaveLength(2);

    const after = parse((await handler(makeEvent({ method: 'GET', path: '/workers' })) as any).body);
    expect(after.workers).toHaveLength(2);
  });

  it('POST /workers/launch is idempotent on requestId', async () => {
    const requestId = uuid();
    const body = { requestId, desiredCount: 1, tenantSlug: TENANT, groupName: GROUP };

    const r1 = await handler(makeEvent({ method: 'POST', path: '/workers/launch', body }));
    const r2 = await handler(makeEvent({ method: 'POST', path: '/workers/launch', body }));

    expect((r1 as any).body).toBe((r2 as any).body);

    const after = parse((await handler(makeEvent({ method: 'GET', path: '/workers' })) as any).body);
    expect(after.workers).toHaveLength(1);
  });

  it('rejects non-UUID requestId with 400', async () => {
    const r = await handler(makeEvent({
      method: 'POST',
      path: '/workers/launch',
      body: { requestId: 'not-a-uuid', desiredCount: 1, tenantSlug: TENANT, groupName: GROUP },
    }));
    expect((r as any).statusCode).toBe(400);
  });

  it('rejects tenant mismatch with 403', async () => {
    const r = await handler(makeEvent({
      method: 'POST',
      path: '/workers/launch',
      body: { requestId: uuid(), desiredCount: 1, tenantSlug: 'wrong', groupName: GROUP },
    }));
    expect((r as any).statusCode).toBe(403);
  });

  it('DELETE /workers/{id} returns 204 and removes worker', async () => {
    const launchBody = { requestId: uuid(), desiredCount: 1, tenantSlug: TENANT, groupName: GROUP };
    const launched = parse((await handler(makeEvent({ method: 'POST', path: '/workers/launch', body: launchBody })) as any).body);
    const id = launched.workerInstances[0].workerId;

    const r = await handler(makeEvent({ method: 'DELETE', path: `/workers/${id}` }));
    expect((r as any).statusCode).toBe(204);

    const after = parse((await handler(makeEvent({ method: 'GET', path: '/workers' })) as any).body);
    expect(after.workers.find((w: any) => w.workerId === id)).toBeUndefined();
  });

  it('DELETE for absent worker is also 204', async () => {
    const r = await handler(makeEvent({ method: 'DELETE', path: '/workers/wkr-nonexistent-1' }));
    expect((r as any).statusCode).toBe(204);
  });

  it('DELETE rejects malformed workerId with 400', async () => {
    const r = await handler(makeEvent({ method: 'DELETE', path: '/workers/$$$' }));
    expect((r as any).statusCode).toBe(400);
  });

  it('respects maxWorkers cap', async () => {
    const r = await handler(makeEvent({
      method: 'POST',
      path: '/workers/launch',
      body: { requestId: uuid(), desiredCount: 100, tenantSlug: TENANT, groupName: GROUP },
    }));
    expect((r as any).statusCode).toBe(200);
    const after = parse((await handler(makeEvent({ method: 'GET', path: '/workers' })) as any).body);
    expect(after.workers.length).toBeLessThanOrEqual(4);
  });
});
