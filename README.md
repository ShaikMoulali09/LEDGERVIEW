# Ledgerview

A marketing site plus a working dashboard builder: turn a spreadsheet, **a photo/screenshot of a
table**, or a plain-language prompt into bar / line / doughnut charts. Messy input is **organized
first**, and logged-in users get their work **remembered**.

## What's new in 1.1

- **Images as input.** Drop, browse or paste (Ctrl/⌘+V) a PNG / JPG / WebP of a table. With
  `ANTHROPIC_API_KEY` set, Claude reads it. Without a key, the browser reads it with on-device OCR
  (Tesseract.js, loaded from a CDN on first use — needs internet once).
- **Organizer** (`organizer.js`, shared by browser and server). Before any dashboard is built,
  messy data is cleaned: title lines / dividers / footnotes removed, delimiters auto-detected
  (comma, tab, `;`, `|`, columns of spaces, `Jan - 24000` lists, markdown tables), header row found,
  row-number columns and **total/average rows dropped** (so nothing is double-counted), thousands-split
  numbers re-joined (`31,000` → one cell), `₹ $ € £ % 12k 1.5 lakh (500)` parsed, blank markers
  (`N/A`, `-`) cleared, case / near-duplicate spellings merged (`Delivry` → `Delivery`), dates
  normalized, and "months as columns" tables reshaped into long form. Every change is listed in a
  **"How Ledgerview organized this"** box on the dashboard, and the tidy table is shown in the
  paste box so you can check or edit it.
- **Prompts are organized first too.** Shorthand (`40k`, `₹40,000`, `six months`, `8 wks`) and loose
  category lists (`by channel (a / b / c)`) are normalized; if the prompt *contains data*
  (`Jan 24000, Feb 31k, …` or pasted rows) it's turned into a real table and charted as real data.
- **Log in + sign up** on the same page. Sessions persist across refreshes.
- **Remembered work.** When logged in, your last pasted data, prompt, active tab, last dashboard and
  saved dashboards are restored automatically (and cleared from the screen on log out).

## Profile page (new)

The nav no longer shows "Hi, name / Log out". Once you're logged in it shows an avatar + your first
name that opens **#profile**, where you can:

- **Edit details**: name and company (email is your login, so it's read-only).
- **Manage your subscription**: see your plan, upgrade / switch, or cancel back to Free. The Pricing
  page buttons also lead here when you're logged in.
- **Manage saved data**: open, download (JSON) or delete saved dashboards, see and clear the
  remembered session, delete everything, or download all your data.
- **Login & security**: change password (other devices are logged out), log out, log out of all devices.
- **Delete account**: removes the account, saved dashboards and session (asks for your password).

Files: `profile.js` (new), plus changes in `auth.js`, `server.js`, `index.html`, `style.css`,
`script.js`, `dashboard.js`.

## Running it

```bash
npm install
node server.js                                # → http://localhost:4000
ANTHROPIC_API_KEY=sk-ant-... node server.js   # optional: AI image reading + AI prompts
```

Opening `index.html` directly (no server) still works: everything runs in the browser, and accounts
and saved work go to `localStorage` — for that browser only.

## API

| Route | Method | Auth | Body → Returns |
|---|---|---|---|
| `/api/health` | GET | – | `{ ok, ai }` |
| `/api/auth/signup` | POST | – | `{ name, email, company?, plan?, password }` → `{ token, user }` |
| `/api/auth/login` | POST | – | `{ email, password }` → `{ token, user }` |
| `/api/auth/logout` | POST | ✓ | `{ ok }` |
| `/api/auth/me` | GET | ✓ | `{ user }` |
| `/api/workspace` | GET / PUT | ✓ | `{ workspace }` — last inputs + last dashboard |
| `/api/extract-image` | POST | – | `{ image: dataURL }` → `{ columns, rows, csv, notes }` (501 without a key) |
| `/api/organize` | POST | – | `{ text }` → `{ columns, rows, csv, notes }` |
| `/api/dashboards/generate` | POST | – | `{ mode:"data", columns, rows }` or `{ mode:"prompt", prompt }` → `{ spec }` |
| `/api/dashboards` | GET / POST | ✓ | the logged-in user's saved dashboards |
| `/api/dashboards/:id` | DELETE | ✓ | `{ ok }` |
| `/api/account/profile` | PUT | ✓ | `{ name, company? }` → `{ user }` |
| `/api/account/password` | POST | ✓ | `{ current, next }` → `{ ok }` (other sessions are revoked) |
| `/api/account/plan` | PUT | ✓ | `{ plan }` → `{ user }` |
| `/api/account/logout-all` | POST | ✓ | `{ ok }` |
| `/api/account` | DELETE | ✓ | `{ password }` → `{ ok }` |

Tokens go in `Authorization: Bearer <token>`.

## Security notes

- Passwords: scrypt + per-user salt. Session tokens: random, stored only as SHA-256 hashes, 30-day expiry.
- Sign-up / log-in / AI endpoints are rate-limited per IP (in memory).
- **The server no longer serves its whole folder.** The old `express.static(__dirname)` would have
  exposed `server.js` and `data/users.json`; now only the site files and `fonts/` are served.
- Data lives in `data/*.json` — fine for a demo or small team. Swap `readJSON` / `writeJSON` for a
  database before real production use, and run behind HTTPS.
- In no-backend mode, accounts are a convenience (a browser-side PBKDF2 hash in `localStorage`),
  **not** real security — anyone with access to that browser profile can read them.

## Known limits

- **No payments.** Plan changes on the profile page are recorded on the account, but nothing is billed.
  Connect a payment provider (Stripe, Razorpay…) before charging for Pro / Business.
- Accounts created before this update have no `createdAt` / `planSince`, so "member since" is hidden for them.
- OCR (no key) can misread digits on blurry or angled photos; the dashboard notes remind users to
  check the table. AI reading (with a key) is noticeably better on hard images.
- HEIC photos must be converted first (browsers can't decode them on a canvas).
- Dashboards saved by version 1.0 (no owner) aren't shown to anyone in 1.1; they stay untouched in
  `data/dashboards.json`.
- Some marketing copy elsewhere (About page "0 servers your data touches", the comparison table row
  "Your data leaves your device: No") was left as-is; it's no longer strictly true when the backend
  or AI reading is on, so reword it to match how you deploy.
