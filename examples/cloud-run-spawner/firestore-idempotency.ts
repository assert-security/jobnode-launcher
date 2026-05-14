// Firestore-backed IdempotencyStore for Cloud Run deployments. Equivalent to
// the reference DynamoDB store — keyed on requestId with TTL-driven cleanup.
//
// To enable Firestore TTL cleanup, configure a TTL policy on the `expiresAt`
// field of the collection:
//   gcloud firestore fields ttls update expiresAt --collection-group=asserts-launcher-idempotency --enable-ttl
//
// Required NPM deps to add:
//   "@google-cloud/firestore": "^7.5.0"

import { Firestore, Timestamp } from '@google-cloud/firestore';
import type { IdempotencyStore } from '../../reference-lambda/src/idempotency';

const TEN_MINUTES_SECONDS = 10 * 60;

export class FirestoreIdempotencyStore implements IdempotencyStore {
  private readonly db: Firestore;
  constructor(
    private readonly collectionName: string = 'asserts-launcher-idempotency',
    private readonly ttlSeconds: number = TEN_MINUTES_SECONDS,
  ) {
    this.db = new Firestore();
  }

  async get(requestId: string): Promise<string | null> {
    const doc = await this.db.collection(this.collectionName).doc(requestId).get();
    if (!doc.exists) return null;
    const data = doc.data();
    if (!data) return null;
    const expiresAt = data['expiresAt'] as Timestamp | undefined;
    if (expiresAt && expiresAt.toMillis() < Date.now()) return null;
    return (data['responseJson'] as string) ?? null;
  }

  async put(requestId: string, responseJson: string): Promise<void> {
    await this.db.collection(this.collectionName).doc(requestId).set({
      responseJson,
      expiresAt: Timestamp.fromMillis(Date.now() + this.ttlSeconds * 1000),
    });
  }
}
