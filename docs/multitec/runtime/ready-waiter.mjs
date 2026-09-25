// Holds the boot screen's long-poll open until Homarr is healthy. Started by boot.sh.
//
// Three jobs, all of them about the same 13 seconds (agent repo,
// docs/research/portal-cold-start.md):
//
// 1. GET /ready (nginx maps /__multitec/ready here) answers 200 as soon as
//    `/api/health/live` does, and 503 after MULTITEC_READY_TIMEOUT_MS if it never does.
//    The request staying OPEN is the point. Under request-based billing Cloud Run gives
//    the instance CPU only while a request is in flight, and after the startup probe (now
//    a TCP check that nginx passes within a second) there is no other request in flight.
//    A screen that polled once a second would leave Homarr booting on a throttled CPU.
//
// 2. It wakes the database at once. Migrations used to be the first thing to reach Neon,
//    and they no longer run at boot (DB_MIGRATIONS_DISABLED, run by the build instead).
//    Neon Free suspends after five minutes and takes one to two seconds to resume, and
//    this starts that clock in parallel with Next.js loading instead of after it.
//
// 3. It logs one line with how long the boot took, which is how a cold start is measured
//    from Cloud Run's logs from now on.
//
// Plain Node, no dependencies of its own: `pg` is borrowed from Homarr's node_modules and
// is optional, so a missing driver costs the early wake-up and nothing else.
import { createServer, get } from "node:http";
import { createRequire } from "node:module";

const started = Date.now();
const port = Number(process.env.MULTITEC_READY_PORT ?? 3002);
const timeoutMs = Number(process.env.MULTITEC_READY_TIMEOUT_MS ?? 60_000);
const healthUrl = "http://127.0.0.1:3000/api/health/live";
const log = (message) => console.log(`multitec-boot: ${message}`);

let healthy = false;

const probe = () =>
  new Promise((resolve) => {
    const req = get(healthUrl, { timeout: 5_000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });

// One loop for the whole process, however many screens are waiting on it, so ten members
// arriving together do not become ten pollers hammering a Next.js that is still starting.
let loop = null;
const untilHealthy = () => {
  loop ??= (async () => {
    while (!(await probe())) await new Promise((r) => setTimeout(r, 250));
    if (!healthy) log(`homarr healthy ${((Date.now() - started) / 1000).toFixed(1)}s after the wrapper started`);
    healthy = true;
  })();
  return loop;
};
untilHealthy();

const wakeDatabase = async () => {
  const url = process.env.DB_URL ?? "";
  if (!/^postgres(ql)?:\/\//.test(url)) return;
  try {
    const { Client } = createRequire("/app/package.json")("pg");
    const t = Date.now();
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
    await client.connect();
    await client.query("select 1");
    await client.end();
    log(`database answered in ${Date.now() - t} ms`);
  } catch (error) {
    // Never fatal: Homarr opens its own connections, this only gets there first.
    log(`database wake-up skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
};
void wakeDatabase();

createServer(async (req, res) => {
  if (req.url !== "/ready") {
    res.writeHead(404).end();
    return;
  }
  // Already healthy: confirm once, because Next.js may have been restarted by run.sh.
  if (healthy) {
    if (await probe()) {
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"ready":true}');
      return;
    }
    // It was up and is not any more: start a fresh loop, the old one has finished.
    healthy = false;
    loop = null;
  }
  const ok = await Promise.race([
    untilHealthy().then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  res
    .writeHead(ok ? 200 : 503, { "Content-Type": "application/json" })
    .end(ok ? '{"ready":true}' : '{"ready":false}');
}).listen(port, "127.0.0.1", () => log(`waiter listening on ${port}`));
