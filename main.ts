import { initEnv } from "./src/lib/env.ts";
import { initRepo } from "./src/repo/mod.ts";
import { DenoKvRepo } from "./src/repo/deno.ts";
import { app } from "./src/app.ts";

initEnv((n) => Deno.env.get(n) ?? "");

// KV_PATH lets us point Deno.Kv at an explicit SQLite file (e.g. /data/kv.sqlite3
// inside a container). When unset we fall back to Deno's default per-location
// hash directory under ~/.cache/deno/location_data/<hash>/, which is what the
// existing systemd unit relies on. Don't break that.
const kvPath = Deno.env.get("KV_PATH");
const kv = kvPath ? await Deno.openKv(kvPath) : await Deno.openKv();
initRepo(new DenoKvRepo(kv));

Deno.serve(app.fetch);
