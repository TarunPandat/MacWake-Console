# MacWake console (Next.js)

Phone/iPad web console + API that the MacWake Mac app talks to. Same API as the Cloudflare
Worker in `../console`; pick one.

| Route | Who | What |
|-------|-----|------|
| `GET /` | you | console UI (token stored in the browser) |
| `GET /api/state` | console | current phase + Mac status |
| `POST /api/wake`, `/api/cancel` | console | request / cancel a wake |
| `POST /api/settings` `{interval, hold}` | console | minutes |
| `POST /api/heartbeat` | Mac | check-in; reply tells it whether to wake / keep holding |
| `POST /api/register` | Mac app | first-run pairing: stores the hash of the Mac's own token |

All `/api/*` need `Authorization: Bearer <token>`. The token is the one the Mac app created and paired, or `ADMIN_TOKEN` if you set one. `ADMIN_TOKEN` is optional now.

The console is a PWA: on iPhone use Share → Add to Home Screen, on Android use Install app.

**Instant wake.** Under Timing, "Instant wake on charger" is on by default. While plugged in, the Mac skips deep sleep (screen still turns off) and keeps a push connection open, so a wake arrives in about a second. Pushes go through the free relay at ntfy.sh on a topic derived from the Mac's token; a push only tells the Mac to check in, commands still come from this console. Set `NTFY_URL` to use your own ntfy server, or `NTFY_URL=off` to disable pushes. On battery the Mac falls back to timed check-ins.

**Sign in by QR.** The sign-in screen has "Scan pairing code", which reads the QR from the Mac app's "Pair phone…" window (needs the https:// address for camera access).

## Deploy on Vercel (free)

1. Push this folder (or the repo with **Root Directory** = `console-next`) to GitHub and import it at vercel.com.
2. In the project: **Storage → Create → Upstash for Redis** (free tier). This adds `KV_REST_API_URL` / `KV_REST_API_TOKEN`.
3. Deploy. Your console is `https://<project>.vercel.app`.
4. Build the Mac app with `CONSOLE_URL=https://<project>.vercel.app sh ../mac/build.sh` and install it. It pairs itself and shows a QR code; scan it with your phone.

Pair the Mac right after deploying: the first Mac to register owns the console.

CLI alternative: `npx vercel` in this folder, then `npx vercel env add ADMIN_TOKEN`, link storage in the dashboard, `npx vercel --prod`.

## Local

```bash
npm install
cp .env.example .env.local   # set ADMIN_TOKEN
npm run dev                  # http://localhost:3000, state in .data/state.json
npm test                     # logic tests, no server needed
```

Any other host works too (Fly, Railway, a VPS with `npm run build && npm start`); only the
two Upstash env vars are needed for persistence. Without them the file store is used, which
is fine on a single always-on box but not on serverless.
