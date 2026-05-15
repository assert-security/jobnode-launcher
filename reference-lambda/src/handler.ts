import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { verifyBearer } from './auth';
import { makeIdempotencyStore, type IdempotencyStore } from './idempotency';
import { loadBearerToken } from './secret-loader';
import { getSpawner, type Spawner } from './spawner';
import {
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  REQUEST_ID_REGEX,
  WORKER_ID_REGEX,
  type ErrorBody,
  type HealthResponse,
  type LaunchRequest,
  type LaunchResponse,
  type ListWorkersResponse,
} from './types';

interface Config {
  bearerToken: string;
  tenantSlug: string;
  groupName: string;
}

interface Deps {
  spawner: Spawner;
  idempotency: IdempotencyStore;
  config: Config;
}

let cachedDeps: Deps | null = null;

async function getDeps(): Promise<Deps> {
  if (cachedDeps) return cachedDeps;
  const tenantSlug = process.env['LAUNCHER_TENANT_SLUG'];
  const groupName = process.env['LAUNCHER_GROUP_NAME'];
  if (!tenantSlug) throw new Error('LAUNCHER_TENANT_SLUG env var is required');
  if (!groupName) throw new Error('LAUNCHER_GROUP_NAME env var is required');
  const bearerToken = await loadBearerToken();
  cachedDeps = {
    spawner: getSpawner(),
    idempotency: makeIdempotencyStore(),
    config: { bearerToken, tenantSlug, groupName },
  };
  return cachedDeps;
}

export function resetDepsForTest(): void {
  cachedDeps = null;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const deps = await getDeps();

  const path = event.rawPath ?? '/';
  const method = event.requestContext?.http?.method ?? 'GET';
  const authHeader = readHeader(event, 'authorization');

  const authResult = verifyBearer(authHeader, deps.config.bearerToken);
  if (!authResult.ok) {
    return error(401, authResult.error, errorMessage(authResult.error));
  }

  // Route matching accepts two forms:
  //   - bare path:   /health, /workers, /workers/launch, /workers/{id}
  //   - prefixed:    /v1/health, /v1/workers, etc. (customer base URL includes a path segment)
  // Only a single prefix segment is allowed — /v1/evil/health does not match /health.
  // The prefix pattern ^(?:\/[^/]+)? strips zero or one leading /<segment>.
  const ROUTE_HEALTH          = /^(?:\/[^/]+)?\/health$/;
  const ROUTE_WORKERS         = /^(?:\/[^/]+)?\/workers$/;
  const ROUTE_WORKERS_LAUNCH  = /^(?:\/[^/]+)?\/workers\/launch$/;
  const ROUTE_WORKERS_DELETE  = /^(?:\/[^/]+)?\/workers\/([A-Za-z0-9_-]{1,64})\/?$/;

  if (method === 'GET' && ROUTE_HEALTH.test(path)) {
    return await getHealth(deps);
  }
  if (method === 'GET' && ROUTE_WORKERS.test(path)) {
    return await getWorkers(deps);
  }
  if (method === 'POST' && ROUTE_WORKERS_LAUNCH.test(path)) {
    return await postWorkersLaunch(event, deps);
  }
  const deleteMatch = method === 'DELETE' ? ROUTE_WORKERS_DELETE.exec(path) : null;
  if (deleteMatch) {
    return await deleteWorker(deleteMatch[1]!, deps);
  }

  return error(404, 'not_found', `No route for ${method} ${path}`);
}

async function getHealth(deps: Deps): Promise<APIGatewayProxyResultV2> {
  const details = await deps.spawner.healthDetails();
  const body: HealthResponse = {
    status: 'healthy',
    protocolVersion: PROTOCOL_VERSION,
    capabilities: ['launch', 'list', 'terminate'],
    details,
  };
  return ok(200, body);
}

async function getWorkers(deps: Deps): Promise<APIGatewayProxyResultV2> {
  const workers = await deps.spawner.list();
  const body: ListWorkersResponse = {
    workers,
    limits: {
      minWorkers: deps.spawner.minWorkers,
      maxWorkers: deps.spawner.maxWorkers,
    },
  };
  return ok(200, body);
}

async function postWorkersLaunch(event: APIGatewayProxyEventV2, deps: Deps): Promise<APIGatewayProxyResultV2> {
  let req: LaunchRequest;
  try {
    req = JSON.parse(event.body ?? '{}');
  } catch {
    return error(400, 'malformed_body', 'Request body is not valid JSON.');
  }

  // Field validation
  if (typeof req.requestId !== 'string' || !REQUEST_ID_REGEX.test(req.requestId)) {
    return error(400, 'invalid_request_id', 'requestId must be a UUID v4.');
  }
  if (typeof req.desiredCount !== 'number' || !Number.isInteger(req.desiredCount) || req.desiredCount < 0) {
    return error(400, 'invalid_desired_count', 'desiredCount must be a non-negative integer.');
  }
  if (typeof req.tenantSlug !== 'string' || req.tenantSlug.length === 0) {
    return error(400, 'invalid_tenant_slug', 'tenantSlug is required.');
  }
  if (typeof req.groupName !== 'string' || req.groupName.length === 0) {
    return error(400, 'invalid_group_name', 'groupName is required.');
  }

  // Tenant / group binding
  if (req.tenantSlug !== deps.config.tenantSlug) {
    return error(403, 'tenant_mismatch', 'tenantSlug does not match the configured value.');
  }
  if (req.groupName !== deps.config.groupName) {
    return error(403, 'group_mismatch', 'groupName does not match the configured value.');
  }

  // Idempotency replay
  const replay = await deps.idempotency.get(req.requestId);
  if (replay) {
    return rawJson(200, replay);
  }

  // Determine how many to spawn
  const current = await deps.spawner.list();
  const counted = current.filter(w => w.state === 'starting' || w.state === 'running').length;
  const delta = Math.max(0, req.desiredCount - counted);

  const newWorkers = delta === 0 ? [] : await deps.spawner.launch(delta);

  const responseBody: LaunchResponse = {
    accepted: true,
    requestId: req.requestId,
    workerInstances: newWorkers.map(w => ({ workerId: w.workerId, state: w.state })),
  };
  const responseJson = JSON.stringify(responseBody);
  await deps.idempotency.put(req.requestId, responseJson);
  return rawJson(200, responseJson);
}

async function deleteWorker(workerId: string, deps: Deps): Promise<APIGatewayProxyResultV2> {
  if (!WORKER_ID_REGEX.test(workerId)) {
    return error(400, 'invalid_worker_id', 'workerId does not match the required pattern.');
  }
  await deps.spawner.terminate(workerId);
  return {
    statusCode: 204,
    headers: { [PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION) },
    body: '',
  };
}

// -- helpers ----------------------------------------------------------------

function readHeader(event: APIGatewayProxyEventV2, name: string): string | undefined {
  const headers = event.headers ?? {};
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return undefined;
}

function ok(statusCode: number, body: object): APIGatewayProxyResultV2 {
  return rawJson(statusCode, JSON.stringify(body));
}

function rawJson(statusCode: number, body: string): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      [PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION),
    },
    body,
  };
}

function error(statusCode: number, code: string, message: string): APIGatewayProxyResultV2 {
  const body: ErrorBody = { error: code, message };
  return rawJson(statusCode, JSON.stringify(body));
}

function errorMessage(code: 'missing_authorization' | 'invalid_authorization_scheme' | 'invalid_token'): string {
  switch (code) {
    case 'missing_authorization':         return 'Authorization header is required.';
    case 'invalid_authorization_scheme':  return 'Authorization scheme must be Bearer.';
    case 'invalid_token':                 return 'Bearer token does not match the configured value.';
  }
}
