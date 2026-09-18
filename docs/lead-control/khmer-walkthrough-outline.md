# ផែនការណែនាំជាភាសាខ្មែរ — Lead Control ក្នុង Audit Sales

## គោលបំណង និងព្រំដែន

នេះជាផែនការថតសម្រាប់ Claude Design ប៉ុណ្ណោះ។ កុំបង្កើត ឬបង្កប់វីដេអូក្នុងឃ្លាំងកូដ។ បង្ហាញថា **Lead Control** ស្ថិតនៅក្នុង Audit Sales ដូចគ្នា (`/lead-control`) មិនបើកកម្មវិធី ឬ browser ថ្មីទេ។ អ្នកប្រើបានតែ `developer` និង `manager`; `agent` មិនអាចចូលបាន។

និយាយច្បាស់ថា Payment Tracker ជាប្រភពសិទ្ធិពិតសម្រាប់ booking, completion និង cancellation។ Lead Control រក្សាទុកតែ projection ក្នុងស្រុក និង attribution ដែលបាន freeze។ លុយទាំងអស់ជា USD cents ហើយថ្ងៃធុរកិច្ចប្រើ `Asia/Phnom_Penh`។

## លំដាប់អេក្រង់ និងចំណុចនិយាយ

1. **ចូល Audit Sales និង navigation bar**
   - បង្ហាញ logo “Audit Sales” និង menu “Lead Control” នៅក្នុង navigation ដដែល។
   - Narration: “នេះគឺជា Lead Control នៅក្នុង Audit Sales មិនមែនជាប្រព័ន្ធថ្មីទេ។ មានសិទ្ធិតែ developer និង manager ប៉ុណ្ណោះ।”

2. **Lead Control workspace — Page name និង Reporting month**
   - បង្ហាញ `Page name`, `Load campaigns`, និង `Reporting month`។ បញ្ចូល page ដែលមានស្រាប់ ហើយជ្រើសខែ។
   - Narration: “ស្វែងរកតាម Page និងខែរាយការណ៍។ កាលបរិច្ឆេទទាំងអស់គិតតាមម៉ោង Phnom Penh។”

3. **Campaign list និង Campaign detail**
   - ចុច campaign មួយ។ បង្ហាញ status, funnel rail: Budget → Messages → Phones → Visits → Bookings → Net។
   - Narration: “ទិន្នន័យពិត និងគោលដៅត្រូវមើលជាជំហានៗ។ Open month មានស្លាក provisional ព្រោះ cancellation អាចមកក្រោយបាន।”

4. **Summary ledger និង Forecast history**
   - បង្ហាញ Monthly plan, Planned to date, Actual spend, Remaining, Pacing variance និងតារាង Forecast / Expected / Actual / Variance / Actual cost / Status។ បន្ទាប់មកបង្ហាញ Baseline និង revision history។
   - Narration: “Baseline ដែល approve រួចមិនអាចកែបានទេ។ ប្រសិនបើត្រូវកែ ត្រូវបង្កើត revision ថ្មី ដើម្បីរក្សាប្រវត្តិ។ លុយត្រូវបញ្ចូលជា USD cents ក្នុង API ហើយ UI បង្ហាញជា USD។”

5. **Cancellations និង Sync health**
   - ប្តូរ dropdown ពី `Booking cohort` ទៅ `Cancellation event month`; បង្ហាញ `Sync health`។
   - Narration: “អាចមើល cancellation តាមខែ booking ឬខែដែល cancel។ `Pending` មានន័យថាមិនទាន់មាន sync cursor; `Stale` មានន័យថាទិន្នន័យចាស់ជាង 24 ម៉ោង។ Sync បើកតែពេល `LEAD_CONTROL_SYNC_ENABLED=true` ហើយ Payment Tracker នៅតែជាប្រភពសិទ្ធិពិត។”

6. **Reconciliation**
   - បង្ហាញ unmatched sale។ ក្នុង read-only mode ប៊ូតុង `Assign to this campaign` ត្រូវបានលាក់។
   - Narration: “ពិនិត្យ sale ក្នុង Payment Tracker ជាមុន។ ប៊ូតុង assign បង្ហាញតែពេល boss អនុម័ត និង `LEAD_CONTROL_WRITES_ENABLED=true`; attribution នឹង freeze ហើយមិនសរសេរទៅ Payment Tracker ទេ।”

7. **Calculator validation (read-only phase)**
   - បង្ហាញ banner `Read-only comparison mode` និង calculator ដែលនៅតែអាចប្រើបាន។ បញ្ចូល `$100`, `$1.50`, និងបង្ហាញ `66.7 messages` ដោយមិន save។
   - Narration: “ឧទាហរណ៍ `$100 ÷ $1.50 = 66.7 messages`។ ក្នុងដំណាក់កាលដំបូង app បិទ write ដោយខ្លួនឯង; យើងប្រៀបធៀបជាមួយ Excel ប៉ុណ្ណោះ។”

8. **Campaign setup wizard — បង្ហាញតែបន្ទាប់ពី boss អនុម័ត**
   - បន្ទាប់ពី deploy ជាមួយ `LEAD_CONTROL_WRITES_ENABLED=true` បង្ហាញលំដាប់ 1. Campaign, 2. Budget, 3. Expectations, 4. Review និងប៊ូតុង `Save draft` / `Save and approve`។
   - Narration: “បន្ទាប់ពី boss បញ្ជាក់ជាលាយលក្ខណ៍អក្សរ និងបើក flag ទើប controls សរសេរបង្ហាញ។ Approval lock baseline; ការកែបន្ទាប់គឺ revision ថ្មី។”

9. **Actual spend**
   - បង្ហាញ Daily និង Monthly total, checkbox សម្រាប់ switch mode, និងប្រវត្តិ status។
   - Narration: “ក្នុងមួយ campaign-month ជ្រើសបានតែ Daily ឬ Monthly មួយប៉ុណ្ណោះ។ ការប្ដូរ mode ត្រូវ confirm ហើយ record ចាស់ត្រូវ archive មិនលុបទេ។”

10. **Archive និងចប់វីដេអូ**
    - បង្ហាញ campaign ដែលមាន approved forecast/spend ជា archived example (មិន hard delete) ហើយត្រឡប់ទៅ sync/reconciliation reminder។
    - Narration: “Campaign ដែលមាន approved forecast ឬ actual spend ត្រូវ archive មិនអាច hard-delete បានទេ។ ប្រសិនបើមានបញ្ហា បិទ write access និងរក្សា audit history សម្រាប់ពិនិត្យឡើងវិញ។”

## Claude Design recording checklist

- [ ] ប្រើ Audit Sales UI ពិត និង URL `/lead-control`; កុំបង្ហាញ tab/app ថ្មី។
- [ ] ថត desktop និង narrow/mobile layout; រក្សា Khmer text អាចអានបាន និង focus state មើលឃើញ។
- [ ] ប្រើតែ sample/sanitized campaign, sale ID និងលេខទូរស័ព្ទ; កុំបង្ហាញ URI, token, database name/secret connection string, ឈ្មោះអតិថិជន ឬលេខទូរស័ព្ទពិត។
- [ ] បង្ហាញ developer/manager access និងពិពណ៌នាថា agent ត្រូវបានបដិសេធ; កុំថត password ឬ session cookie។
- [ ] បង្ហាញ `$100 / $1.50 = 66.7 messages` និងបញ្ជាក់ USD cents នៅពេលនិយាយអំពី API/data handling។
- [ ] បង្ហាញ baseline approved មិនអាច overwrite, revision history, spend mode confirmation, archive-only rule, cancellation views, sync health, និង unmatched reconciliation។
- [ ] សម្រាប់ Phase 1 បង្ហាញ `Read-only comparison mode`; controls សរសេរទាំងអស់ត្រូវបានលាក់ ហើយ calculator/read views នៅប្រើបាន។
- [ ] ប្រសិនបើថត Phase 2 ត្រូវដាក់ title card ថា “Boss confirmation complete” ហើយបង្ហាញតែ test/sanitized data និង audit outcome។
- [ ] បញ្ជាក់ថា scheduler ភ្ជាប់ក្នុង startup ប៉ុន្តែ disabled ជា default; sync ដំណើរការតែពេល `LEAD_CONTROL_SYNC_ENABLED=true` និង credential មានសិទ្ធិ `find`/`listIndexes` លើ `ar_tracker.sales` ប៉ុណ្ណោះ។
- [ ] ពិនិត្យ captions ភាសាខ្មែរ, សំឡេង narration, លំដាប់អេក្រង់ 1–10, និងគ្មានព័ត៌មានសម្ងាត់ មុន approve recording។
