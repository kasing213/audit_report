import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PaymentTemplateRepository,
  PaymentTemplateDocument,
  PaymentTemplateStore,
} from '../../src/payment-tracker/payment-template-repository';
import { renderPaymentTemplate } from '../../src/payment-tracker/payment-template';
import { paymentGroupFixture } from '../helpers/payment-fixtures';

class InMemoryPaymentTemplateStore implements PaymentTemplateStore {
  document: PaymentTemplateDocument | null = null;
  async findOne(): Promise<PaymentTemplateDocument | null> { return this.document; }
  async replaceOne(_filter: { _id: 'payment_tracker' }, document: PaymentTemplateDocument): Promise<void> {
    this.document = structuredClone(document);
  }
}

function makeTemplateRepo(): PaymentTemplateRepository {
  return new PaymentTemplateRepository(
    new InMemoryPaymentTemplateStore(),
    () => new Date('2026-09-03T00:00:00.000Z'),
  );
}

test('saving edited wording clears approval', async () => {
  const store = new InMemoryPaymentTemplateStore();
  const repo = new PaymentTemplateRepository(store, () => new Date('2026-09-03T00:00:00Z'));
  await repo.saveDraft('Pay {{amount_due}} {{currency}} by {{due_date}}', 'developer');
  await repo.approve('developer');
  await repo.saveDraft('Updated {{ar_references}}', 'manager');
  const doc = await repo.get();
  assert.equal(doc?.approved_at, null);
  assert.equal(doc?.approved_by, null);
});

test('approval requires non-empty wording with only supported placeholders', async () => {
  const repo = makeTemplateRepo();
  await assert.rejects(() => repo.approve('developer'), /wording is not configured/);
  await repo.saveDraft('Hello {{unknown}}', 'developer');
  await assert.rejects(() => repo.approve('developer'), /unsupported placeholder: unknown/);
});

test('renderer substitutes deterministic source-backed fields', () => {
  const message = renderPaymentTemplate(
    '{{customer_names}} | {{ar_references}} | {{home_references}} | {{amount_due}} {{currency}} | {{due_date}}',
    paymentGroupFixture(),
  );
  assert.equal(message, 'Sokha / Dara | AR-1, AR-2 | H-1, H-2 | 175 USD | 2026-09-04');
});
