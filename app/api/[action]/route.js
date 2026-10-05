import { authed, handle, register } from "../../../lib/logic.js";
import { kv } from "../../../lib/store.js";

export const dynamic = "force-dynamic";

async function run(req, { params }) {
  const { action } = await params;
  const auth = req.headers.get("authorization");
  if (action === "register" && req.method === "POST") {
    const { status, body } = await register(auth, kv);
    return Response.json(body, { status });
  }
  if (!(await authed(auth, process.env.ADMIN_TOKEN, kv))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const { status, body: out } = await handle(action, body, kv);
  return Response.json(out, { status });
}

export { run as GET, run as POST };
