const POOL_SIZE = 3;
const STARTUP_DELAY_MS = 3_000;
const DEFAULT_BASE_URL = "http://localhost:8787";

function parseArguments(argv) {
  let baseUrl = DEFAULT_BASE_URL;
  let holdSeconds = 0;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--hold-seconds") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--hold-seconds requires a numeric value");
      }
      holdSeconds = Number(value);
      index += 1;
    } else if (argument.startsWith("--hold-seconds=")) {
      holdSeconds = Number(argument.slice("--hold-seconds=".length));
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      baseUrl = argument;
    }
  }

  if (!Number.isFinite(holdSeconds) || holdSeconds < 0) {
    throw new Error("--hold-seconds must be a non-negative number");
  }

  const parsedUrl = new URL(baseUrl);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("Base URL must use http or https");
  }

  return {
    baseUrl: parsedUrl.toString().replace(/\/$/, ""),
    holdSeconds,
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertNumber(value, label) {
  assert(typeof value === "number" && Number.isFinite(value), `${label} must be a finite number`);
}

function formatMs(value) {
  return value >= 1_000 ? `${(value / 1_000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(baseUrl, path, options = {}) {
  const {
    expectedStatus = 200,
    timeoutMs = 90_000,
    ...requestOptions
  } = options;
  const startedAt = performance.now();
  let response;

  try {
    response = await fetch(`${baseUrl}${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
      ...requestOptions,
    });
  } catch (cause) {
    throw new Error(
      `Request to ${path} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  const clientMs = performance.now() - startedAt;
  const cacheControl = response.headers.get("cache-control") ?? "";
  assert(cacheControl.toLowerCase().includes("no-store"), `${path} must return Cache-Control: no-store`);

  let payload;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new Error(`${path} returned non-JSON content with status ${response.status}`, { cause });
  }

  if (response.status !== expectedStatus) {
    const detail = typeof payload?.error === "string" ? `: ${payload.error}` : "";
    throw new Error(`${path} returned ${response.status}; expected ${expectedStatus}${detail}`);
  }

  return { payload, clientMs, headers: response.headers };
}

async function fetchDashboard(baseUrl) {
  const response = await fetch(`${baseUrl}/`, {
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, `dashboard must return 2xx, received ${response.status}`);
  const html = await response.text();
  assert(html.includes("application code"), "dashboard must include the application-managed pool disclosure");
  assert(html.includes("simulated application initialization"), "dashboard must disclose simulated initialization");
}

async function stopPool(baseUrl) {
  const { payload } = await fetchJson(baseUrl, "/api/pool/stop", { method: "POST" });
  assert(payload.ok === true, "stop response must be successful");
  assert(Array.isArray(payload.members) && payload.members.length === POOL_SIZE, "stop must return three members");
  assert(payload.members.every((member) => member.ok === true), "every pool member must stop successfully");
  return payload;
}

async function sendJob(baseUrl, jobId) {
  const { payload, clientMs } = await fetchJson(baseUrl, "/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId }),
  });
  assert(payload.ok === true, `${jobId} must succeed`);
  assert(payload.jobId === jobId, `${jobId} must be preserved`);
  assert(typeof payload.bootId === "string" && payload.bootId.length > 0, `${jobId} must return a boot ID`);
  assertNumber(payload.workerElapsedMs, `${jobId}.workerElapsedMs`);
  assertNumber(payload.processingMs, `${jobId}.processingMs`);
  return { ...payload, clientMs };
}

async function verifyApiContract(baseUrl) {
  const health = await fetchJson(baseUrl, "/api/health");
  assert(health.payload.ok === true, "Worker health must be successful");
  assert(health.payload.service === "warm-pool-poc", "Worker health must identify the service");
  assert(health.payload.poolSize === POOL_SIZE, "Worker health must report pool size 3");

  const wrongMethod = await fetchJson(baseUrl, "/api/jobs", {
    method: "GET",
    expectedStatus: 405,
  });
  assert(wrongMethod.payload.ok === false, "wrong method must return a structured error");

  const malformed = await fetchJson(baseUrl, "/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
    expectedStatus: 400,
  });
  assert(malformed.payload.ok === false, "invalid JSON must return a structured error");

  const unknown = await fetchJson(baseUrl, "/api/not-a-route", { expectedStatus: 404 });
  assert(unknown.payload.ok === false, "unknown API path must return a structured error");

  await fetchDashboard(baseUrl);
  return health.payload;
}

async function runSequence(config, summary, setPhase) {
  setPhase("API contract");
  process.stdout.write("[1/6] Checking Worker, API errors, and dashboard... ");
  summary.health = await verifyApiContract(config.baseUrl);
  console.log("passed");

  setPhase("initial stop");
  process.stdout.write("[2/6] Stopping the fixed pool... ");
  await stopPool(config.baseUrl);
  console.log("passed");

  setPhase("cold job");
  process.stdout.write("[3/6] Sending a cold job... ");
  const cold = await sendJob(config.baseUrl, `smoke-cold-${crypto.randomUUID()}`);
  assert(
    cold.workerElapsedMs >= STARTUP_DELAY_MS,
    `cold job must include at least ${STARTUP_DELAY_MS}ms simulated initialization; observed ${cold.workerElapsedMs}ms`,
  );
  summary.cold = {
    bootId: cold.bootId,
    workerElapsedMs: cold.workerElapsedMs,
    clientMs: Math.round(cold.clientMs),
  };
  console.log(`passed (${formatMs(cold.workerElapsedMs)})`);

  setPhase("prewarm reset");
  process.stdout.write("[4/6] Resetting, then prewarming all members in parallel... ");
  await stopPool(config.baseUrl);
  const { payload: prewarm } = await fetchJson(config.baseUrl, "/api/pool/prewarm", {
    method: "POST",
    timeoutMs: 120_000,
  });
  assert(prewarm.ok === true, "prewarm must succeed");
  assert(Array.isArray(prewarm.members) && prewarm.members.length === POOL_SIZE, "prewarm must return three members");
  assert(prewarm.members.every((member) => member.ok === true), "every prewarm member must be ready");

  const prewarmedBootIds = new Set(prewarm.members.map((member) => member.bootId));
  assert(prewarmedBootIds.size === POOL_SIZE, "prewarm must return three unique boot IDs");
  assert(!prewarmedBootIds.has(cold.bootId), "prewarm after stop must return new process identities");

  const memberStartupTimes = prewarm.members.map((member) => member.startupMs);
  memberStartupTimes.forEach((value, index) => assertNumber(value, `prewarm.members[${index}].startupMs`));
  assertNumber(prewarm.totalMs, "prewarm.totalMs");
  const slowestMemberMs = Math.max(...memberStartupTimes);
  assert(
    prewarm.totalMs <= slowestMemberMs * 1.5 + 1_000,
    `prewarm must approximate one parallel startup window; total ${prewarm.totalMs}ms, slowest member ${slowestMemberMs}ms`,
  );

  summary.prewarm = {
    totalMs: prewarm.totalMs,
    bootIds: [...prewarmedBootIds],
  };
  console.log(`passed (${formatMs(prewarm.totalMs)}, 3 unique boots)`);

  setPhase("warm burst");
  process.stdout.write("[5/6] Sending 12 concurrent warm jobs... ");
  const warmJobs = await Promise.all(
    Array.from(
      { length: 12 },
      (_, index) => sendJob(config.baseUrl, `smoke-warm-${index + 1}-${crypto.randomUUID()}`),
    ),
  );

  for (const job of warmJobs) {
    assert(prewarmedBootIds.has(job.bootId), `warm job returned unexpected boot ID ${job.bootId}`);
    assert(
      job.processingMs < STARTUP_DELAY_MS,
      `warm job ${job.jobId} reported processing time that includes the synthetic startup interval`,
    );
  }

  const averageWarmMs = warmJobs.reduce((sum, job) => sum + job.workerElapsedMs, 0) / warmJobs.length;
  assert(averageWarmMs < cold.workerElapsedMs, "average warm latency must be below cold latency");

  const distribution = Object.fromEntries(
    [...prewarmedBootIds].map((bootId) => [bootId, warmJobs.filter((job) => job.bootId === bootId).length]),
  );
  summary.warm = {
    count: warmJobs.length,
    averageWorkerElapsedMs: Math.round(averageWarmMs),
    maxWorkerElapsedMs: Math.max(...warmJobs.map((job) => job.workerElapsedMs)),
    distribution,
  };
  console.log(`passed (average ${formatMs(averageWarmMs)})`);

  setPhase("warm hold");
  if (config.holdSeconds > 0) {
    process.stdout.write(`[6/6] Waiting ${config.holdSeconds}s and checking boot reuse... `);
    await sleep(config.holdSeconds * 1_000);
    const heldJob = await sendJob(config.baseUrl, `smoke-hold-${crypto.randomUUID()}`);
    assert(prewarmedBootIds.has(heldJob.bootId), "hold check must reuse a prewarmed boot ID");
    assert(heldJob.processingMs < STARTUP_DELAY_MS, "hold check processing must not include initialization");
    summary.hold = {
      seconds: config.holdSeconds,
      bootId: heldJob.bootId,
      workerElapsedMs: heldJob.workerElapsedMs,
    };
    console.log(`passed (${shortBootId(heldJob.bootId)})`);
  } else {
    console.log("[6/6] Warm-hold check skipped (use --hold-seconds 60 to enable)");
  }
}

function shortBootId(bootId) {
  return bootId.slice(0, 8);
}

async function main() {
  const config = parseArguments(process.argv.slice(2));
  const summary = {
    ok: false,
    baseUrl: config.baseUrl,
    holdSeconds: config.holdSeconds,
  };
  let phase = "startup";
  let failure = null;

  console.log(`Warm Pool POC smoke test: ${config.baseUrl}`);

  try {
    await runSequence(config, summary, (value) => {
      phase = value;
    });
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    process.stdout.write("[cleanup] Stopping all pool members... ");
    try {
      const cleanup = await stopPool(config.baseUrl);
      summary.cleanupMs = cleanup.totalMs;
      console.log("passed");
    } catch (cleanupError) {
      console.log("failed");
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      summary.cleanupError = cleanupMessage;
      if (failure === null) {
        failure = new Error(`Cleanup failed: ${cleanupMessage}`);
        phase = "cleanup";
      }
    }
  }

  if (failure !== null) {
    summary.error = failure.message;
    summary.phase = phase;
    console.error(`\nSmoke test failed during ${phase}: ${failure.message}`);
    console.log(JSON.stringify(summary));
    process.exitCode = 1;
    return;
  }

  summary.ok = true;
  console.log("\nSmoke test passed");
  console.log(`Cold: ${formatMs(summary.cold.workerElapsedMs)}; warm average: ${formatMs(summary.warm.averageWorkerElapsedMs)}; prewarm: ${formatMs(summary.prewarm.totalMs)}`);
  console.log(JSON.stringify(summary));
}

await main().catch((error) => {
  console.error(`Smoke test could not start: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
