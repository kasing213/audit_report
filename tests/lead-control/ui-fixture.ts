import express from 'express';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import { createLeadControlRouter } from '../../src/api/lead-control-routes';
import { SummaryService } from '../../src/lead-control/summary-service';

/** Isolated HTTP fixture. Only persistence and external sales data are stubbed. */
export async function startUiFixture() {
  const app = express(); app.use(express.json());
  const now = new Date();
  const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Phnom_Penh', year: 'numeric', month: '2-digit' }).format(now);
  const campaign = { id: 'c1', name: 'North · ផ្ទះ', pageId: 'north', propertyProject: 'North Residences', objective: 'Property visits', audience: 'Phnom Penh buyers', spendMode: 'daily' as const, startsOn: `${month}-01`, endsOn: null, status: 'active' as const, createdAt: now, createdBy: 'manager', archivedAt: null, archivedBy: null };
  const revision = { id: 'f1', campaignId: 'c1', month, monthlyBudgetCents: 120000, costPerMessageCents: 100, messageToPhoneRate: .3, phoneToVisitRate: .5, visitToBookingRate: .2, cancellationRate: .1, kind: 'baseline' as const, revisionNumber: 1, status: 'approved' as const, createdAt: now, createdBy: 'manager', approvedAt: now, approvedBy: 'manager' };
  const sale = { saleId: 'sale-unmatched', status: 'BOOKED', normalizedPhone: '85512345678', bookingDate: now, completedDate: null, cancelledDate: null, updatedAt: now, campaignId: null, attributedLeadId: null, attributionKind: 'unmatched' as const, attributedAt: null };
  let unmatched = [sale];
  const writes: { campaign: any; forecast: any; approved: boolean } = { campaign: null, forecast: null, approved: false };
  app.get('/lead-control/campaigns', (_req, res) => res.json({ campaigns: [campaign] }));
  app.get('/lead-control/campaigns/:id', (_req, res) => res.json({ campaign }));
  app.get('/lead-control/campaigns/:id/revisions', (_req, res) => res.json({ revisions: [revision] }));
  app.get('/lead-control/spend', (_req, res) => res.json({ spends: [] }));
  app.get('/lead-control/campaigns/:id/cancellations', (req, res) => res.json({ cancellations: [{ ...sale, saleId: `sale-${req.query.view}`, status: 'CANCELLED' }] }));
  app.post('/lead-control/campaigns', (req, res) => { writes.campaign = req.body; res.status(201).json({ campaign: { ...campaign, ...req.body, id: 'c2', status: 'draft' } }); });
  app.put('/lead-control/campaigns/:id', (req, res) => res.json({ campaign: { ...campaign, ...req.body } }));
  app.post('/lead-control/campaigns/:id/forecasts', (req, res) => { writes.forecast = req.body; res.status(201).json({ forecast: { ...revision, ...req.body, id: 'f2', status: 'draft' } }); });
  app.post('/lead-control/forecasts/:id/approve', (_req, res) => { writes.approved = true; res.json({ forecast: { ...revision, id: 'f2' } }); });
  app.post('/lead-control/campaigns/:id/activate', (_req, res) => res.json({ campaign }));
  app.use('/lead-control', createLeadControlRouter({
    summaryService: new SummaryService({ getCampaign: async () => campaign, listRevisions: async () => [revision], listSpend: async () => [{ id: 's1', campaignId: 'c1', month, businessDate: null, mode: 'monthly', amountCents: 48000, status: 'active', createdAt: now, createdBy: 'manager', archivedAt: null, archivedBy: null }], listDailySummaries: async () => [{ date: `${month}-01`, normalized_metrics: { messages: 520, valid_phone_leads: 132, completed_property_visits: 58 } }], listSalesProjections: async () => [{ ...sale, campaignId: 'c1' }], listUnmatchedSales: async () => unmatched, getSalesSyncCursor: async () => ({ updatedAt: now, saleId: 'sale-1' }), countMalformedSales: async () => 0 }),
    salesService: { manuallyAttribute: async () => { unmatched = []; } },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, writes,
    screenshot: (name: string) => path.resolve(`.superpowers/sdd/2026-09-17-lead-control/task-7-${name}.png`),
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
