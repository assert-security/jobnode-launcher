// AWS ECS Fargate spawner adapter. Drop-in replacement for reference-lambda/src/spawner.ts.
//
// Spawns Venari job-node workers as Fargate tasks via ECS RunTask.
// Worker ID is the ECS task ARN's task ID component.
//
// Required NPM deps to add to reference-lambda/package.json:
//   "@aws-sdk/client-ecs": "^3.600.0"

import {
  ECSClient,
  RunTaskCommand,
  StopTaskCommand,
  ListTasksCommand,
  DescribeTasksCommand,
  type Task,
} from '@aws-sdk/client-ecs';
import type { Spawner } from '../../reference-lambda/src/spawner';
import type { WorkerRecord, WorkerState } from '../../reference-lambda/src/types';

export interface EcsSpawnerOptions {
  clusterArn: string;
  taskDefinition: string;     // e.g. "asserts-jobnode:7" or the family name for :latest
  subnetIds: string[];
  securityGroupIds: string[];
  assignPublicIp?: boolean;   // default false (workers in private subnet)
  maxWorkers: number;
  minWorkers: number;
}

export class EcsSpawner implements Spawner {
  readonly maxWorkers: number;
  readonly minWorkers: number;
  private readonly ecs: ECSClient;
  private readonly clusterArn: string;
  private readonly taskDefinition: string;
  private readonly subnetIds: string[];
  private readonly securityGroupIds: string[];
  private readonly assignPublicIp: 'ENABLED' | 'DISABLED';

  constructor(opts: EcsSpawnerOptions) {
    this.maxWorkers = opts.maxWorkers;
    this.minWorkers = opts.minWorkers;
    this.clusterArn = opts.clusterArn;
    this.taskDefinition = opts.taskDefinition;
    this.subnetIds = opts.subnetIds;
    this.securityGroupIds = opts.securityGroupIds;
    this.assignPublicIp = opts.assignPublicIp ? 'ENABLED' : 'DISABLED';
    this.ecs = new ECSClient({});
  }

  async list(): Promise<WorkerRecord[]> {
    const tasks = await this.describeOwnTasks();
    return tasks.map(t => taskToWorker(t));
  }

  async launch(deltaCount: number): Promise<WorkerRecord[]> {
    if (deltaCount <= 0) return [];

    const current = await this.describeOwnTasks();
    const counted = current.filter(t => isCounted(t)).length;
    const headroom = Math.max(0, this.maxWorkers - counted);
    const toSpawn = Math.min(deltaCount, headroom);
    if (toSpawn === 0) return [];

    const res = await this.ecs.send(new RunTaskCommand({
      cluster: this.clusterArn,
      taskDefinition: this.taskDefinition,
      launchType: 'FARGATE',
      count: toSpawn,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: this.subnetIds,
          securityGroups: this.securityGroupIds,
          assignPublicIp: this.assignPublicIp,
        },
      },
      tags: [{ key: 'asserts.launcher', value: 'job-node' }],
      propagateTags: 'TASK_DEFINITION',
    }));
    return (res.tasks ?? []).map(t => taskToWorker(t));
  }

  async terminate(workerId: string): Promise<void> {
    const taskArn = await this.findTaskArn(workerId);
    if (!taskArn) return; // already gone — idempotent
    await this.ecs.send(new StopTaskCommand({
      cluster: this.clusterArn,
      task: taskArn,
      reason: 'asserts-launcher scale-down',
    }));
  }

  async healthDetails(): Promise<Record<string, unknown>> {
    const list = await this.list();
    return {
      implementation: 'jobnode-launcher/ecs-spawner',
      spawnerBackend: 'aws-ecs-fargate',
      clusterArn: this.clusterArn,
      taskDefinition: this.taskDefinition,
      currentWorkers: list.length,
      maxWorkers: this.maxWorkers,
    };
  }

  private async findTaskArn(workerId: string): Promise<string | null> {
    const tasks = await this.describeOwnTasks();
    const match = tasks.find(t => extractTaskId(t.taskArn) === workerId);
    return match?.taskArn ?? null;
  }

  private async describeOwnTasks(): Promise<Task[]> {
    const arns: string[] = [];
    for (const status of ['RUNNING', 'PENDING'] as const) {
      const list = await this.ecs.send(new ListTasksCommand({
        cluster: this.clusterArn,
        desiredStatus: status,
      }));
      arns.push(...(list.taskArns ?? []));
    }
    if (arns.length === 0) return [];
    const desc = await this.ecs.send(new DescribeTasksCommand({
      cluster: this.clusterArn,
      tasks: arns,
    }));
    // Filter to tasks launched from our family + carrying our launcher tag.
    return (desc.tasks ?? []).filter(t =>
      (t.taskDefinitionArn ?? '').includes(stripRevision(this.taskDefinition))
      && (t.tags ?? []).some(tag => tag.key === 'asserts.launcher' && tag.value === 'job-node')
    );
  }
}

function stripRevision(td: string): string {
  // "asserts-jobnode:7" -> "asserts-jobnode"; ARNs already lack the rev in family form.
  const colon = td.lastIndexOf(':');
  return colon > 0 ? td.slice(0, colon) : td;
}

function isCounted(t: Task): boolean {
  const s = (t.lastStatus ?? '').toUpperCase();
  return s === 'RUNNING' || s === 'PENDING' || s === 'PROVISIONING' || s === 'ACTIVATING';
}

function taskToWorker(t: Task): WorkerRecord {
  return {
    workerId: extractTaskId(t.taskArn) ?? 'unknown',
    state: mapTaskStatus(t.lastStatus),
    startedAt: (t.startedAt ?? t.createdAt ?? new Date()).toISOString(),
  };
}

function extractTaskId(arn: string | undefined): string | null {
  if (!arn) return null;
  const slash = arn.lastIndexOf('/');
  if (slash === -1) return null;
  // ECS task ARN ends with .../<task-id>. Task IDs are 32-char hex.
  return arn.slice(slash + 1);
}

function mapTaskStatus(status: string | undefined): WorkerState {
  switch ((status ?? '').toUpperCase()) {
    case 'RUNNING':       return 'running';
    case 'PENDING':
    case 'PROVISIONING':
    case 'ACTIVATING':    return 'starting';
    case 'DEACTIVATING':
    case 'STOPPING':
    case 'DEPROVISIONING':return 'terminating';
    case 'STOPPED':       return 'failed';
    default:              return 'starting';
  }
}
