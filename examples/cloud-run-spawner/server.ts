// Cloud Run entry point. Wraps the protocol handler from the reference Lambda
// in a small Express adapter so it runs on any Node.js HTTP host.
//
// Adapts API Gateway's APIGatewayProxyEventV2 shape to/from Express req/res.
// The handler itself is unchanged — protocol concerns are isolated from
// transport.
//
// Required NPM deps to add:
//   "express": "^4.18.0"
//   "@types/express": "^4.17.0"

import express, { type Request, type Response } from 'express';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { handler } from '../../reference-lambda/src/handler';

const app = express();
app.use(express.json({ limit: '64kb' }));

app.all('*', async (req: Request, res: Response) => {
  const event = toApiGatewayEvent(req);
  const result = await handler(event);
  const r = result as Exclude<APIGatewayProxyResultV2, string>;
  res.status(r.statusCode ?? 200);
  for (const [k, v] of Object.entries(r.headers ?? {})) {
    res.setHeader(k, String(v));
  }
  if (r.body !== undefined && r.body !== '') {
    res.send(r.body);
  } else {
    res.end();
  }
});

const port = Number(process.env['PORT'] ?? 8080);
app.listen(port, () => {
  console.log(JSON.stringify({ event: 'launcher_started', port }));
});

function toApiGatewayEvent(req: Request): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: req.path,
    rawQueryString: req.url.includes('?') ? req.url.split('?')[1] ?? '' : '',
    headers: Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(',') : v ?? ''])
    ),
    requestContext: {
      accountId: '0',
      apiId: 'cloud-run',
      domainName: req.hostname,
      domainPrefix: req.hostname.split('.')[0] ?? 'launcher',
      http: {
        method: req.method,
        path: req.path,
        protocol: req.protocol,
        sourceIp: req.ip ?? '0.0.0.0',
        userAgent: req.headers['user-agent'] ?? '',
      },
      requestId: req.headers['x-cloud-trace-context']?.toString() ?? Math.random().toString(36).slice(2),
      routeKey: '$default',
      stage: '$default',
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
    isBase64Encoded: false,
    body: req.body !== undefined && Object.keys(req.body).length > 0 ? JSON.stringify(req.body) : undefined,
  } as APIGatewayProxyEventV2;
}
