// Kubernetes spawner adapter — a true drop-in replacement for
// reference-lambda/src/spawner.ts.
//
// Scales a target Deployment up and down to spawn/terminate Venari job-node
// workers. Cloud-neutral — runs against any conformant Kubernetes API server.
//
// To swap it in, copy this file over the reference launcher's spawner.ts and
// rewrite the relative import prefix so it resolves from src/ (the example
// README gives the exact `cp` + `sed`), then add the k8s client dependency:
//
//   npm install @kubernetes/client-node@^0.20.0
//
// This file owns the Spawner interface as well as the K8sSpawner implementation
// and the getSpawner() factory the handler imports — so once copied in, no
// hand-editing of spawner.ts is needed.

import * as k8s from '@kubernetes/client-node';
import type { WorkerRecord, WorkerState } from '../../reference-lambda/src/types';

// Steers the ReplicaSet to evict a specific worker pod when the Deployment is
// scaled down: on a scale-down the pod carrying the lowest pod-deletion-cost is
// removed first.
// https://kubernetes.io/docs/concepts/workloads/controllers/replicaset/#pod-deletion-cost
const POD_DELETION_COST_ANNOTATION = 'controller.kubernetes.io/pod-deletion-cost';
const EVICT_FIRST_DELETION_COST = '-2147483648';

export interface Spawner {
  readonly maxWorkers: number;
  readonly minWorkers: number;
  list(): Promise<WorkerRecord[]>;
  launch(deltaCount: number): Promise<WorkerRecord[]>;
  terminate(workerId: string): Promise<void>;
  healthDetails(): Promise<Record<string, unknown>>;
}

export interface K8sSpawnerOptions {
  namespace: string;
  deploymentName: string;
  maxWorkers: number;
  minWorkers: number;
  // Optional: an out-of-cluster kubeconfig string. If omitted, in-cluster config
  // is used (the launcher pod authenticates via its mounted ServiceAccount token).
  kubeconfigYaml?: string;
}

export class K8sSpawner implements Spawner {
  readonly maxWorkers: number;
  readonly minWorkers: number;
  private readonly apps: k8s.AppsV1Api;
  private readonly core: k8s.CoreV1Api;
  private readonly namespace: string;
  private readonly deploymentName: string;

  constructor(opts: K8sSpawnerOptions) {
    this.maxWorkers = opts.maxWorkers;
    this.minWorkers = opts.minWorkers;
    this.namespace = opts.namespace;
    this.deploymentName = opts.deploymentName;

    const kc = new k8s.KubeConfig();
    if (opts.kubeconfigYaml) {
      kc.loadFromString(opts.kubeconfigYaml);
    } else {
      kc.loadFromCluster();
    }
    this.apps = kc.makeApiClient(k8s.AppsV1Api);
    this.core = kc.makeApiClient(k8s.CoreV1Api);
  }

  async list(): Promise<WorkerRecord[]> {
    const pods = await this.core.listNamespacedPod(
      this.namespace,
      undefined, undefined, undefined, undefined,
      `app=${this.deploymentName}`
    );
    // A pod with a deletionTimestamp is being evicted — it is no longer an
    // available worker, so drop it rather than report it as running.
    return pods.body.items
      .filter(p => !p.metadata?.deletionTimestamp)
      .map(p => this.podToWorker(p));
  }

  async launch(deltaCount: number): Promise<WorkerRecord[]> {
    if (deltaCount <= 0) return [];

    const scale = await this.apps.readNamespacedDeploymentScale(this.deploymentName, this.namespace);
    const current = scale.body.spec?.replicas ?? 0;
    const target = Math.min(current + deltaCount, this.maxWorkers);
    if (target === current) return [];

    scale.body.spec = { ...(scale.body.spec ?? {}), replicas: target };
    await this.apps.replaceNamespacedDeploymentScale(this.deploymentName, this.namespace, scale.body);

    // Pod names are not yet known — the controller creates them asynchronously.
    // The protocol marks workerInstances as optional; callers discover live
    // workers through GET /workers once the pods reach Running state.
    return [];
  }

  async terminate(workerId: string): Promise<void> {
    // Worker pods are owned by the Deployment's ReplicaSet — deleting a pod
    // alone just makes the ReplicaSet recreate it. To actually remove a worker
    // we lower the Deployment's replica count, and steer the ReplicaSet to
    // evict THIS pod by giving it the lowest pod-deletion-cost.
    try {
      await this.core.patchNamespacedPod(
        workerId,
        this.namespace,
        { metadata: { annotations: { [POD_DELETION_COST_ANNOTATION]: EVICT_FIRST_DELETION_COST } } },
        undefined, undefined, undefined, undefined, undefined,
        { headers: { 'Content-Type': k8s.PatchUtils.PATCH_FORMAT_STRATEGIC_MERGE_PATCH } }
      );
    } catch (err) {
      // 404 = pod already gone, treat as idempotent success
      if (isHttpStatus(err, 404)) return;
      throw err;
    }

    const scale = await this.apps.readNamespacedDeploymentScale(this.deploymentName, this.namespace);
    const current = scale.body.spec?.replicas ?? 0;
    if (current <= 0) return;
    scale.body.spec = { ...(scale.body.spec ?? {}), replicas: current - 1 };
    await this.apps.replaceNamespacedDeploymentScale(this.deploymentName, this.namespace, scale.body);
  }

  async healthDetails(): Promise<Record<string, unknown>> {
    const list = await this.list();
    return {
      implementation: 'jobnode-launcher/k8s-spawner',
      spawnerBackend: 'kubernetes',
      namespace: this.namespace,
      deployment: this.deploymentName,
      currentWorkers: list.length,
      maxWorkers: this.maxWorkers,
    };
  }

  private podToWorker(pod: k8s.V1Pod): WorkerRecord {
    return {
      workerId: pod.metadata?.name ?? 'unknown',
      state: mapPodPhase(pod.status?.phase),
      startedAt: pod.status?.startTime?.toISOString()
                 ?? pod.metadata?.creationTimestamp?.toISOString()
                 ?? new Date().toISOString(),
    };
  }
}

// Module-scoped singleton — the handler calls getSpawner() once per process and
// reuses it. A real spawner is stateless against the cluster, so the singleton
// only caches the k8s client connection.
let singleton: Spawner | null = null;

export function getSpawner(): Spawner {
  if (!singleton) {
    singleton = new K8sSpawner({
      namespace: process.env['K8S_NAMESPACE'] ?? 'asserts-launcher',
      deploymentName: process.env['K8S_DEPLOYMENT_NAME'] ?? 'asserts-jobnode',
      maxWorkers: parseIntEnv('SPAWNER_MAX_WORKERS', 4),
      minWorkers: parseIntEnv('SPAWNER_MIN_WORKERS', 0),
      kubeconfigYaml: process.env['K8S_KUBECONFIG_YAML'],
    });
  }
  return singleton;
}

export function setSpawnerForTest(impl: Spawner | null): void {
  singleton = impl;
}

function mapPodPhase(phase: string | undefined): WorkerState {
  switch (phase) {
    case 'Pending':   return 'starting';
    case 'Running':   return 'running';
    case 'Succeeded':
    case 'Failed':    return 'failed';
    default:          return 'starting';
  }
}

function isHttpStatus(err: unknown, status: number): boolean {
  return typeof err === 'object'
      && err !== null
      && 'response' in err
      && typeof (err as { response?: { statusCode?: unknown } }).response?.statusCode === 'number'
      && (err as { response: { statusCode: number } }).response.statusCode === status;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}
