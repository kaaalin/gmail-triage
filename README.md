# Gmail email triage agent (Google Apps Script + Claude API)

A Gmail triage agent for a shared airport inbox (Sofia Airport "Vasil Levski"). Every five minutes it reads new
inbox messages, asks Claude (sonnet 5.5) to classify each one, writes **one row per Gmail message ID** to a Google Sheet, and
applies **six labels** to the original message. It never replies, forwards, moves, archives or deletes mail.

Despite the fact that for Sofia Airport the right architecture should be probably with MS Copilot, Power automate and Outlook, I chose to implement on Gmail (due to available accounts) + Claude model (as more familiar to me). The code was written through OpenAI generated prompts for Claude to complete the scripts.

The solution is just an example. It is not synced with the enterprise software of Sofia Airport, nor it is data protection regulations (such as GDPR) compliant.

If we assume the 40 questions representable of the daily received email volume (~20 daily) it costs about $9 a month, and at 10× volume (200 a day) about $37 a month, so cost grows about 4× rather than 10×. The agent would handle successfully 120 emails an hour with the current batch size setting, so a concentrated 10× peak is absorbed within an hour or two. A backlog above 300 unread messages would be skipped, and a gmail.com account’s trigger-runtime quota caps it at roughly 750 emails a day.

This repository is meant to be **reproduced**, not just read: the prompts, configuration exports, flow
definitions and scripts are all here, and a CI check keeps them consistent with the code.

## What is where

| You asked for | Where it is | How to reproduce or check it |
|---|---|---|
| **Prompts** | [`prompts/system_prompt.txt`](prompts/system_prompt.txt) (runtime system prompt), [`prompts/response_schema.json`](prompts/response_schema.json) (tool schema), [`prompts/example_request.json`](prompts/example_request.json) (exact request body for one email) | `npm run check:exports` fails if they differ from `src/Code.gs` |
| **Configuration exports** | [`config/taxonomy.json`](config/taxonomy.json) (categories, owners, urgencies, 13 output columns), [`config/signatures.json`](config/signatures.json) (EN/BG signature per owner), [`config/runtime-settings.json`](config/runtime-settings.json), [`config/label-scheme.example.json`](config/label-scheme.example.json), [`config/script-properties.example.json`](config/script-properties.example.json) (names only, no secrets), [`src/appsscript.json`](src/appsscript.json) (manifest, scopes, Gmail service) | same check |
| **Flow definitions** | [`flows/triage-flow.json`](flows/triage-flow.json) (machine-readable) and [`flows/README.md`](flows/README.md) (diagrams, error policy) | `npm run check:flows` verifies functions and limits against the code and that no send/forward/delete calls exist |
| **Scripts** | [`src/Code.gs`](src/Code.gs) (the agent), [`scripts/`](scripts) (export, rebuild, verify, live classify), [`tests/`](tests) | see below |

```
src/Code.gs                the Apps Script agent (single source of truth)
src/appsscript.json        manifest: time zone, Gmail advanced service, OAuth scopes
prompts/                   runtime prompt, tool schema, example request   (generated from Code.gs)
config/                    taxonomy, signatures, runtime settings, label scheme, properties template (generated)
flows/                     flow definition (JSON) + Mermaid diagrams
scripts/                   export.js, check-flows.js, build-reference.js, verify-output.js, classify-with-api.js
tests/                     mock_tests.js (Gmail/Sheets/Claude mocks), pipeline_tests.js (scripts + local mock API)
data/input/                the 40 practice emails (columns A-G)
data/worked_examples.csv   the 40 labelled examples the prompt rules were extracted from (columns A-M)
data/reference/            recorded decisions + the resulting 13-column CSV
docs/SETUP_AND_DEMO.md     step-by-step Apps Script setup, five-email live demo checklist, pause/cleanup
```

## Reproduce it

### A. Offline, no accounts, no network (Node 18+, no dependencies)

```bash
npm run check          # exports match code, flows match code, 600+ logic checks, reference CSV verifies
npm run build:reference   # rebuild data/reference/Practice_Mailbox_40_classified.csv from the recorded decisions
git diff --exit-code data/reference   # unchanged = reproducible
```

What this proves: the validation rules, escalation rule, column K assembly, signatures, label names, duplicate and
retry handling behave as documented, with Gmail, Sheets and the Claude API replaced by mocks.

### B. Run the same prompt against the Claude API, outside Google

```bash
export ANTHROPIC_API_KEY=...            # from the Anthropic Console; never commit it
export CLAUDE_MODEL=<a model your key can use>
npm run classify:live -- --out data/live/decisions.json    # uses API credits; resumable; --limit N to try a few
node scripts/build-reference.js --decisions data/live/decisions.json --out data/live/classified.csv
node scripts/verify-output.js data/live/classified.csv
```

`classify-with-api.js` builds its requests with the agent's own `buildRequest_`, so the prompt, schema and settings
are identical to the live agent. Compare `data/live/classified.csv` with `data/reference/...` to see where the model
and the recorded reference disagree. Model output can vary between runs and between models.

### C. Run the real agent in your Google account

Follow [`docs/SETUP_AND_DEMO.md`](docs/SETUP_AND_DEMO.md): create a Sheet, paste `src/Code.gs` and
`src/appsscript.json` into an Apps Script project (or use `clasp`, see `.clasp.json.example`), set the Script
Properties listed in `config/script-properties.example.json`, run `setup`, `testClaudeConnection`, `runDemo`, then
`installTrigger`. Download the Sheet as CSV and check it with `node scripts/verify-output.js <file.csv>`.

## What the agent produces

13 columns: `id, received, language, from_name, from_email, subject, body, Category, Urgency, Owner or queue,
Proposed action, Confidence, Escalate flag`, and six Gmail labels per message:
`Triage/Category/…`, `Triage/Urgency/…`, `Triage/Owner/…`, `Triage/Action/<first sentence of the proposed action>`,
`Triage/Confidence/…`, `Triage/Escalate/Yes|No`.

Rules worth knowing (all in the prompt and code):
- **Escalate flag is Yes whenever confidence is not High**; with High confidence the prompt rules decide. Informational only.
- **Column K** always starts with a concrete proposed action. A draft follows only when a reply is the right
  immediate action (`Draft:`; suspected phishing gets `Draft to ICT:`). Drafts use an explicit EN/BG signature per owner.
- **Email content is untrusted data.** It is passed as JSON inside `<untrusted_email>` tags and the prompt tells
  the model to ignore instructions in it; the script validates every field against the approved lists.
- **Urgency is independent of category**: U1 active hazard or imminent threat, U2 same-shift, U3 normal queue,
  U4 low priority or discretionary.

## What is verified, and what is not

**Verified by code in this repository** (`npm run check`; run here on Node 22. A GitHub Actions workflow for Node 18, 20 and 22 is included in `.github/workflows/ci.yml` but has not run yet):
- the exports and flow definition match `src/Code.gs`; the code contains no send, forward, move, trash or delete calls;
- 577 logic checks with mocked Gmail, Sheets and Claude: 13 columns in order, one row per message ID, no duplicates on
  re-runs or overlapping runs, label recovery, bounded batches, rate-limit and invalid-output handling without marking
  failures as processed, formula-safe text writes, EN/BG signatures for all 15 owners, the escalation and draft rules;
- 30 checks on the scripts: byte-for-byte rebuild of the reference CSV, the output verifier (and that it rejects broken
  files), and `classify-with-api.js` against a local mock of the API.

**Not verified here; check in your own accounts:**
- Gmail authorization, the Gmail advanced service and Workspace admin policy for your account;
- that your API key, model ID, rate limits and credit balance work (`testClaudeConnection`);
- that Google Sheets keeps text such as `=1+1` literal, and how Gmail shows per-message labels in conversation view;
- the five-minute trigger actually firing;
- **model quality.** The classification checks above test the plumbing, not the model's judgement.

### About the reference run

`data/reference/decisions.json` is a **hand-made reference run**: the classifications were produced by Claude in a chat
session applying the prompt rules, **not** by the live agent or the API. They were then passed through the agent's own
validator and column K builder. The 40 emails are the same ones the prompt rules were derived from, so agreement with
`data/worked_examples.csv` is **not an independent accuracy test**. For a real test, use the five fresh emails in the
demo checklist or run `classify:live` on emails that were not used to write the rules.

## Safety and secrets

- No secrets are in this repository. The API key, model ID and spreadsheet ID live in Apps Script **Script Properties**.
  `.gitignore` excludes `.env`, `.clasp.json` and `data/live/`.
- Scopes requested: Gmail modify (labels), Sheets, external requests, script triggers.
- The data in `data/` is synthetic practice data (example domains); confirm you are happy to publish it.

## Known limits

- At most 10 messages per run (about 120 per hour at the five-minute interval); the newest 300 inbox messages in the
  last 72 hours are considered.
- The Action label is the first sentence of column K (up to 200 characters), so the Gmail label list grows over time.
- Only the plain-text body (first 12,000 characters) is sent to Claude; attachments are not read.
- Executive Management / CEO, Legal and Security routing has very few examples in the 40 emails; expect to tune it.

## License

No license has been chosen yet. Add one (for example MIT) before publishing if you want others to reuse the code.
