import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { hostname } from "node:os";

const DEFAULT_STARTUP_DELAY_MS = 3_000;
const DEFAULT_WORK_DELAY_MS = 500;
const MAX_BODY_BYTES = 4_096;
const PORT = 8080;

const startupDelayMs = readDelay("STARTUP_DELAY_MS", DEFAULT_STARTUP_DELAY_MS);
const workDelayMs = readDelay("WORK_DELAY_MS", DEFAULT_WORK_DELAY_MS);
const bootId = randomUUID();
const startedAt = new Date().toISOString();
const instanceId = hostname();

let requestCount = 0;
let stopping = false;

function readDelay(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function log(event, fields = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    instanceId,
    bootId,
    ...fields,
  }));
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(request) {
  const declaredLength = Number.parseInt(request.headers["content-length"] ?? "0", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    const error = new Error("Request body is too large");
    error.status = 413;
    throw error;
  }

  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (size === 0) {
    return {};
  }

  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      throw new TypeError("JSON body must be an object");
    }
    return value;
  } catch (cause) {
    const error = new Error("Request body must be valid JSON");
    error.status = 400;
    error.cause = cause;
    throw error;
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  try {
    if (url.pathname === "/health") {
      if (request.method !== "GET") {
        sendJson(response, 405, { ok: false, error: "Method not allowed" }, { Allow: "GET" });
        return;
      }

      sendJson(response, 200, {
        ok: true,
        instanceId,
        bootId,
        startedAt,
      });
      return;
    }

    if (url.pathname === "/work") {
      if (request.method !== "POST") {
        sendJson(response, 405, { ok: false, error: "Method not allowed" }, { Allow: "POST" });
        return;
      }

      const body = await readJson(request);
      const jobId = typeof body.jobId === "string" ? body.jobId : "unknown";
      const workStartedAt = performance.now();
      log("container.work.started", { jobId });

      await delay(workDelayMs);
      requestCount += 1;
      const processingMs = Math.round(performance.now() - workStartedAt);

      log("container.work.completed", { jobId, requestCount, processingMs });
      sendJson(response, 200, {
        ok: true,
        jobId,
        instanceId,
        bootId,
        startedAt,
        requestCount,
        processingMs,
      });
      return;
    }

    sendJson(response, 404, { ok: false, error: "Not found" });
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    log("container.request.failed", {
      path: url.pathname,
      status,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    sendJson(response, status, {
      ok: false,
      error: status >= 500 ? "Internal server error" : error.message,
    });
  }
});

server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

function shutdown(signal) {
  if (stopping) {
    return;
  }

  stopping = true;
  log("container.stopping", { signal, requestCount });

  const safetyTimer = setTimeout(() => {
    server.closeAllConnections();
    process.exit(1);
  }, 5_000);
  safetyTimer.unref();

  server.close(() => {
    clearTimeout(safetyTimer);
    process.exit(0);
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

log("container.initializing", { startupDelayMs, workDelayMs });
await delay(startupDelayMs);

if (!stopping) {
  server.listen(PORT, "0.0.0.0", () => {
    log("container.ready", { port: PORT, startupDelayMs });
  });
}
