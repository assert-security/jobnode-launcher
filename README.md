# jobnode-launcher

Protocol specification, reference implementation, and adapters for customers who want to host Venari job-node workers inside their own network and have the Assert Security SAAS job-scaler drive their lifecycle on demand.

---

## What's here

| Path | What it is |
|---|---|
| [PROTOCOL.md](PROTOCOL.md) | Canonical wire contract between the Assert job-scaler and your launcher endpoint. Read this first. |
| [CONFORMANCE.md](CONFORMANCE.md) | The checklist your implementation must pass. |
| [conformance/](conformance/) | Conformance test scripts. Point them at your deployed launcher and they exercise every protocol assertion. |
| [reference-lambda/](reference-lambda/) | Working TypeScript implementation deployed via AWS SAM. The Lambda is one option among many — see "Cloud neutrality" below. Spawn step is a clearly-marked stub you replace with your actual scheduler integration. |
| [examples/k8s-spawner/](examples/k8s-spawner/) | Cloud-neutral Kubernetes adapter — works on GKE, EKS, AKS, OpenShift, or on-prem. |
| [examples/cloud-run-spawner/](examples/cloud-run-spawner/) | Google Cloud Run host + GKE spawner — the GCP-native shape. |
| [examples/ecs-spawner/](examples/ecs-spawner/) | AWS ECS RunTask adapter — alternative to k8s for AWS-native shops. |

---

## Cloud neutrality

The wire protocol is HTTPS + JSON + Bearer auth. It has no dependency on any specific cloud. The launcher can live anywhere you can host an HTTPS endpoint with a valid TLS certificate:

| Cloud / runtime | Launcher host | Worker scheduler |
|---|---|---|
| AWS | Lambda + API Gateway (reference), App Runner, ECS service | ECS RunTask, EKS, plain EC2 |
| Google Cloud | Cloud Run, Cloud Functions gen2 | GKE, Cloud Run job, GCE instance |
| Azure | Azure Functions + APIM, Container Apps | AKS, Container Apps, VM |
| Kubernetes anywhere | A Service backed by a Deployment | The same cluster (in-cluster spawner) |
| On-prem / VM | A small service behind nginx or Caddy | Whatever you already use |

The included examples cover the two most common shapes (AWS Lambda, Google Cloud Run) plus a cloud-neutral Kubernetes adapter that works on any conformant cluster. Pick whichever matches your existing operational footprint — there's no "preferred" host.

---

## Who this is for

You're a customer of Assert Security running scans against targets that live inside your network — ServiceNow-internal hosts, customer-private SaaS apps, VPC-internal services, on-prem boxes — that the Assert AWS environment cannot reach.

The Assert SAAS already spins workers up and down for public-target scans. This protocol lets you run the same job-node container yourself, scheduled by whatever runtime you prefer, with Assert driving the launch / terminate decisions based on real demand.

You implement one HTTPS endpoint that fulfills four operations. The Assert job-scaler calls your endpoint when scans queue up; your endpoint runs the Venari job-node container in your environment.

---

## Quick start

1. **Read [PROTOCOL.md](PROTOCOL.md).** It's the contract; everything else is a reference.
2. **Fork or clone this repo.**
3. **Deploy the reference Lambda** to a sandbox environment — see [reference-lambda/README.md](reference-lambda/README.md). It comes with a stub spawner that pretends to launch workers; you'll see the protocol shape working end-to-end before changing any code.
4. **Replace the stub spawner** with your real one. Either reuse `examples/k8s-spawner/` or `examples/ecs-spawner/` directly, or write your own that fulfills the same `Spawner` interface (`reference-lambda/src/spawner.ts`).
5. **Run [`conformance/conformance-test.sh`](conformance/conformance-test.sh)** against your deployment. Every assertion must pass.
6. **Hand the endpoint URL and a freshly-rotated bearer token to your Assert Security operator.** They wire it into your tenant's master configuration so scans start dispatching.

---

## What the launcher does NOT need to know

- The OAuth2 token endpoint. The worker (job-node container) talks to the Assert master directly; the launcher only spawns the worker.
- The list of jobs queued at the master. The Assert side computes demand and tells you `desiredCount`.
- Anything about scan configuration, target URLs, findings, or any product-level concept. You schedule containers; the worker container handles the scan.

This separation is deliberate: the launcher boundary is "schedule a Venari worker process," nothing more. The worker carries its own auth and discovery once it's running.

---

## Licensing

This work is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the full text.

You may fork, modify, and ship this code in your own private or public repos without attribution beyond the license header. You may not strip Assert Security's copyright from files you redistribute unchanged.

---

## Status, support, and contributing

- **Status:** v1 draft. Wire format is stable enough to integrate against.
- **Support:** Contact your Assert Security operator. The protocol itself is documented for self-service; integration-level help comes through your existing support channel.
- **Contributions:** Pull requests welcome — protocol clarifications, additional spawner adapters, language ports. Substantive protocol changes are coordinated with the Assert side and bump the version per [PROTOCOL.md §2](PROTOCOL.md#2-versioning).

---

## Repo TODOs

Outstanding before the first release tag:

- [ ] Confirm license choice (Apache 2.0 vs MIT) with Assert Security leadership and update [LICENSE](LICENSE) if needed
- [ ] Add a `NOTICE` file if any third-party code with attribution requirements ships
- [ ] Add CI workflows: lint, build, conformance smoke against the reference Lambda
- [ ] Issue templates + a CONTRIBUTING.md before opening for external PRs
