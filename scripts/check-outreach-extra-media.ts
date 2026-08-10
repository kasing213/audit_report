/**
 * Verification for the outreach "extra media" feature (Add image / Add
 * video buttons + shared 50MB budget). Exercises real repositories and
 * routes against the dev database — NEVER calls the primary replace routes
 * (POST /default-image, POST /default-video) since those would overwrite
 * live production branding for the company/personal orgs. Only touches
 * 'extra' docs it creates itself, and deletes them all before exiting.
 *
 * Usage: npx ts-node scripts/check-outreach-extra-media.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import DatabaseConnection from '../src/database/connection';
import { OutreachImagesRepository } from '../src/outreach/outreach-images-repository';
import { OutreachVideoRepository } from '../src/outreach/outreach-video-repository';
import { getMediaUsage, checkBudget, MEDIA_BUDGET_BYTES } from '../src/outreach/outreach-media-budget';
import { ObjectId } from 'mongodb';
import express from 'express';
import outreachRoutes from '../src/api/outreach-routes';

const TEST_ORG = 'company';
let failures = 0;
const cleanup: Array<() => Promise<void>> = [];

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

async function main(): Promise<void> {
  const db = DatabaseConnection.getInstance();
  await db.connect();

  const imagesRepo = new OutreachImagesRepository();
  const videoRepo = new OutreachVideoRepository();

  // --- Task 1: repository layer ---
  const baseline = await getMediaUsage(TEST_ORG);
  console.log(`baseline usage for ${TEST_ORG}: ${baseline.totalBytes} / ${baseline.budgetBytes} bytes`);

  const imgBuf = Buffer.from('fake-jpeg-bytes-for-testing');
  const imgId = await imagesRepo.addExtra({
    filename: 'test-extra.jpg',
    mime_type: 'image/jpeg',
    buffer: imgBuf,
    uploaded_by: 'check-script',
  }, TEST_ORG);
  cleanup.push(async () => { await imagesRepo.removeExtra(imgId); });

  const listedImages = await imagesRepo.listExtras(TEST_ORG);
  check('extra image appears in listExtras', listedImages.some((d) => String(d._id) === String(imgId)), true);

  const imageBytesAfterAdd = await imagesRepo.sumExtraBytes(TEST_ORG);
  check('sumExtraBytes reflects the added image', imageBytesAfterAdd, imgBuf.length);

  const usageAfterImage = await getMediaUsage(TEST_ORG);
  check('getMediaUsage total grows by the image size', usageAfterImage.totalBytes, baseline.totalBytes + imgBuf.length);

  const removedImage = await imagesRepo.removeExtra(imgId);
  check('removeExtra reports success', removedImage, true);
  const usageAfterImageRemove = await getMediaUsage(TEST_ORG);
  check('getMediaUsage returns to baseline after removing the extra image', usageAfterImageRemove.totalBytes, baseline.totalBytes);
  cleanup.pop(); // already removed above, no double-cleanup needed

  const overBudget = await checkBudget(TEST_ORG, MEDIA_BUDGET_BYTES + 1);
  check('checkBudget rejects a file larger than the whole budget', overBudget.ok, false);

  const wayOverBudget = await checkBudget(TEST_ORG, MEDIA_BUDGET_BYTES * 2);
  check('checkBudget reports the attempted size on rejection', !wayOverBudget.ok && wayOverBudget.attemptedBytes, MEDIA_BUDGET_BYTES * 2);

  const smallOk = await checkBudget(TEST_ORG, 100);
  check('checkBudget allows a small file when far under budget', smallOk.ok, true);

  // A fake ObjectId lookup returns null cleanly (no throw) for video extras.
  const missingVideoRemove = await videoRepo.removeExtra(new ObjectId());
  check('removeExtra returns null for a non-existent id', missingVideoRemove, null);

  // --- Task 2: route layer (extra images) ---
  if (!process.env.DASHBOARD_TOKEN) process.env.DASHBOARD_TOKEN = 'check-script-dashboard-token';
  const app = express();
  app.use('/crm/api/outreach', outreachRoutes);
  const server = await new Promise<import('http').Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind check server');
  const base = `http://127.0.0.1:${address.port}/crm/api/outreach`;
  const authHeaders = { Authorization: `Bearer ${process.env.DASHBOARD_TOKEN}` };

  try {
    const fd = new FormData();
    fd.append('file', new Blob([imgBuf], { type: 'image/jpeg' }), 'route-test.jpg');
    const addResp = await fetch(`${base}/default-image/extra?org=${TEST_ORG}`, {
      method: 'POST',
      headers: authHeaders,
      body: fd,
    });
    check('POST default-image/extra status', addResp.status, 200);
    const added = await addResp.json() as any;
    check('POST default-image/extra returns an id', typeof added.id === 'string' && added.id.length > 0, true);

    const listResp = await fetch(`${base}/default-image/extra?org=${TEST_ORG}`, { headers: authHeaders });
    const list = await listResp.json() as any[];
    check('GET default-image/extra lists the added item', list.some((d: any) => d.id === added.id), true);

    const bytesResp = await fetch(`${base}/default-image/extra/${added.id}`, { headers: authHeaders });
    check('GET default-image/extra/:id status', bytesResp.status, 200);
    const bytes = Buffer.from(await bytesResp.arrayBuffer());
    check('GET default-image/extra/:id returns the uploaded bytes', bytes.equals(imgBuf), true);

    const delResp = await fetch(`${base}/default-image/extra/${added.id}`, { method: 'DELETE', headers: authHeaders });
    check('DELETE default-image/extra/:id status', delResp.status, 200);
    const delBody = await delResp.json() as any;
    check('DELETE default-image/extra/:id reports removed', delBody.removed, true);

    const bytesAfterDelete = await fetch(`${base}/default-image/extra/${added.id}`, { headers: authHeaders });
    check('extra image is gone after delete', bytesAfterDelete.status, 404);

    const r2Configured = Boolean(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY && process.env.R2_SECRET_KEY && process.env.R2_BUCKET);
    if (r2Configured) {
      const vidBuf = Buffer.from('fake-mp4-bytes-for-testing');
      const vfd = new FormData();
      vfd.append('file', new Blob([vidBuf], { type: 'video/mp4' }), 'route-test.mp4');
      const vAddResp = await fetch(`${base}/default-video/extra?org=${TEST_ORG}`, { method: 'POST', headers: authHeaders, body: vfd });
      check('POST default-video/extra status', vAddResp.status, 200);
      const vAdded = await vAddResp.json() as any;

      const vListResp = await fetch(`${base}/default-video/extra?org=${TEST_ORG}`, { headers: authHeaders });
      const vList = await vListResp.json() as any[];
      check('GET default-video/extra lists the added item', vList.some((d: any) => d.id === vAdded.id), true);

      const vDelResp = await fetch(`${base}/default-video/extra/${vAdded.id}`, { method: 'DELETE', headers: authHeaders });
      check('DELETE default-video/extra/:id status', vDelResp.status, 200);
    } else {
      console.log('SKIP  extra-video route checks (R2 env vars not set in this environment)');
    }

    const usageResp2 = await fetch(`${base}/default-media/usage?org=${TEST_ORG}`, { headers: authHeaders });
    check('GET default-media/usage status', usageResp2.status, 200);
    const usageBody = await usageResp2.json() as any;
    check('GET default-media/usage returns budget_bytes', usageBody.budget_bytes, MEDIA_BUDGET_BYTES);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }

  // Cleanup any leftovers (defensive — steps above already clean as they go).
  for (const fn of cleanup) await fn();

  await db.disconnect();

  if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nPASS  all outreach extra-media checks');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
