const POOL_MEMBERS = ["instance-0", "instance-1", "instance-2"];

const state = {
  busy: false,
  jobs: [],
  errors: [],
  knownBootIds: new Set(),
  prewarmedBootIds: new Set(),
  lastPrewarmMs: null,
  members: new Map(
    POOL_MEMBERS.map((name) => [name, {
      name,
      status: "unknown",
      bootId: null,
      previousBootId: null,
      instanceId: null,
      startedAt: null,
      startupMs: null,
      requestCount: null,
    }]),
  ),
};

const elements = {
  actionStatus: document.querySelector("#action-status"),
  actionText: document.querySelector("#action-text"),
  healthBadge: document.querySelector("#health-badge"),
  controls: document.querySelector("#controls"),
  stopPool: document.querySelector("#stop-pool"),
  sendJob: document.querySelector("#send-job"),
  prewarmPool: document.querySelector("#prewarm-pool"),
  runBurst: document.querySelector("#run-burst"),
  clearResults: document.querySelector("#clear-results"),
  coldLatency: document.querySelector("#cold-latency"),
  coldDetail: document.querySelector("#cold-detail"),
  warmLatency: document.querySelector("#warm-latency"),
  warmDetail: document.querySelector("#warm-detail"),
  prewarmLatency: document.querySelector("#prewarm-latency"),
  prewarmDetail: document.querySelector("#prewarm-detail"),
  jobTotal: document.querySelector("#job-total"),
  jobDetail: document.querySelector("#job-detail"),
  distributionList: document.querySelector("#distribution-list"),
  errors: document.querySelector("#errors"),
  errorList: document.querySelector("#error-list"),
  resultsEmpty: document.querySelector("#results-empty"),
  resultsTableWrap: document.querySelector("#results-table-wrap"),
  resultsBody: document.querySelector("#results-body"),
};

const networkControls = [
  elements.stopPool,
  elements.sendJob,
  elements.prewarmPool,
  elements.runBurst,
  elements.clearResults,
];

class ApiError extends Error {
  constructor(message, { status = 0, payload = null, clientMs = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
    this.clientMs = clientMs;
  }
}

function formatMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "—";
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)} s`;
  }
  return `${Math.round(value)} ms`;
}

function formatTime(value) {
  if (typeof value !== "string") {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return "—";
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function shortId(value, length = 8) {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, length)
    : "—";
}

function average(records, field) {
  if (records.length === 0) {
    return null;
  }
  return records.reduce((sum, record) => sum + record[field], 0) / records.length;
}

function plural(count, singular, pluralValue = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

function setAction(message, mode = "ready") {
  elements.actionText.textContent = message;
  elements.actionStatus.classList.toggle("is-busy", mode === "busy");
  elements.actionStatus.classList.toggle("is-error", mode === "error");
}

function renderControls() {
  for (const control of networkControls) {
    control.disabled = state.busy;
  }
  elements.controls.setAttribute("aria-busy", String(state.busy));
}

function addError(action, error) {
  const message = error instanceof Error ? error.message : String(error);
  state.errors.unshift({ action, message, at: new Date() });
  state.errors = state.errors.slice(0, 8);
  renderErrors();
}

async function requestJson(path, init = {}) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 120_000);
  let response;

  try {
    response = await fetch(path, {
      cache: "no-store",
      signal: controller.signal,
      ...init,
    });
  } catch (cause) {
    throw new ApiError(
      cause instanceof Error ? `Network request failed: ${cause.message}` : "Network request failed",
      { clientMs: performance.now() - startedAt },
    );
  } finally {
    window.clearTimeout(timeout);
  }

  const clientMs = performance.now() - startedAt;
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError("The API returned a non-JSON response", {
      status: response.status,
      clientMs,
    });
  }

  if (!response.ok || payload?.ok !== true) {
    throw new ApiError(
      typeof payload?.error === "string" ? payload.error : `API request failed (${response.status})`,
      { status: response.status, payload, clientMs },
    );
  }

  return { payload, clientMs };
}

async function performAction(progressText, action) {
  if (state.busy) {
    return;
  }

  state.busy = true;
  setAction(progressText, "busy");
  renderControls();

  try {
    const completionText = await action();
    setAction(completionText ?? "Action completed", "ready");
  } catch (error) {
    addError(progressText, error);
    setAction(`${progressText} failed`, "error");
  } finally {
    state.busy = false;
    renderControls();
    renderAll();
  }
}

function applyPrewarmMembers(payload) {
  if (!Array.isArray(payload?.members)) {
    return;
  }

  state.prewarmedBootIds.clear();
  for (const result of payload.members) {
    if (!POOL_MEMBERS.includes(result?.name)) {
      continue;
    }

    const previous = state.members.get(result.name);
    if (result.ok === true) {
      const bootChanged = previous.bootId && previous.bootId !== result.bootId;
      state.members.set(result.name, {
        ...previous,
        status: "ready",
        previousBootId: bootChanged ? previous.bootId : previous.previousBootId,
        bootId: result.bootId,
        instanceId: result.instanceId,
        startedAt: result.startedAt,
        startupMs: result.startupMs,
      });
      state.prewarmedBootIds.add(result.bootId);
      state.knownBootIds.add(result.bootId);
    } else {
      state.members.set(result.name, {
        ...previous,
        status: "failed",
        startupMs: result.elapsedMs ?? null,
      });
    }
  }

  state.lastPrewarmMs = typeof payload.totalMs === "number" ? payload.totalMs : null;
}

function applyStopMembers(payload) {
  if (!Array.isArray(payload?.members)) {
    return;
  }

  for (const result of payload.members) {
    if (!POOL_MEMBERS.includes(result?.name)) {
      continue;
    }

    const previous = state.members.get(result.name);
    if (result.ok === true) {
      state.members.set(result.name, { ...previous, status: "stopped" });
      if (previous.bootId) {
        state.prewarmedBootIds.delete(previous.bootId);
      }
    } else {
      state.members.set(result.name, { ...previous, status: "failed" });
    }
  }
}

function updateMemberFromJob(record) {
  if (!record.ok) {
    return;
  }

  for (const [name, member] of state.members) {
    if (member.bootId === record.bootId) {
      state.members.set(name, {
        ...member,
        status: "ready",
        instanceId: record.instanceId,
        startedAt: record.startedAt,
        requestCount: Math.max(member.requestCount ?? 0, record.requestCount),
      });
      break;
    }
  }
}

async function executeJob(jobId, knownAtDispatch) {
  try {
    const { payload, clientMs } = await requestJson("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId }),
    });

    const warm = state.prewarmedBootIds.has(payload.bootId) || knownAtDispatch.has(payload.bootId);
    const record = {
      ok: true,
      classification: warm ? "warm" : "cold",
      jobId: payload.jobId,
      clientMs,
      workerElapsedMs: payload.workerElapsedMs,
      processingMs: payload.processingMs,
      instanceId: payload.instanceId,
      bootId: payload.bootId,
      startedAt: payload.startedAt,
      requestCount: payload.requestCount,
    };

    state.knownBootIds.add(payload.bootId);
    updateMemberFromJob(record);
    return record;
  } catch (error) {
    return {
      ok: false,
      classification: "error",
      jobId,
      clientMs: error instanceof ApiError && error.clientMs !== null ? error.clientMs : 0,
      workerElapsedMs: error instanceof ApiError ? error.payload?.workerElapsedMs : null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function appendJobRecords(records) {
  state.jobs.push(...records);
  renderAll();
}

async function stopPool() {
  try {
    const { payload } = await requestJson("/api/pool/stop", { method: "POST" });
    applyStopMembers(payload);
    return `Pool stopped in ${formatMs(payload.totalMs)}`;
  } catch (error) {
    if (error instanceof ApiError) {
      applyStopMembers(error.payload);
    }
    throw error;
  }
}

async function prewarmPool() {
  try {
    const { payload } = await requestJson("/api/pool/prewarm", { method: "POST" });
    applyPrewarmMembers(payload);
    const uniqueBoots = new Set(payload.members.map((member) => member.bootId)).size;
    return `${uniqueBoots} members ready in ${formatMs(payload.totalMs)}`;
  } catch (error) {
    if (error instanceof ApiError) {
      applyPrewarmMembers(error.payload);
    }
    throw error;
  }
}

async function sendOneJob() {
  const jobId = `ui-${crypto.randomUUID()}`;
  const knownAtDispatch = new Set(state.knownBootIds);
  const record = await executeJob(jobId, knownAtDispatch);
  appendJobRecords([record]);

  if (!record.ok) {
    throw new Error(record.error);
  }
  return `${record.classification === "cold" ? "New boot" : "Reused boot"} returned in ${formatMs(record.clientMs)}`;
}

async function runBurst() {
  const knownAtDispatch = new Set(state.knownBootIds);
  const jobs = Array.from(
    { length: 12 },
    () => executeJob(`burst-${crypto.randomUUID()}`, knownAtDispatch),
  );
  const records = await Promise.all(jobs);
  appendJobRecords(records);

  const failures = records.filter((record) => !record.ok);
  if (failures.length > 0) {
    throw new Error(`${failures.length} of 12 jobs failed`);
  }

  const averageLatency = average(records, "clientMs");
  return `12 jobs completed; average ${formatMs(averageLatency)}`;
}

function clearResults() {
  if (state.busy) {
    return;
  }
  state.jobs = [];
  state.errors = [];
  state.lastPrewarmMs = null;
  setAction("Browser results cleared", "ready");
  renderAll();
}

function renderSummary() {
  const successful = state.jobs.filter((job) => job.ok);
  const cold = successful.filter((job) => job.classification === "cold");
  const warm = successful.filter((job) => job.classification === "warm");
  const failed = state.jobs.length - successful.length;

  elements.coldLatency.textContent = formatMs(average(cold, "clientMs"));
  elements.coldDetail.textContent = cold.length > 0
    ? `${plural(cold.length, "new boot job")} · average`
    : "No new boot observed";

  elements.warmLatency.textContent = formatMs(average(warm, "clientMs"));
  elements.warmDetail.textContent = warm.length > 0
    ? `${plural(warm.length, "reused job")} · average`
    : "No reused boot observed";

  elements.prewarmLatency.textContent = formatMs(state.lastPrewarmMs);
  elements.prewarmDetail.textContent = state.lastPrewarmMs === null
    ? "Start all 3 in parallel"
    : "3 members · one parallel window";

  elements.jobTotal.textContent = String(successful.length);
  elements.jobDetail.textContent = plural(failed, "error");
}

function renderMembers() {
  for (const [name, member] of state.members) {
    const card = document.querySelector(`[data-member="${name}"]`);
    card.dataset.state = member.status;
    card.querySelector(".member-state").textContent = member.status;

    const boot = card.querySelector(".member-boot");
    boot.textContent = shortId(member.bootId);
    boot.title = member.bootId ?? "No boot observed";
    if (member.previousBootId && member.previousBootId !== member.bootId) {
      boot.textContent = `new ${shortId(member.bootId)}`;
      boot.title = `Current: ${member.bootId}\nPrevious: ${member.previousBootId}`;
    }

    const host = card.querySelector(".member-host");
    host.textContent = shortId(member.instanceId, 14);
    host.title = member.instanceId ?? "No host observed";
    card.querySelector(".member-started").textContent = formatTime(member.startedAt);
    card.querySelector(".member-timing").textContent = formatMs(member.startupMs);
  }
}

function renderDistribution() {
  const groups = new Map();
  for (const job of state.jobs) {
    if (!job.ok) {
      continue;
    }
    const group = groups.get(job.bootId) ?? {
      bootId: job.bootId,
      instanceId: job.instanceId,
      count: 0,
    };
    group.count += 1;
    groups.set(job.bootId, group);
  }

  elements.distributionList.replaceChildren();
  if (groups.size === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-copy";
    empty.textContent = "Run jobs to reveal distribution across processes.";
    elements.distributionList.append(empty);
    return;
  }

  const sorted = [...groups.values()].sort((left, right) => right.count - left.count);
  const max = Math.max(...sorted.map((group) => group.count));

  for (const group of sorted) {
    const row = document.createElement("div");
    row.className = "distribution-row";

    const identity = document.createElement("span");
    identity.className = "distribution-row__identity";
    identity.textContent = `${shortId(group.bootId)} / ${shortId(group.instanceId, 10)}`;
    identity.title = `Boot: ${group.bootId}\nHost: ${group.instanceId}`;

    const track = document.createElement("div");
    track.className = "distribution-row__track";
    const bar = document.createElement("div");
    bar.className = "distribution-row__bar";
    bar.style.width = `${(group.count / max) * 100}%`;
    track.append(bar);

    const count = document.createElement("span");
    count.className = "distribution-row__count";
    count.textContent = plural(group.count, "job");

    row.append(identity, track, count);
    elements.distributionList.append(row);
  }
}

function appendCell(row, label, value, title = null) {
  const cell = document.createElement("td");
  cell.dataset.label = label;
  cell.textContent = value;
  if (title) {
    cell.title = title;
  }
  row.append(cell);
  return cell;
}

function renderJobs() {
  elements.resultsBody.replaceChildren();
  elements.resultsEmpty.hidden = state.jobs.length > 0;
  elements.resultsTableWrap.hidden = state.jobs.length === 0;

  for (const job of [...state.jobs].reverse()) {
    const row = document.createElement("tr");
    row.classList.toggle("is-error", !job.ok);

    const pathCell = appendCell(row, "Path", "");
    const tag = document.createElement("span");
    tag.className = `path-tag path-tag--${job.classification}`;
    tag.textContent = job.classification === "cold"
      ? "New boot"
      : job.classification === "warm" ? "Reused" : "Error";
    pathCell.append(tag);

    appendCell(row, "Job", shortId(job.jobId, 12), job.jobId);
    appendCell(row, "Browser", formatMs(job.clientMs));
    appendCell(row, "Worker", formatMs(job.workerElapsedMs));
    appendCell(row, "Work", job.ok ? formatMs(job.processingMs) : job.error);
    appendCell(row, "Instance", job.ok ? shortId(job.instanceId, 10) : "—", job.instanceId);
    appendCell(row, "Boot ID", job.ok ? shortId(job.bootId) : "—", job.bootId);
    appendCell(row, "Started", job.ok ? formatTime(job.startedAt) : "—");
    appendCell(row, "Count", job.ok ? String(job.requestCount) : "—");
    elements.resultsBody.append(row);
  }
}

function renderErrors() {
  elements.errors.hidden = state.errors.length === 0;
  elements.errorList.replaceChildren();

  for (const error of state.errors) {
    const item = document.createElement("li");
    const context = document.createElement("span");
    context.textContent = `${formatTime(error.at.toISOString())} / ${error.action}`;
    const message = document.createElement("span");
    message.textContent = error.message;
    item.append(context, message);
    elements.errorList.append(item);
  }
}

function renderAll() {
  renderSummary();
  renderMembers();
  renderDistribution();
  renderJobs();
  renderErrors();
  renderControls();
}

async function checkHealth() {
  try {
    const { payload } = await requestJson("/api/health");
    elements.healthBadge.textContent = `Worker ready / pool ${payload.poolSize}`;
    elements.healthBadge.classList.add("is-ready");
    if (!state.busy) {
      setAction("Ready for a demo", "ready");
    }
  } catch (error) {
    elements.healthBadge.textContent = "Worker unavailable";
    elements.healthBadge.classList.add("is-error");
    addError("Worker health check", error);
    setAction("Worker health check failed", "error");
  }
}

elements.stopPool.addEventListener("click", () => {
  void performAction("Stopping all 3 members", stopPool);
});
elements.sendJob.addEventListener("click", () => {
  void performAction("Sending one randomly routed job", sendOneJob);
});
elements.prewarmPool.addEventListener("click", () => {
  void performAction("Prewarming all 3 members in parallel", prewarmPool);
});
elements.runBurst.addEventListener("click", () => {
  void performAction("Running 12 jobs concurrently", runBurst);
});
elements.clearResults.addEventListener("click", clearResults);

renderAll();
void checkHealth();
