import express, { Request, Response, Router } from 'express';
import { getSessionUser } from './auth-middleware';
import { forecastFromBudget, budgetForNetBookings } from '../lead-control/forecast';
import { CampaignInput, ForecastRevisionInput, SpendInput, SpendMode } from '../lead-control/models';
import { LeadControlRepository, MongoLeadControlRepository } from '../lead-control/repository';
import { CampaignService, normalizeCampaignPageId } from '../lead-control/service';
import { SalesProjectionRepository, SyncSalesService } from '../lead-control/sync-service';
import { SummaryService } from '../lead-control/summary-service';
import { Logger } from '../utils/logger';

export interface LeadControlRouteDependencies {
  service?: CampaignService;
  repository?: LeadControlRepository;
  summaryService?: SummaryService;
  salesService?: Pick<SyncSalesService, 'manuallyAttribute'>;
}

/**
 * Lead Control API. Production creates the Mongo-backed dependencies lazily so
 * the app can still start its HTTP health endpoint before Mongo connects.
 */
export function createLeadControlRouter(dependencies: LeadControlRouteDependencies = {}): Router {
  const router = express.Router();
  const repository = () => dependencies.repository ?? new MongoLeadControlRepository();
  const service = () => dependencies.service ?? new CampaignService(repository());
  const summaryService = () => dependencies.summaryService ?? new SummaryService(repository() as unknown as import('../lead-control/summary-service').SummaryDataRepository);
  const salesService = () => dependencies.salesService ?? new SyncSalesService({ listSalesAfter: async () => [] }, repository() as unknown as SalesProjectionRepository);

  router.use((req, res, next) => {
    const role = getSessionUser(req);
    if (role !== 'developer' && role !== 'manager') {
      res.status(403).json({ error: 'lead control role required' });
      return;
    }
    res.locals.leadControlActor = role;
    next();
  });

  router.get('/campaigns', async (req, res) => {
    try {
      const pageId = queryString(req, 'pageId');
      res.json({ campaigns: await repository().listCampaignsForPage(normalizeCampaignPageId(pageId)) });
    } catch (error) {
      respondError(error, res, 'lead control campaign list failed');
    }
  });

  router.post('/campaigns', async (req, res) => {
    try {
      const campaign = await service().createCampaign(campaignInput(req.body), actor(res));
      res.status(201).json({ campaign });
    } catch (error) {
      respondError(error, res, 'lead control campaign create failed');
    }
  });

  router.get('/campaigns/:id', async (req, res) => {
    try {
      const campaign = await repository().getCampaign(req.params.id);
      if (!campaign) {
        res.status(404).json({ error: 'campaign not found' });
        return;
      }
      res.json({ campaign });
    } catch (error) {
      respondError(error, res, 'lead control campaign read failed');
    }
  });

  router.put('/campaigns/:id', async (req, res) => {
    try {
      res.json({ campaign: await service().updateCampaign(req.params.id, campaignInput(req.body), actor(res)) });
    } catch (error) {
      respondError(error, res, 'lead control campaign update failed');
    }
  });

  router.post('/campaigns/:id/archive', async (req, res) => {
    try {
      res.json({ campaign: await service().archiveCampaign(req.params.id, actor(res)) });
    } catch (error) {
      respondError(error, res, 'lead control campaign archive failed');
    }
  });

  router.post('/campaigns/:id/activate', async (req, res) => {
    try {
      res.json({ campaign: await service().activateCampaign(req.params.id, actor(res)) });
    } catch (error) {
      respondError(error, res, 'lead control campaign activation failed');
    }
  });

  router.delete('/campaigns/:id', async (req, res) => {
    try {
      await service().deleteCampaign(req.params.id, actor(res));
      res.status(204).end();
    } catch (error) {
      respondError(error, res, 'lead control campaign delete failed');
    }
  });

  router.post('/campaigns/:campaignId/forecasts', async (req, res) => {
    try {
      const forecast = await service().createForecastDraft(req.params.campaignId, forecastInput(req.body), actor(res));
      res.status(201).json({ forecast });
    } catch (error) {
      respondError(error, res, 'lead control forecast draft create failed');
    }
  });

  router.put('/forecasts/:id', async (req, res) => {
    try {
      res.json({ forecast: await service().updateForecastDraft(req.params.id, forecastInput(req.body), actor(res)) });
    } catch (error) {
      respondError(error, res, 'lead control forecast draft update failed');
    }
  });

  router.post('/forecasts/:id/approve', async (req, res) => {
    try {
      res.json({ forecast: await service().approveForecast(req.params.id, actor(res)) });
    } catch (error) {
      respondError(error, res, 'lead control forecast approve failed');
    }
  });

  router.post('/forecasts/:id/revisions', async (req, res) => {
    try {
      const forecast = await service().createForecastRevision(req.params.id, forecastInput(req.body), actor(res));
      res.status(201).json({ forecast });
    } catch (error) {
      respondError(error, res, 'lead control forecast revision create failed');
    }
  });

  router.post('/spend/mode-switch', async (req, res) => {
    try {
      const body = objectBody(req.body);
      const campaignId = stringValue(body.campaignId, 'campaignId');
      const month = stringValue(body.month, 'month');
      const targetMode = spendMode(body.targetMode);
      if (typeof body.confirmed !== 'boolean') throw new RangeError('confirmed must be boolean');
      await service().switchSpendMode(campaignId, month, targetMode, body.confirmed, actor(res));
      res.status(204).end();
    } catch (error) {
      respondError(error, res, 'lead control spend mode switch failed');
    }
  });

  router.get('/campaigns/:id/summary', async (req, res) => {
    try {
      res.json({ summary: await summaryService().monthly({ campaignId: req.params.id, month: queryString(req, 'month'), asOf: queryString(req, 'asOf') }) });
    } catch (error) {
      respondError(error, res, 'lead control monthly summary failed');
    }
  });

  router.get('/campaigns/:id/cancellations', async (req, res) => {
    try {
      res.json({ cancellations: await summaryService().cancellations({ campaignId: req.params.id, month: queryString(req, 'month'), view: cancellationView(queryString(req, 'view')) }) });
    } catch (error) {
      respondError(error, res, 'lead control cancellation view failed');
    }
  });

  router.get('/campaigns/:id/revisions', async (req, res) => {
    try {
      res.json({ revisions: await repository().listRevisions(req.params.id, queryString(req, 'month')) });
    } catch (error) {
      respondError(error, res, 'lead control revision history failed');
    }
  });

  router.get('/reconciliation/unmatched', async (_req, res) => {
    try {
      res.json({ sales: await summaryService().unmatchedSales() });
    } catch (error) {
      respondError(error, res, 'lead control unmatched reconciliation failed');
    }
  });

  router.get('/sync/health', async (req, res) => {
    try {
      res.json({ health: await summaryService().syncHealth(queryString(req, 'asOf')) });
    } catch (error) {
      respondError(error, res, 'lead control sync health failed');
    }
  });

  router.post('/sales/:saleId/attribution', async (req, res) => {
    try {
      const body = objectBody(req.body);
      await salesService().manuallyAttribute(req.params.saleId, stringValue(body.campaignId, 'campaignId'), actor(res));
      res.status(204).end();
    } catch (error) {
      respondError(error, res, 'lead control manual sale attribution failed');
    }
  });

  router.post('/spend', async (req, res) => {
    try {
      res.status(201).json({ spend: await service().recordSpend(spendInput(req.body), actor(res)) });
    } catch (error) {
      respondError(error, res, 'lead control spend create failed');
    }
  });

  router.get('/spend', async (req, res) => {
    try {
      const campaignId = queryString(req, 'campaignId');
      const month = queryString(req, 'month');
      res.json({ spends: await service().listSpend(campaignId, month) });
    } catch (error) {
      respondError(error, res, 'lead control spend list failed');
    }
  });

  router.get('/spend/:id', async (req, res) => {
    try {
      res.json({ spend: await service().getSpend(req.params.id) });
    } catch (error) {
      respondError(error, res, 'lead control spend read failed');
    }
  });

  router.put('/spend/:id', async (req, res) => {
    try {
      res.json({ spend: await service().updateSpend(req.params.id, spendInput(req.body), actor(res)) });
    } catch (error) {
      respondError(error, res, 'lead control spend update failed');
    }
  });

  router.delete('/spend/:id', async (req, res) => {
    try {
      await service().deleteSpend(req.params.id, actor(res));
      res.status(204).end();
    } catch (error) {
      respondError(error, res, 'lead control spend delete failed');
    }
  });

  router.post('/calculator/budget-to-results', (req, res) => {
    try {
      const body = funnelInput(req.body);
      res.json({ forecast: forecastFromBudget({ ...body, budgetCents: numberValue(objectBody(req.body).budgetCents, 'budgetCents') }) });
    } catch (error) {
      respondError(error, res, 'lead control budget calculator failed');
    }
  });

  router.post('/calculator/target-to-budget', (req, res) => {
    try {
      const body = funnelInput(req.body);
      res.json({ budgetCents: budgetForNetBookings({ ...body, targetNetBookings: numberValue(objectBody(req.body).targetNetBookings, 'targetNetBookings') }) });
    } catch (error) {
      respondError(error, res, 'lead control target calculator failed');
    }
  });

  return router;
}

function actor(res: Response): 'developer' | 'manager' {
  return res.locals.leadControlActor as 'developer' | 'manager';
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RangeError('request body must be an object');
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new RangeError(`${name} must be a string`);
  return value;
}

function nullableStringValue(value: unknown, name: string): string | null {
  if (value === null) return null;
  return stringValue(value, name);
}

function numberValue(value: unknown, name: string): number {
  if (typeof value !== 'number') throw new RangeError(`${name} must be a number`);
  return value;
}

function campaignInput(value: unknown): CampaignInput {
  const body = objectBody(value);
  return {
    name: stringValue(body.name, 'name'), pageId: stringValue(body.pageId, 'pageId'),
    startsOn: stringValue(body.startsOn, 'startsOn'), endsOn: nullableStringValue(body.endsOn, 'endsOn'),
  };
}

function funnelInput(value: unknown): Omit<ForecastRevisionInput, 'month' | 'monthlyBudgetCents'> {
  const body = objectBody(value);
  return {
    costPerMessageCents: numberValue(body.costPerMessageCents, 'costPerMessageCents'),
    messageToPhoneRate: numberValue(body.messageToPhoneRate, 'messageToPhoneRate'),
    phoneToVisitRate: numberValue(body.phoneToVisitRate, 'phoneToVisitRate'),
    visitToBookingRate: numberValue(body.visitToBookingRate, 'visitToBookingRate'),
    cancellationRate: numberValue(body.cancellationRate, 'cancellationRate'),
  };
}

function forecastInput(value: unknown): ForecastRevisionInput {
  const body = objectBody(value);
  return {
    ...funnelInput(body), month: stringValue(body.month, 'month'), monthlyBudgetCents: numberValue(body.monthlyBudgetCents, 'monthlyBudgetCents'),
  };
}

function spendInput(value: unknown): SpendInput {
  const body = objectBody(value);
  return {
    campaignId: stringValue(body.campaignId, 'campaignId'), month: stringValue(body.month, 'month'),
    businessDate: nullableStringValue(body.businessDate, 'businessDate'), amountCents: numberValue(body.amountCents, 'amountCents'),
  };
}

function spendMode(value: unknown): SpendMode {
  if (value !== 'daily' && value !== 'monthly') throw new RangeError('targetMode must be daily or monthly');
  return value;
}

function cancellationView(value: string): 'cohort' | 'event' {
  if (value !== 'cohort' && value !== 'event') throw new RangeError('view must be cohort or event');
  return value;
}

function queryString(req: Request, name: string): string {
  const value = req.query[name];
  if (typeof value !== 'string') throw new RangeError(`${name} query parameter is required`);
  return value;
}

function respondError(error: unknown, res: Response, context: string): void {
  const message = error instanceof Error ? error.message : 'Internal server error';
  if (error instanceof RangeError || error instanceof TypeError || error instanceof SyntaxError) {
    res.status(400).json({ error: message });
    return;
  }
  if (NOT_FOUND_MESSAGES.has(message)) {
    res.status(404).json({ error: message });
    return;
  }
  if (CONFLICT_MESSAGES.has(message)) {
    res.status(409).json({ error: message });
    return;
  }
  Logger.error(context, error as Error);
  res.status(500).json({ error: 'Internal server error' });
}

const NOT_FOUND_MESSAGES = new Set([
  'campaign not found',
  'forecast revision not found',
  'spend record not found',
]);

const CONFLICT_MESSAGES = new Set([
  'campaign dates overlap an active campaign for this page',
  'only draft campaigns can be activated',
  'archived campaigns cannot be edited',
  'only draft campaigns can be deleted',
  'campaign has protected history and must be archived',
  'baseline already exists; create a revision',
  'approved forecasts are immutable',
  'forecast month cannot be changed',
  'approved forecasts cannot be deleted',
  'forecast must be approved before a revision can be created',
  'forecast revision month must match baseline',
  'daily and monthly spend records are mutually exclusive',
  'an active spend record already exists for this campaign-month date',
  'spend campaign, month, and mode cannot be changed',
  'confirm spend mode switch before replacing records',
]);
