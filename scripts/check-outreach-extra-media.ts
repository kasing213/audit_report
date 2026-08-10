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
