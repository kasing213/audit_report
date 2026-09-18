import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IndexInspectionDatabase,
  verifyLeadControlIndexes,
} from '../../src/lead-control/index-verification';

const documentedIndexes: Record<string, string[]> = {
  lead_control_campaigns: ['active_page_date_lookup', 'same_page_range_guard'],
  lead_control_forecast_revisions: ['campaign_month_revision', 'campaign_month_status'],
  lead_control_spend_records: ['active_spend_record_guard', 'campaign_month_spend_lookup'],
  lead_control_audit_events: ['entity_audit_history', 'actor_audit_history'],
  lead_control_mutation_guards: ['mutation_guard_version'],
  lead_control_sales_projections: [
    'sale_id_unique', 'phone_booking_lookup', 'campaign_booking_lookup',
    'unmatched_reconciliation_lookup', 'status_booking_lookup',
    'status_cancellation_event_lookup', 'source_updated_cursor_lookup',
  ],
  lead_control_malformed_sales: ['malformed_sales_recorded_at'],
  lead_control_sales_audit_events: ['sale_audit_history'],
  leads_events: ['sale_attribution_normalized_phone_date'],
  daily_summaries: ['campaign_month_summary_lookup'],
};

function fakeDatabase(indexes: Record<string, string[]>): { db: IndexInspectionDatabase; inspected: string[] } {
  const inspected: string[] = [];
  return {
    inspected,
    db: {
      collection: (name: string) => ({
        listIndexes: () => ({
          toArray: async () => {
            inspected.push(name);
            return ['_id_', ...(indexes[name] ?? [])].map((indexName) => ({ name: indexName }));
          },
        }),
      }),
    },
  };
}

// Production mutation caught: pre-release verification silently omits a documented collection or index.
test('index verification inspects every documented named index', async () => {
  const { db, inspected } = fakeDatabase(documentedIndexes);

  assert.deepEqual(await verifyLeadControlIndexes(db), { ok: true, missing: [] });
  assert.deepEqual(inspected.sort(), Object.keys(documentedIndexes).sort());
});

// Production mutation caught: a missing production index is reported as healthy.
test('index verification reports the exact missing collection and index', async () => {
  const withoutCursorIndex = {
    ...documentedIndexes,
    lead_control_sales_projections: documentedIndexes.lead_control_sales_projections.filter(
      (name) => name !== 'source_updated_cursor_lookup',
    ),
  };

  assert.deepEqual(await verifyLeadControlIndexes(fakeDatabase(withoutCursorIndex).db), {
    ok: false,
    missing: [{ collection: 'lead_control_sales_projections', index: 'source_updated_cursor_lookup' }],
  });
});
