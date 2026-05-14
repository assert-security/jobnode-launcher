export const PROTOCOL_VERSION = 1;

export const PROTOCOL_VERSION_HEADER = 'X-Protocol-Version';

export type WorkerState = 'starting' | 'running' | 'terminating' | 'failed';

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface WorkerRecord {
  workerId: string;
  state: WorkerState;
  startedAt: string;
}

export interface HealthResponse {
  status: HealthStatus;
  protocolVersion: number;
  capabilities: string[];
  details?: Record<string, unknown>;
}

export interface ListWorkersResponse {
  workers: WorkerRecord[];
  limits: {
    minWorkers: number;
    maxWorkers: number;
  };
}

export interface LaunchRequest {
  requestId: string;
  desiredCount: number;
  tenantSlug: string;
  groupName: string;
  context?: Record<string, unknown>;
}

export interface LaunchResponse {
  accepted: boolean;
  requestId: string;
  workerInstances?: Array<Pick<WorkerRecord, 'workerId' | 'state'>>;
  reason?: string;
}

export interface ErrorBody {
  error: string;
  message?: string;
}

export const REQUEST_ID_REGEX = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const WORKER_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
