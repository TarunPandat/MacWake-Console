import { account, handle, iceServers, register } from "../../../lib/logic.js";
import { kv } from "../../../lib/store.js";

export const dynamic = "force-dynamic";

async function run(req, { params }) {
  const { action } = await params;
  const auth = req.headers.get("authorization");
  if (action === "register" && req.method === "POST") {
    const { status, body } = await register(auth, process.env.ADMIN_TOKEN, kv, (await req.json().catch(() => null)) || {});
    return Response.json(body, { status });
  }
  const acct = await account(auth, process.env.ADMIN_TOKEN, kv);
  if (!acct) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const push = process.env.NTFY_URL === "off" ? null : (process.env.NTFY_URL || "https://ntfy.sh").replace(/\/+$/, "");
  const { status, body: out } = await handle(action, body, acct.kv, Date.now(), { push, hashes: acct.hashes, ice: iceServers(process.env) });
  return Response.json(out, { status });
}

async function safe(req, ctx) {
  try { return await run(req, ctx); }
  catch (e) { return Response.json({ error: e.message || "server error" }, { status: 500 }); }
}

export { safe as GET, safe as POST };
