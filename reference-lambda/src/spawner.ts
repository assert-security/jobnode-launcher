import type { WorkerRecord } from './types';

export interface Spawner {
  readonly maxWorkers: number;
  readonly minWorkers: number;
  list(): Promise<WorkerRecord[]>;
  launch(deltaCount: number): Promise<WorkerRecord[]>;
  terminate(workerId: string): Promise<void>;
  healthDetails(): Promise<Record<string, unknown>>;
}

// REPLACE-ME ----------------------------------------------------------------
// Default in-memory spawner. It does not actually start any worker process —
// it only records what a real spawner WOULD have done so the protocol is
// observable end-to-end. Replace with your own implementation that schedules
// the Venari job-node container in your environment (k8s Deployment scale,
// ECS RunTask, Nomad job dispatch, etc.). See ../examples/ for adapters.
// ---------------------------------------------------------------------------

export class StubSpawner implements Spawner {
  readonly maxWorkers: number;
  readonly minWorkers: number;
  private readonly workers = new Map<string, WorkerRecord>();
  private nextId = 1;

  constructor(opts?: { maxWorkers?: number; minWorkers?: number }) {
    this.maxWorkers = opts?.maxWorkers ?? 4;
    this.minWorkers = opts?.minWorkers ?? 0;
  }

  async list(): Promise<WorkerRecord[]> {
    return Array.from(this.workers.values());
  }

  async launch(deltaCount: number): Promise<WorkerRecord[]> {
    const headroom = this.maxWorkers - this.workers.size;
    const toSpawn = Math.max(0, Math.min(deltaCount, headroom));
    const created: WorkerRecord[] = [];
    for (let i = 0; i < toSpawn; i++) {
      const workerId = `wkr-stub-${(this.nextId++).toString(16).padStart(6, '0')}`;
      const record: WorkerRecord = {
        workerId,
        state: 'starting',
        startedAt: new Date().toISOString(),
      };
      this.workers.set(workerId, record);
      created.push(record);
    }
    return created;
  }

  async terminate(workerId: string): Promise<void> {
    this.workers.delete(workerId);
  }

  async healthDetails(): Promise<Record<string, unknown>> {
    return {
      implementation: 'jobnode-launcher/reference-lambda@stub',
      spawnerBackend: 'in-memory-stub',
      currentWorkers: this.workers.size,
      maxWorkers: this.maxWorkers,
    };
  }
}

// Module-scoped singleton — Lambda reuses warm containers, so this persists
// across invocations within the same execution environment. Cold starts reset
// the in-memory state, which is acceptable for the stub but unacceptable for
// production. A real spawner is stateless against the underlying scheduler.
let singleton: Spawner | null = null;

export function getSpawner(): Spawner {
  if (!singleton) {
    singleton = new StubSpawner({
      maxWorkers: parseIntEnv('SPAWNER_MAX_WORKERS', 4),
      minWorkers: parseIntEnv('SPAWNER_MIN_WORKERS', 0),
    });
  }
  return singleton;
}

export function setSpawnerForTest(impl: Spawner | null): void {
  singleton = impl;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}
