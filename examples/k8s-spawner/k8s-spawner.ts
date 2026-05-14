// Kubernetes spawner adapter. Drop-in replacement for reference-lambda/src/spawner.ts.
//
// Scales a target Deployment up and down to spawn/terminate Venari job-node workers.
// Cloud-neutral — runs against any conformant Kubernetes API server.
//
// Required NPM deps to add to reference-lambda/package.json:
//   "@kubernetes/client-node": "^0.20.0"

import * as k8s from '@kubernetes/client-node';
import type { Spawner } from '../../reference-lambda/src/spawner';
import type { WorkerRecord, WorkerState } from '../../reference-lambda/src/types';

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
    return pods.body.items.map(p => this.podToWorker(p));
  }

  async launch(deltaCount: number): Promise<WorkerRecord[]> {
    if (deltaCount <= 0) return [];
    const before = new Set((await this.list()).map(w => w.workerId));

    const scale = await this.apps.readNamespacedDeploymentScale(this.deploymentName, this.namespace);
    const current = scale.body.spec?.replicas ?? 0;
    const target = Math.min(current + deltaCount, this.maxWorkers);
    if (target === current) return [];

    scale.body.spec = { ...(scale.body.spec ?? {}), replicas: target };
    await this.apps.replaceNamespacedDeploymentScale(this.deploymentName, this.namespace, scale.body);

    // Give the controller a beat to create the pods, then diff to report new ones.
    await sleep(750);
    const after = await this.list();
    return after.filter(w => !before.has(w.workerId));
  }

  async terminate(workerId: string): Promise<void> {
    try {
      await this.core.deleteNamespacedPod(workerId, this.namespace);
    } catch (err) {
      // 404 = pod already gone, treat as idempotent success
      if (isHttpStatus(err, 404)) return;
      throw err;
    }
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
