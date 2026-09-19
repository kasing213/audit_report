export interface InspectedIndex {
  name?: string;
  key?: Record<string, number>;
  unique?: boolean;
  sparse?: boolean;
  partialFilterExpression?: Record<string, unknown>;
}

export interface IndexInspectionDatabase {
  collection(name: string): {
    listIndexes(): { toArray(): Promise<InspectedIndex[]> };
  };
}

export interface MissingLeadControlIndex {
  collection: string;
  index: string;
}

export interface RequiredLeadControlIndex {
  name: string;
  key: Readonly<Record<string, 1 | -1>>;
  unique?: boolean;
  sparse?: boolean;
  partialFilterExpression?: Readonly<Record<string, unknown>>;
}

export const REQUIRED_LEAD_CONTROL_INDEXES: Readonly<Record<string, readonly RequiredLeadControlIndex[]>> = {
  lead_control_campaigns: [
    { name: 'active_page_date_lookup', key: { page_id: 1, status: 1, starts_on: 1, ends_on: 1 } },
    { name: 'same_page_range_guard', key: { page_id: 1, starts_on: 1, ends_on: 1, status: 1 }, unique: true },
  ],
  lead_control_forecast_revisions: [
    { name: 'campaign_month_revision', key: { campaign_id: 1, month: 1, revision_number: 1 }, unique: true },
    { name: 'campaign_month_status', key: { campaign_id: 1, month: 1, status: 1 } },
  ],
  lead_control_spend_records: [
    { name: 'active_spend_record_guard', key: { campaign_id: 1, month: 1, business_date: 1 }, unique: true, partialFilterExpression: { status: 'active' } },
    { name: 'campaign_month_spend_lookup', key: { campaign_id: 1, month: 1, status: 1, mode: 1 } },
  ],
  lead_control_audit_events: [
    { name: 'entity_audit_history', key: { entity_type: 1, entity_id: 1, occurred_at: -1 } },
    { name: 'actor_audit_history', key: { actor: 1, occurred_at: -1 } },
  ],
  lead_control_mutation_guards: [{ name: 'mutation_guard_version', key: { version: 1 } }],
  lead_control_sales_projections: [
    { name: 'sale_id_unique', key: { sale_id: 1 }, unique: true },
    { name: 'phone_booking_lookup', key: { normalized_phone: 1, booking_date: 1 } },
    { name: 'campaign_booking_lookup', key: { campaign_id: 1, booking_date: 1 } },
    { name: 'unmatched_reconciliation_lookup', key: { attribution_kind: 1, updated_at: -1 } },
    { name: 'status_booking_lookup', key: { status: 1, booking_date: 1 } },
    { name: 'status_cancellation_event_lookup', key: { status: 1, cancelled_date: 1 } },
    { name: 'source_updated_cursor_lookup', key: { updated_at: 1, sale_id: 1 } },
  ],
  lead_control_malformed_sales: [{ name: 'malformed_sales_recorded_at', key: { recorded_at: -1 } }],
  lead_control_sales_audit_events: [{ name: 'sale_audit_history', key: { sale_id: 1, occurred_at: -1 } }],
  leads_events: [{ name: 'sale_attribution_normalized_phone_date', key: { normalized_phone: 1, date: -1, created_at: -1 }, sparse: true }],
  daily_summaries: [{ name: 'campaign_month_summary_lookup', key: { campaign_id: 1, date: 1 } }],
};

/** Read Mongo index catalogs and reject absent or structurally unsafe indexes. */
export async function verifyLeadControlIndexes(
  db: IndexInspectionDatabase,
): Promise<{ ok: boolean; missing: MissingLeadControlIndex[] }> {
  const missing: MissingLeadControlIndex[] = [];
  for (const [collection, required] of Object.entries(REQUIRED_LEAD_CONTROL_INDEXES)) {
    const existing = await db.collection(collection).listIndexes().toArray();
    for (const index of required) {
      const candidate = existing.find((actual) => actual.name === index.name);
      if (!candidate || !matchesRequiredIndex(candidate, index)) missing.push({ collection, index: index.name });
    }
  }
  return { ok: missing.length === 0, missing };
}

function matchesRequiredIndex(actual: InspectedIndex, required: RequiredLeadControlIndex): boolean {
  if (!sameOrderedKey(actual.key, required.key)) return false;
  if (Boolean(actual.unique) !== Boolean(required.unique)) return false;
  if (Boolean(actual.sparse) !== Boolean(required.sparse)) return false;
  return normalizedJson(actual.partialFilterExpression ?? null) === normalizedJson(required.partialFilterExpression ?? null);
}

function sameOrderedKey(actual: Record<string, number> | undefined, required: Readonly<Record<string, 1 | -1>>): boolean {
  if (!actual) return false;
  const actualEntries = Object.entries(actual);
  const requiredEntries = Object.entries(required);
  return actualEntries.length === requiredEntries.length
    && actualEntries.every(([key, direction], index) => key === requiredEntries[index][0] && direction === requiredEntries[index][1]);
}

function normalizedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(normalizedJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${normalizedJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
