import { Container, getContainer, getRandom } from "@cloudflare/containers";

const POOL_SIZE = 3;
const CONTAINER_PORT = 8080;
const MAX_JOB_BODY_BYTES = 4_096;
const MAX_JOB_ID_LENGTH = 128;
const STOP_WAIT_TIMEOUT_MS = 10_000;
const POOL_MEMBERS = Array.from(
  { length: POOL_SIZE },
  (_, index) => `instance-${index}`,
);

type JsonObject = Record<string, unknown>;

interface ContainerIdentity {
  instanceId: string;
  bootId: string;
  startedAt: string;
}

interface ContainerWorkResult extends ContainerIdentity {
  requestCount: number;
  processingMs: number;
}

interface PrewarmMemberSuccess extends ContainerIdentity {
  name: string;
  ok: true;
  startupMs: number;
}

interface PoolMemberFailure {
  name: string;
  ok: false;
  elapsedMs: number;
  error: string;
  errorName: string;
}

type PrewarmMemberResult = PrewarmMemberSuccess | PoolMemberFailure;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class DemoContainer extends Container<Env> {
  override defaultPort = CONTAINER_PORT;
  override sleepAfter = "10m";
  override enableInternet = false;

  async stopAndWait(): Promise<void> {
    await this.stop();

    const deadline = Date.now() + STOP_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = await this.getState();
      if (state.status === "stopped" || state.status === "stopped_with_code") {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Container did not stop within ${STOP_WAIT_TIMEOUT_MS}ms`);
  }
}

function log(
  level: "log" | "error",
  event: string,
  fields: Record<string, unknown> = {},
): void {
  console[level](JSON.stringify({ event, ...fields }));
}

function elapsedSince(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function jsonResponse(
  body: JsonObject,
  status = 200,
  headers?: HeadersInit,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function methodNotAllowed(allowed: string): Response {
  return jsonResponse(
    { ok: false, error: "Method not allowed" },
    405,
    { Allow: allowed },
  );
}

function errorDetails(error: unknown): { errorName: string; errorMessage: string } {
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: error.message };
  }
  return { errorName: "UnknownError", errorMessage: String(error) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseIdentity(value: unknown): ContainerIdentity {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    typeof value.instanceId !== "string" ||
    typeof value.bootId !== "string" ||
    typeof value.startedAt !== "string"
  ) {
    throw new Error("Container returned an invalid identity response");
  }

  return {
    instanceId: value.instanceId,
    bootId: value.bootId,
    startedAt: value.startedAt,
  };
}

function parseWorkResult(value: unknown, jobId: string): ContainerWorkResult {
  const identity = parseIdentity(value);
  if (
    !isRecord(value) ||
    value.jobId !== jobId ||
    typeof value.requestCount !== "number" ||
    !Number.isFinite(value.requestCount) ||
    typeof value.processingMs !== "number" ||
    !Number.isFinite(value.processingMs)
  ) {
    throw new Error("Container returned an invalid work response");
  }

  return {
    ...identity,
    requestCount: value.requestCount,
    processingMs: value.processingMs,
  };
}

async function readJobBody(request: Request): Promise<JsonObject> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const parsedLength = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_JOB_BODY_BYTES) {
      throw new HttpError(413, "Request body is too large");
    }
  }

  if (request.body === null) {
    return {};
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }

    size += result.value.byteLength;
    if (size > MAX_JOB_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "Request body is too large");
    }
    chunks.push(result.value);
  }

  if (size === 0) {
    return {};
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }

  if (!isRecord(value)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  return value;
}

function normalizeJobId(body: JsonObject): string {
  if (body.jobId === undefined || body.jobId === "") {
    return `job-${crypto.randomUUID()}`;
  }
  if (typeof body.jobId !== "string") {
    throw new HttpError(400, "jobId must be a string");
  }

  const jobId = body.jobId.trim();
  if (jobId.length === 0) {
    return `job-${crypto.randomUUID()}`;
  }
  if (jobId.length > MAX_JOB_ID_LENGTH) {
    throw new HttpError(400, `jobId must be at most ${MAX_JOB_ID_LENGTH} characters`);
  }
  return jobId;
}

async function prewarmMember(env: Env, name: string): Promise<PrewarmMemberResult> {
  const startedAt = performance.now();

  try {
    const member = getContainer(env.WARM_POOL, name);
    await member.startAndWaitForPorts({
      ports: [CONTAINER_PORT],
      cancellationOptions: { portReadyTimeoutMS: 30_000 },
    });

    const healthResponse = await member.fetch(
      new Request("http://container/health", { method: "GET" }),
    );
    if (!healthResponse.ok) {
      throw new Error(`Container health check returned ${healthResponse.status}`);
    }

    const identity = parseIdentity(await healthResponse.json());
    const startupMs = elapsedSince(startedAt);
    log("log", "pool.prewarm.member.ready", {
      memberName: name,
      bootId: identity.bootId,
      elapsedMs: startupMs,
      status: healthResponse.status,
    });

    return { name, ok: true, startupMs, ...identity };
  } catch (error) {
    const elapsedMs = elapsedSince(startedAt);
    const { errorName, errorMessage } = errorDetails(error);
    log("error", "pool.prewarm.member.failed", {
      memberName: name,
      elapsedMs,
      status: "failed",
      errorName,
      errorMessage,
    });

    return {
      name,
      ok: false,
      elapsedMs,
      error: "Container failed to become ready",
      errorName,
    };
  }
}

async function handlePrewarm(env: Env): Promise<Response> {
  const startedAt = performance.now();
  log("log", "pool.prewarm.started", { poolSize: POOL_SIZE });

  const settled = await Promise.allSettled(
    POOL_MEMBERS.map((name) => prewarmMember(env, name)),
  );
  const members: PrewarmMemberResult[] = settled.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }

    const name = POOL_MEMBERS[index] ?? `instance-${index}`;
    const { errorName, errorMessage } = errorDetails(result.reason);
    log("error", "pool.prewarm.member.failed", {
      memberName: name,
      status: "failed",
      errorName,
      errorMessage,
    });
    return {
      name,
      ok: false,
      elapsedMs: elapsedSince(startedAt),
      error: "Container failed to become ready",
      errorName,
    };
  });

  const bootIds = members.flatMap((member) => member.ok ? [member.bootId] : []);
  const ok =
    members.every((member) => member.ok) &&
    new Set(bootIds).size === POOL_SIZE;
  const totalMs = elapsedSince(startedAt);

  log(ok ? "log" : "error", "pool.prewarm.completed", {
    poolSize: POOL_SIZE,
    elapsedMs: totalMs,
    status: ok ? "ready" : "failed",
  });

  return jsonResponse(
    {
      ok,
      poolSize: POOL_SIZE,
      totalMs,
      members,
      ...(!ok && { error: "The complete pool did not become ready" }),
    },
    ok ? 200 : 503,
  );
}

async function handleStop(env: Env): Promise<Response> {
  const startedAt = performance.now();
  log("log", "pool.stop.started", { poolSize: POOL_SIZE });

  const settled = await Promise.allSettled(
    POOL_MEMBERS.map(async (name) => {
      const memberStartedAt = performance.now();
      await getContainer(env.WARM_POOL, name).stopAndWait();
      return { name, elapsedMs: elapsedSince(memberStartedAt) };
    }),
  );

  const members = settled.map((result, index) => {
    const name = POOL_MEMBERS[index] ?? `instance-${index}`;
    if (result.status === "fulfilled") {
      log("log", "pool.stop.member.completed", {
        memberName: name,
        elapsedMs: result.value.elapsedMs,
        status: "stopped",
      });
      return { name, ok: true };
    }

    const { errorName, errorMessage } = errorDetails(result.reason);
    log("error", "pool.stop.member.completed", {
      memberName: name,
      status: "failed",
      errorName,
      errorMessage,
    });
    return {
      name,
      ok: false,
      error: "Container failed to stop",
      errorName,
    };
  });

  const ok = members.every((member) => member.ok);
  const totalMs = elapsedSince(startedAt);
  log(ok ? "log" : "error", "pool.stop.completed", {
    poolSize: POOL_SIZE,
    elapsedMs: totalMs,
    status: ok ? "stopped" : "failed",
  });

  return jsonResponse(
    {
      ok,
      totalMs,
      members,
      ...(!ok && { error: "One or more pool members failed to stop" }),
    },
    ok ? 200 : 503,
  );
}

async function handleJob(request: Request, env: Env): Promise<Response> {
  const body = await readJobBody(request);
  const jobId = normalizeJobId(body);
  const startedAt = performance.now();
  log("log", "job.started", { jobId, poolSize: POOL_SIZE });

  try {
    const member = await getRandom(env.WARM_POOL, POOL_SIZE);
    const containerResponse = await member.fetch(
      new Request("http://container/work", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      }),
    );

    if (!containerResponse.ok) {
      throw new Error(`Container work request returned ${containerResponse.status}`);
    }

    const result = parseWorkResult(await containerResponse.json(), jobId);
    const workerElapsedMs = elapsedSince(startedAt);
    log("log", "job.completed", {
      jobId,
      bootId: result.bootId,
      elapsedMs: workerElapsedMs,
      status: containerResponse.status,
    });

    return jsonResponse({
      ok: true,
      jobId,
      ...result,
      workerElapsedMs,
    });
  } catch (error) {
    const workerElapsedMs = elapsedSince(startedAt);
    const { errorName, errorMessage } = errorDetails(error);
    log("error", "job.failed", {
      jobId,
      elapsedMs: workerElapsedMs,
      status: 502,
      errorName,
      errorMessage,
    });

    return jsonResponse(
      {
        ok: false,
        jobId,
        workerElapsedMs,
        error: "Container job failed",
      },
      502,
    );
  }
}

async function routeApi(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/api/health") {
    if (request.method !== "GET") {
      return methodNotAllowed("GET");
    }
    return jsonResponse({
      ok: true,
      service: "warm-pool-poc",
      poolSize: POOL_SIZE,
      timestamp: new Date().toISOString(),
    });
  }

  if (pathname === "/api/pool/prewarm") {
    return request.method === "POST"
      ? handlePrewarm(env)
      : methodNotAllowed("POST");
  }

  if (pathname === "/api/pool/stop") {
    return request.method === "POST"
      ? handleStop(env)
      : methodNotAllowed("POST");
  }

  if (pathname === "/api/jobs") {
    return request.method === "POST"
      ? handleJob(request, env)
      : methodNotAllowed("POST");
  }

  return jsonResponse({ ok: false, error: "API route not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (!pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      return await routeApi(request, env);
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse({ ok: false, error: error.message }, error.status);
      }

      const { errorName, errorMessage } = errorDetails(error);
      log("error", "api.failed", { pathname, errorName, errorMessage });
      return jsonResponse({ ok: false, error: "Internal server error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
