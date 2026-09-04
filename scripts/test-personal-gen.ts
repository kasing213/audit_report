// Replicate the confirm-outreach flow for the PERSONAL org, to see whether the
// generation path itself works (isolated from the browser cookie/resolveOrg).
// Creates a personal lead for the test number, then runs generateBatch(personal).
import DatabaseConnection from '../src/database/connection';
import { SalesCaseRepository } from '../src/database/repository';
import { generateBatch } from '../src/outreach/outreach-agent';
import { LeadEventDocument } from '../src/database/models';

const TEST_PHONE = '+85570597666';

(async () => {
  await DatabaseConnection.getInstance().connect();
  const repo = new SalesCaseRepository();
  const today = new Date().toISOString().slice(0, 10);

  // 1. What does getAllCustomers see for each org for this phone (pre-insert)?
  const compBefore = (await repo.getAllCustomers(undefined, 'company')).filter(c => (c.phone || '').includes('597666'));
  const persBefore = (await repo.getAllCustomers(undefined, 'personal')).filter(c => (c.phone || '').includes('597666'));
  console.log(`pre-insert  company sees ${compBefore.length}  personal sees ${persBefore.length}`);

  // 2. Insert a PERSONAL lead (what confirm-outreach does with org=personal).
  const lead: LeadEventDocument = {
    date: today,
    org_id: 'personal',
    customer: { name: 'PersonalTest', phone: TEST_PHONE },
    page: null,
    follower: null,
    status_text: null,
    source: { telegram_msg_id: 'manual-personal-test', model: 'manual-test' },
    created_at: new Date(),
  };
  await repo.saveLeadEvent(lead);
  console.log('inserted personal lead for', TEST_PHONE);

  const persAfter = (await repo.getAllCustomers(undefined, 'personal')).filter(c => (c.phone || '').includes('597666'));
  console.log(`post-insert personal sees ${persAfter.length}`, persAfter.map(c => ({ phone: c.phone, follower: c.follower })));

  // 3. Generate a PERSONAL proposal for it (pending, needs approval).
  const res = await generateBatch({ phones: [TEST_PHONE], orgId: 'personal', limit: 1 });
  console.log('generateBatch(personal) =>', JSON.stringify(res, null, 2));

  await DatabaseConnection.getInstance().disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
