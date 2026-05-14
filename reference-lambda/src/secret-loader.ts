import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

// Resolves the launcher bearer token from one of two sources, in priority order:
//
//   1. LAUNCHER_BEARER_TOKEN_SECRET_ARN  -> fetched from AWS Secrets Manager (production)
//   2. LAUNCHER_BEARER_TOKEN             -> raw value in env var (SAM local, tests, dev)
//
// The resolved value is cached for the lifetime of the Lambda execution
// environment so we only pay the Secrets Manager round trip on cold start.

let cachedToken: string | null = null;

export async function loadBearerToken(): Promise<string> {
  if (cachedToken) return cachedToken;

  const arn = process.env['LAUNCHER_BEARER_TOKEN_SECRET_ARN'];
  if (arn && arn.length > 0) {
    cachedToken = await fetchFromSecretsManager(arn);
    return cachedToken;
  }

  const plain = process.env['LAUNCHER_BEARER_TOKEN'];
  if (plain && plain.length > 0) {
    cachedToken = plain;
    return cachedToken;
  }

  throw new Error('LAUNCHER_BEARER_TOKEN_SECRET_ARN or LAUNCHER_BEARER_TOKEN must be set');
}

export function clearCachedTokenForTest(): void {
  cachedToken = null;
}

async function fetchFromSecretsManager(arn: string): Promise<string> {
  const client = new SecretsManagerClient({});
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (typeof res.SecretString === 'string' && res.SecretString.length > 0) {
    return res.SecretString;
  }
  if (res.SecretBinary) {
    return Buffer.from(res.SecretBinary).toString('utf8');
  }
  throw new Error(`Secret ${arn} has no SecretString or SecretBinary value`);
}
