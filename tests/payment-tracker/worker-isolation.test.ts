import test from 'node:test';
import assert from 'node:assert/strict';
import express, { Express, Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { requireWorkerOrg, workerOrg } from '../../src/outreach/worker-org-middleware';
import {
  FailureAlertPort,
  SalesSideEffectsPort,
  WorkerProposalService,
} from '../../src/outreach/worker-proposal-service';
import { defaultState } from '../../src/outreach/outreach-worker-state-repository';
import { OutreachProposalDocument, OutreachStatus } from '../../src/outreach/outreach-repository';
import { OrgId } from '../../src/outreach/orgs';
import { mapPaymentProposal } from '../../src/payment-tracker/payment-proposal-mapper';
import { InMemoryPaymentProposalStore } from '../helpers/proposal-store';
import { InMemoryWorkerStateRepository } from '../helpers/worker-state-store';
import { NOW, paymentGroupFixture } from '../helpers/payment-fixtures';
import { request } from '../helpers/http';

const COMPANY_ID = '64b000000000000000000001';
const PERSONAL_ID = '64b000000000000000000002';
const PAYMENT_ID = '64b000000000000000000003';

function runWorkerOrgMiddleware(header: unknown) {
  const req = { headers: { 'x-org-id': header } } as unknown as Request;
  const locals: Record<string, unknown> = {};
  let status = 200;
  const res = {
    locals,
    status(code: number) { status = code; return this; },
    json() { return this; },
  } as unknown as Response;
  requireWorkerOrg(req, res, () => undefined);
  return { status, locals };
}

function proposalFixture(id: string, org: OrgId, status: OutreachStatus): OutreachProposalDocument {
  return {
    _id: new ObjectId(id),
    org_id: org,
    generation_id: 'gen-1',
    customer_phone: '+85512345678',
    customer_name: 'Sales Lead',
    reason_code: 'stale',
    days_since_contact: 60,
    follower: 'kasing',
    message: 'hello',
    reasoning: 'stale lead',
    status,
    skipped_reason: null,
    failed_reason: null,
    custom_image_id: null,
    created_at: NOW,
    approved_at: NOW,
    approved_by: 'developer',
    sent_at: null,
    lease_expires_at: null,
    model: 'gpt-test',
  };
}

function paymentProposalFixture(id: string, status: OutreachStatus): OutreachProposalDocument {
  return {
    ...mapPaymentProposal(paymentGroupFixture(), 'payment reminder', false, NOW),
    _id: new ObjectId(id),
    status,
  };
}

function seedCompanyPersonalAndPaymentProposals(options: { paymentStatus?: OutreachStatus } = {}) {
  return new InMemoryPaymentProposalStore([
    proposalFixture(COMPANY_ID, 'company', 'approved'),
    proposalFixture(PERSONAL_ID, 'personal', 'approved'),
    paymentProposalFixture(PAYMENT_ID, options.paymentStatus ?? 'in_flight'),
  ]);
}

const makeWorkerState = (initial: { deliveries_today: number; delivery_reservations: number }) =>
  new InMemoryWorkerStateRepository(initial, () => NOW);

/** Records every sales side effect so a test can assert none of them ran. */
class RecordingSalesSideEffects implements SalesSideEffectsPort {
  calls: Array<{ method: string; orgId: OrgId }> = [];
  async recordDelivery(orgId: OrgId) { this.calls.push({ method: 'recordDelivery', orgId }); }
  async releaseClaim(orgId: OrgId) { this.calls.push({ method: 'releaseClaim', orgId }); }
  async recordContacted(_p: OutreachProposalDocument, orgId: OrgId) { this.calls.push({ method: 'recordContacted', orgId }); }
  async recordFailure(_p: OutreachProposalDocument, orgId: OrgId) { this.calls.push({ method: 'recordFailure', orgId }); return 'privacy'; }
  async saveLeadEvent(_p: OutreachProposalDocument, orgId: OrgId) { this.calls.push({ method: 'saveLeadEvent', orgId }); }
  async logAudit() { this.calls.push({ method: 'logAudit', orgId: 'n/a' }); }
}

class RecordingAlerts implements FailureAlertPort {
  entries: Array<{ proposalId: string; kind: string; reason: string }> = [];
  async notifyFailure(proposal: OutreachProposalDocument, kind: string, reason: string) {
    this.entries.push({ proposalId: String(proposal._id), kind, reason });
  }
}

/**
 * A minimal app wired exactly as production wires the worker routes:
 * requireWorkerOrg, then handlers that use only the declared workspace.
 */
function createWorkerTestApp(service: WorkerProposalService): Express {
  const app = express();
  app.use(express.json());
  app.use(requireWorkerOrg);

  app.get('/:id/effective-media', async (req: Request, res: Response) => {
    const proposal = await service.ownedProposal(req.params.id, workerOrg(res));
    if (!proposal) { res.status(404).json({ error: 'proposal not found' }); return; }
    res.json({ media: [] });
  });
  app.get('/:id/effective-image', async (req: Request, res: Response) => {
    const proposal = await service.ownedProposal(req.params.id, workerOrg(res));
    if (!proposal) { res.status(404).json({ error: 'proposal not found' }); return; }
    res.json({ ok: true });
  });
  app.post('/:id/mark-sent', async (req: Request, res: Response) => {
    const result = await service.markSent(req.params.id, workerOrg(res));
    if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
    res.json({ ok: true });
  });
  app.post('/:id/mark-failed', async (req: Request, res: Response) => {
    const result = await service.markFailed(req.params.id, workerOrg(res), req.body?.reason ?? 'test');
    if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
    res.json({ ok: true });
  });
  return app;
}

function makeOutreachTestApp(store: InMemoryPaymentProposalStore) {
  // Key by the live ObjectId before cloning: structuredClone turns an ObjectId
  // into a plain buffer object, so String(_id) on a clone is not the hex id.
  const originals = new Map(store.documents.map((d) => [String(d._id), structuredClone(d)]));
  const service = new WorkerProposalService({
    proposals: store,
    workerState: makeWorkerState({ deliveries_today: 0, delivery_reservations: 0 }),
    sales: new RecordingSalesSideEffects(),
    alerts: new RecordingAlerts(),
    clock: () => NOW,
  });
  return {
    app: createWorkerTestApp(service),
    snapshot: (id: string) => structuredClone(store.documents.find((d) => String(d._id) === id)),
    original: (id: string) => originals.get(id),
  };
}

function paymentFailureRouteFixture() {
  const proposals = new InMemoryPaymentProposalStore([paymentProposalFixture(PAYMENT_ID, 'in_flight')]);
  const sales = new RecordingSalesSideEffects();
  const alerts = new RecordingAlerts();
  const workerState = makeWorkerState({ deliveries_today: 0, delivery_reservations: 1 });
  const service = new WorkerProposalService({ proposals, workerState, sales, alerts, clock: () => NOW });
  return {
    workerState,
    salesSuppressions: sales.calls,
    alerts: alerts.entries,
    markFailed: (id: string, org: OrgId, reason: string) => service.markFailed(id, org, reason),
  };
}

test('agent request without one valid X-Org-Id is rejected instead of using Company', () => {
  assert.equal(runWorkerOrgMiddleware(undefined).status, 400);
  assert.equal(runWorkerOrgMiddleware('invalid').status, 400);
  assert.equal(runWorkerOrgMiddleware(['company']).status, 400);
  assert.equal(runWorkerOrgMiddleware('payment_tracker').locals.workerOrg, 'payment_tracker');
});

test('Payment worker cannot read media or mutate Company and Personal proposals', async () => {
  const fixture = makeOutreachTestApp(seedCompanyPersonalAndPaymentProposals());
  for (const id of [COMPANY_ID, PERSONAL_ID]) {
    assert.equal((await request(fixture.app, 'GET', `/${id}/effective-media`, 'payment_tracker')).status, 404);
    assert.equal((await request(fixture.app, 'GET', `/${id}/effective-image`, 'payment_tracker')).status, 404);
    assert.equal((await request(fixture.app, 'POST', `/${id}/mark-sent`, 'payment_tracker')).status, 404);
    assert.equal((await request(fixture.app, 'POST', `/${id}/mark-failed`, 'payment_tracker', { reason: 'test' })).status, 404);
  }
  assert.deepEqual(fixture.snapshot(COMPANY_ID), fixture.original(COMPANY_ID));
  assert.deepEqual(fixture.snapshot(PERSONAL_ID), fixture.original(PERSONAL_ID));
});

test('two concurrent Payment reservations cannot exceed successful-delivery cap', async () => {
  const state = makeWorkerState({ deliveries_today: 14, delivery_reservations: 0 });
  const granted = await Promise.all([
    state.tryReservePaymentDelivery('payment_tracker', 15, NOW),
    state.tryReservePaymentDelivery('payment_tracker', 15, NOW),
  ]);
  assert.equal(granted.filter(Boolean).length, 1);
});

test('Payment mark failed releases reservation without writing sales phone suppression', async () => {
  const fixture = paymentFailureRouteFixture();
  await fixture.markFailed(PAYMENT_ID, 'payment_tracker', 'privacy');
  assert.equal(fixture.workerState.delivery_reservations, 0);
  assert.equal(fixture.salesSuppressions.length, 0);
  assert.deepEqual(fixture.alerts, [{ proposalId: PAYMENT_ID, kind: 'mark-failed', reason: 'privacy' }]);
});

test('Payment mark sent counts a delivery without creating a sales lead event', async () => {
  const proposals = new InMemoryPaymentProposalStore([paymentProposalFixture(PAYMENT_ID, 'in_flight')]);
  const sales = new RecordingSalesSideEffects();
  const workerState = makeWorkerState({ deliveries_today: 0, delivery_reservations: 1 });
  const service = new WorkerProposalService({ proposals, workerState, sales, alerts: new RecordingAlerts(), clock: () => NOW });
  assert.equal((await service.markSent(PAYMENT_ID, 'payment_tracker')).ok, true);
  assert.equal(workerState.deliveries_today, 1);
  assert.equal(workerState.delivery_reservations, 0);
  assert.equal(sales.calls.length, 0);
});

test('Payment worker state starts paused while sales worker defaults stay unchanged', () => {
  assert.equal(defaultState('payment_tracker').paused, true);
  assert.equal(defaultState('company').paused, false);
  assert.equal(defaultState('personal').paused, false);
});

test('heartbeat and inbound reject a missing or invalid workspace header', async () => {
  // These are agentOnly routes: unlike the media/mark routes they have no
  // browser caller at all, so requireWorkerOrg runs unconditionally and a
  // worker that forgets the header must fail rather than beat for Company.
  const app = express();
  app.use(express.json());
  app.post('/worker-heartbeat', requireWorkerOrg, (_req, res) => { res.json({ ok: true }); });
  app.post('/report-inbound', requireWorkerOrg, (_req, res) => { res.json({ ok: true }); });

  for (const path of ['/worker-heartbeat', '/report-inbound']) {
    assert.equal((await request(app, 'POST', path, undefined, {})).status, 400);
    assert.equal((await request(app, 'POST', path, 'not-a-workspace', {})).status, 400);
    assert.equal((await request(app, 'POST', path, 'payment_tracker', {})).status, 200);
    assert.equal((await request(app, 'POST', path, 'company', {})).status, 200);
  }
});
