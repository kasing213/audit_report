# Audit: Wayground AI Chrome Extension

- **Date:** 2026-10-17
- **Target:** Wayground AI (formerly Quizizz), official teacher extension
- **Extension ID:** `jnegnfbcjklhkmoihoakeijbealomipg`
- **Publisher:** Wayground (formerly Quizizz), contact `core@quizizz.com`
- **Version reported:** 4.5.9 (updated 2026-10-15, per store listing)
- **Type:** Desk review (permissions, declared data use, vendor policy). **The source code was not inspected.**
- **Confidence:** Low to medium. Every finding comes from public listings and vendor statements, read through search results. The CRX could not be downloaded from the audit environment, and Chrome Web Store, chrome-stats and the help center could not be fetched directly.

## 1. Summary

The extension is a legitimate first-party product from the vendor. It asks for broad access, and the vendor's privacy promises can only be checked by reading the code.

| Area | Rating | Note |
|---|---|---|
| Publisher authenticity | Low risk | Official vendor, documented on its own help center |
| Permission scope | **High** | `<all_urls>` host access, plus `scripting`, `tabs`, `webNavigation` |
| Declared data collection | Medium | Listing declares "Personally identifiable info" and "Website content" |
| Privacy / compliance claims | Medium | Claims FERPA/COPPA compliance and OpenAI no-training, not independently verified |
| Known incidents | None found | No public breach or vulnerability found for Quizizz/Wayground |
| Impersonation / clones | **High (ecosystem)** | Several third-party "Wayground" cheat extensions exist |

## 2. Permissions (as reported)

| Permission | Purpose stated by vendor | Risk |
|---|---|---|
| `<all_urls>` (host) | Shows the "Create activity" button on any page | **High**: can read and change every site |
| `scripting` | Injects the button and UI into pages | High when combined with `<all_urls>` |
| `tabs` | Reads tab URL and title | Medium: exposes browsing activity |
| `webNavigation` | Detects page loads | Medium: can observe navigation |
| `activeTab` | Access to the current tab on click | Low |
| `sidePanel` | Opens the Wayground UI in the side panel | Low |
| `alarms` | Background scheduling | Low |

**Permission history (third-party record):**
- `sidePanel` added in v2.0.1 (2026-03-25)
- `<all_urls>` added in v4.0.2 (2026-04-23)

The scope widened from click-to-use (`activeTab`) to always-on access to every site. chrome-stats rates the risk impact "high".

## 3. Data handling claims (vendor, not verified)

- Reads page content only when the teacher selects text, clicks the button or opens the side panel.
- Collects no browsing history and no student data from student sessions.
- Data is not sold. It is shared only with processors needed to run the service.
- Content is sent to OpenAI, which per the vendor does not train on personal data.
- Data is hosted on AWS and encrypted in transit. The vendor keeps a written breach response plan.
- The general privacy policy also covers device IDs, log data, IP-based location and Google Analytics.

**Gap:** with `<all_urls>` and `tabs`/`webNavigation`, the extension is technically able to watch every page. "Reads only on click" is a design promise that the permissions do not enforce.

## 4. Findings

1. **F1 – Over-broad host access (High).** `<all_urls>` exists only so the button can appear everywhere. `activeTab` plus a context-menu entry or the side panel would cover the core use without standing access.
2. **F2 – Unverified on-demand reading (Medium).** The vendor's "reads only on click" claim needs code review: check the content-script `matches` and `run_at`, plus any `tabs`/`webNavigation` listeners that send URLs to the backend.
3. **F3 – Page content sent to a third-party LLM (Medium).** Pages the teacher selects (Docs, articles, YouTube) go to OpenAI. Teachers should not use it on pages that show student PII, such as a gradebook or SIS.
4. **F4 – Silent permission expansion (Medium).** Host access was widened in v4.0.2. On managed devices, force-installed extensions can gain permissions without the user being prompted.
5. **F5 – Clone and cheat extensions (High, ecosystem).** "Wayground Hacker", "Wbypass" and "Wayground Genie" use the brand and advertise auto-answering or anti-cheat bypass. Their publishers are unverified. They target students and are a common malware vector.

## 5. Recommendations (schools / admins)

- Allow-list only `jnegnfbcjklhkmoihoakeijbealomipg`, and only for **teacher** OUs. The vendor says it is for teachers only.
- Use the Chrome policy `runtime_blocked_hosts` to block the extension on SIS, gradebook, email and HR domains.
- Block-list the known clone IDs: `pnjfcoaceclffhplgepbmgplkikfaonk`, `nfjkdhoijjdddgjnfoephbhbfkfgphaj` (Wayground Hacker), `jppmfeoookoglcpnhkonmjabknddmjpg` (Wbypass), `chldieemkpccpncobdkkppbfoggbignd` (Wayground Genie).
- Sign the state or district DPA/SDPA that Wayground offers before deploying.
- Re-review whenever the extension's permissions change.

## 6. Next step to raise confidence

Download the CRX (`clients2.google.com/service/update2/crx?...&x=id%3Djnegnfbcjklhkmoihoakeijbealomipg%26uc`) and review:
`manifest.json` (permissions, CSP, `externally_connectable`, `web_accessible_resources`), the content-script triggers, background network endpoints, any remote code or `eval` use, and which data is sent to which domains.
This requires allowing `clients2.google.com` / `clients2.googleusercontent.com` in the environment's network policy.

## 7. Sources

- Chrome Web Store, Wayground AI: https://chromewebstore.google.com/detail/wayground-ai/jnegnfbcjklhkmoihoakeijbealomipg
- chrome-stats (permissions, history, risk): https://chrome-stats.com/d/jnegnfbcjklhkmoihoakeijbealomipg
- Wayground Help, Deploying the extension: https://help.wayground.com/support/solutions/articles/158000405029-deploying-the-wayground-ai-chrome-extension
- Wayground Help, FAQ: https://help.wayground.com/support/solutions/articles/158000453412-frequently-asked-questions
- Wayground Help, Deploy for school/district: https://help.wayground.com/support/solutions/articles/158000453414-deploy-wayground-ai-for-your-school-or-district
- Wayground Help, How Wayground protects student data: https://help.wayground.com/support/solutions/articles/158000404026-how-does-wayground-protect-student-data-
- Wayground Help, State and district privacy agreements: https://help.wayground.com/support/solutions/articles/158000404016-state-and-district-privacy-agreements
- Wayground Privacy Policy: https://wayground.com/privacy
- THE Journal, Quizizz rebrands as Wayground (2025-06-24): https://thejournal.com/Articles/2025/06/24/Quizizz-Rebrands-as-Wayground-Announces-New-AI-Features.aspx
- Clone listings: https://chromewebstore.google.com/detail/wayground-hacker/nfjkdhoijjdddgjnfoephbhbfkfgphaj, https://chromeboard.com/extension/wayground-hacker-pnjfcoaceclffhplgepbmgplkikfaonk, https://chromeboard.com/extension/wbypass-jppmfeoookoglcpnhkonmjabknddmjpg, https://chromewebstore.google.com/detail/wayground-genie-%E2%80%93-answers/chldieemkpccpncobdkkppbfoggbignd
- Chrome permissions reference: https://developer.chrome.com/docs/extensions/reference/permissions-list
