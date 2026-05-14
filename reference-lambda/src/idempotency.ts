import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const TEN_MINUTES_SECONDS = 10 * 60;

export interface IdempotencyStore {
  get(requestId: string): Promise<string | null>;
  put(requestId: string, responseJson: string): Promise<void>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, { responseJson: string; expiresAtMs: number }>();
  constructor(private readonly ttlSeconds: number = TEN_MINUTES_SECONDS) {}

  async get(requestId: string): Promise<string | null> {
    const e = this.entries.get(requestId);
    if (!e) return null;
    if (e.expiresAtMs < Date.now()) {
      this.entries.delete(requestId);
      return null;
    }
    return e.responseJson;
  }

  async put(requestId: string, responseJson: string): Promise<void> {
    this.entries.set(requestId, {
      responseJson,
      expiresAtMs: Date.now() + this.ttlSeconds * 1000,
    });
  }
}

export class DynamoIdempotencyStore implements IdempotencyStore {
  private readonly doc: DynamoDBDocumentClient;
  constructor(private readonly tableName: string, private readonly ttlSeconds: number = TEN_MINUTES_SECONDS) {
    this.doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  async get(requestId: string): Promise<string | null> {
    const res = await this.doc.send(new GetCommand({
      TableName: this.tableName,
      Key: { requestId },
      ConsistentRead: true,
    }));
    if (!res.Item) return null;
    const expiresAtSec = res.Item['expiresAt'] as number | undefined;
    if (expiresAtSec !== undefined && expiresAtSec < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return (res.Item['responseJson'] as string) ?? null;
  }

  async put(requestId: string, responseJson: string): Promise<void> {
    const expiresAt = Math.floor(Date.now() / 1000) + this.ttlSeconds;
    await this.doc.send(new PutCommand({
      TableName: this.tableName,
      Item: { requestId, responseJson, expiresAt },
    }));
  }
}

export function makeIdempotencyStore(): IdempotencyStore {
  const tableName = process.env['IDEMPOTENCY_TABLE_NAME'];
  if (tableName && tableName.length > 0) {
    return new DynamoIdempotencyStore(tableName);
  }
  return new InMemoryIdempotencyStore();
}
