/////////////////////////////////////////////////////////////////////
// Copyright (c) Autodesk, Inc. All rights reserved
// Written by APS Partner Development
//
// Permission to use, copy, modify, and distribute this software in
// object code form for any purpose and without fee is hereby granted,
// provided that the above copyright notice appears in all copies and
// that both that copyright notice and the limited warranty and
// restricted rights notice below appear in all supporting
// documentation.
//
// AUTODESK PROVIDES THIS PROGRAM "AS IS" AND WITH ALL FAULTS.
// AUTODESK SPECIFICALLY DISCLAIMS ANY IMPLIED WARRANTY OF
// MERCHANTABILITY OR FITNESS FOR A PARTICULAR USE.  AUTODESK, INC.
// DOES NOT WARRANT THAT THE OPERATION OF THE PROGRAM WILL BE
// UNINTERRUPTED OR ERROR FREE.
/////////////////////////////////////////////////////////////////////
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const INSIGHTS = "https://developer.api.autodesk.com/insights/v1";
// The API's own default page size. Raise it to trade more rows per request for
// fewer requests; the paging loop advances by the number of rows the server
// actually returned, so any value the service accepts works.
const PAGE = 100;
// A usage query is asynchronous: it is submitted, then polled until COMPLETED.
// These are safety nets, not the expected wait - a one-week window returns
// quickly, and anything approaching these numbers means something is wrong.
const QUERY_TIMEOUT_MS = 300000;
const EXPORT_TIMEOUT_MS = 300000;
const MAX_ATTEMPTS = 3;
// Being throttled is not an error, so it gets a far longer leash than a 5xx.
const MAX_THROTTLE_ATTEMPTS = 10;
// Only used when Retry-After cannot be read at all. Set above the largest wait
// the service has been seen to ask for, so a retry does not walk straight into
// the same limit; the server's own value is always preferred over this.
const RETRY_AFTER_FALLBACK_MS = 30000;
// How wide a column may be dragged down to.
const MIN_COLUMN_PX = 60;

const DAY_MS = 24 * 60 * 60 * 1000;
// The Active/Inactive split is a 60-day question, so it only becomes meaningful
// once roughly nine weekly windows have been loaded.
const WEEKS_FOR_60_DAYS = 9;

// APS Authentication (v2) uses the Authorization Code flow with PKCE.
// Only a Client ID is needed - a public client must never ship a client secret.
// The callback URL is derived from where the page is served, so the same code
// runs locally and on GitHub Pages. The trailing "index.html" is stripped so
// that browsing to /index.html and to / both produce the same callback URL -
// APS matches callback URLs exactly, so it has to be stable.
const APS_CALLBACK_URL = (window.location.origin + window.location.pathname)
  .replace(/index\.html$/, "")
  .replace(/\/$/, "");
// The Insights API needs data:read for GET, plus data:write because this app
// POSTs to /usage-queries and /exports. Nothing here touches OSS, so no
// bucket:* scope belongs in this list.
const APS_SCOPES = ["data:read", "data:write"];
const APS_AUTHORIZE_URL =
  "https://developer.api.autodesk.com/authentication/v2/authorize";
const APS_TOKEN_URL =
  "https://developer.api.autodesk.com/authentication/v2/token";

// Logging in navigates away to Autodesk and back, which discards in-memory
// state, so the client id and the PKCE verifier have to survive in storage.
// The chosen account is kept for the same reason - it should still be selected
// after the login round trip.
const CLIENT_ID_KEY = "APS_CLIENT_ID";
const CODE_VERIFIER_KEY = "code-verifier";
const STATE_KEY = "auth-state";
const CONTEXT_KEY = "APS_CONTEXT_ID";

// The usage queries this sample runs. contextId and the date window are added
// per request by submitQuery.
//
// There used to be a third query asking for totalUniqueDays and uniqueProducts,
// which fed the single-product table. It was redundant: it grouped by the same
// fullName/productName pair as SPEC_USAGE, so it returned the same rows, and
// uniqueProducts is derivable - because the rows are grouped by product, the
// number of rows a user has *is* their distinct product count. Dropping it
// removes a whole query execution, which is the slow part of a run.
const SPEC_USAGE = {
  fields: ["fullName", "productName"],
  metrics: ["earliestUsageDate", "latestUsageDate", "totalUniqueDays"],
  where: "",
  orderBy: "",
};
// childProductName has to stay a separate query: adding it as a field would
// change the grouping, and so the rows every other table is built from.
const SPEC_CHILD = {
  fields: ["fullName", "productName", "childProductName"],
  metrics: [],
  where: "",
  orderBy: "",
};

// usage-queries has no startDate/endDate parameter - unlike /exports, which
// requires one and caps it at 365 days - so a date window has to go through the
// where clause. The docs give no date example, so these are tried in order
// until the service accepts one, and the winner is reused for the session.
const WHERE_FORMS = [
  (start, end) => `usageDate >= '${start}' AND usageDate <= '${end}'`,
  (start, end) =>
    `usageDate >= '${start}T00:00:00Z' AND usageDate <= '${end}T00:00:00Z'`,
  (start, end) => `usageDate BETWEEN '${start}' AND '${end}'`,
];
// -1 = not yet discovered, null = the service rejected all of them.
let whereForm = -1;

// Accounts ("contexts"/teams) the logged-in admin can report on, and which one
// is currently selected. runId invalidates an in-flight run when the selection
// changes, so a page that arrives late cannot append one account's rows into
// another account's table.
let contexts = [];
let selectedContextId = "";
let runId = 0;
let busyButton = "";

// Rows accumulated across every week loaded so far, keyed so that loading
// another week merges into the existing rows instead of duplicating them.
// usageTotals: "fullName|productName" -> {name, product, earliest, latest, days}
// childTotals: "fullName|productName|childProductName" -> {name, product, child}
const usageTotals = new Map();
const childTotals = new Map();
const loadedWeeks = new Set();
// Per-query progress lines, so two concurrent drains can share one status line.
const progressLines = new Map();

// Week 0 is the last 7 days, week 1 the 7 before that, and so on. The windows
// are rolling and therefore disjoint, which is what makes the day counts
// addable when a week is merged in.
function weekWindow(index) {
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const endMs = today - index * 7 * DAY_MS;
  const startMs = endMs - 6 * DAY_MS;
  return {
    startMs: startMs,
    endMs: endMs,
    start: new Date(startMs).toISOString().slice(0, 10),
    end: new Date(endMs).toISOString().slice(0, 10),
  };
}

// Fixed to en-GB rather than the browser locale: every other label on the page
// is English, and usage dates are UTC days, so rendering them in local time
// would shift them by a day either side of midnight.
function shortDate(ms) {
  return Number.isFinite(ms)
    ? new Date(ms).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      })
    : "-";
}

function generateRandomString(length) {
  const allowed =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => allowed[b % allowed.length]).join("");
}

async function generateCodeChallenge(verifier) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return window
    .btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function exchangeToken(clientId, codeVerifier, code) {
  const payload = {
    grant_type: "authorization_code",
    client_id: clientId,
    code_verifier: codeVerifier,
    code: code,
    redirect_uri: APS_CALLBACK_URL,
  };
  const res = await fetch(APS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: Object.keys(payload)
      .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(payload[k]))
      .join("&"),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error_description || json.error || res.statusText);
  }
  return json;
}

/////////////////////////////////////////////////////////////////////
// Page feedback
/////////////////////////////////////////////////////////////////////

// Progress goes to #para and errors to #para1, styled with Bootstrap's alert
// classes (the CSS is already loaded). textContent, not innerHTML: the strings
// include API-supplied messages and user names.
function setStatus(msg) {
  const el = document.getElementById("para");
  el.textContent = msg || "";
  el.className = msg ? "alert alert-info" : "";
}

function setError(err) {
  const el = document.getElementById("para1");
  const msg = err ? err.message || String(err) : "";
  el.textContent = msg;
  el.className = msg ? "alert alert-danger" : "";
}

// True once the run that called it has been superseded by a newer one.
function stale(myRun) {
  return myRun !== runId;
}

function setBusy(buttonId) {
  busyButton = buttonId || "";
  syncUi();
}

function syncUi() {
  const select = document.getElementById("contextSelect");
  const usage = document.getElementById("GetUsageInformation");
  const prior = document.getElementById("loadPriorWeek");
  const exportBtn = document.getElementById("viewAllExport");
  const busy = Boolean(busyButton);
  // Nothing can be requested until we know which account to request it for.
  const ready = Boolean(premiumApi.access_token) && Boolean(selectedContextId);

  select.disabled = busy || contexts.length === 0;
  usage.disabled = busy || !ready;
  exportBtn.disabled = busy || !ready;
  usage.textContent =
    busyButton === "GetUsageInformation" ? "Loading" : "Load last week";
  exportBtn.textContent =
    busyButton === "viewAllExport"
      ? "Loading"
      : "Download Export Usage Query API Data";

  // Only offer to go further back once there is something to extend, and name
  // the window so the cost of the click is obvious.
  const next = weekWindow(loadedWeeks.size);
  prior.style.display = loadedWeeks.size === 0 ? "none" : "";
  prior.disabled = busy || !ready;
  prior.textContent =
    busyButton === "loadPriorWeek"
      ? "Loading"
      : `Load prior week (${shortDate(next.startMs)} to ${shortDate(
          next.endMs
        )})`;

  document.getElementById("LogIn").innerText = premiumApi.access_token
    ? premiumApi.LogIn[1]
    : premiumApi.LogIn[0];
}

// Bootstrap's collapse plugin needs jQuery, which this sample no longer loads.
// Its CSS is all that is required: .collapse hides, .collapse.in shows.
function showCollapse(...ids) {
  ids.forEach((id) => document.getElementById(id).classList.add("in"));
}

function toggleCollapse(id) {
  document.getElementById(id).classList.toggle("in");
}

/////////////////////////////////////////////////////////////////////
// Insights API
/////////////////////////////////////////////////////////////////////

// Rate limits are counted per user across every application they use, so a 429
// is a statement about the whole client, not about one request. Retry-After is
// therefore recorded here and respected by *every* subsequent call - otherwise
// the concurrently running second query, or the next page of the one that was
// throttled, would fire straight back into the same limit.
let throttledUntil = 0;

// How long to wait after a 429. The server's Retry-After value is always
// preferred - it is the only figure that is actually correct - and is used
// verbatim, whether it arrives as a number of seconds or as an HTTP date.
//
// Returns {ms, source} so the caller can say which one it used, because the
// difference matters when diagnosing a throttled run.
function retryAfterMs(res) {
  const header = res.headers.get("Retry-After");

  const seconds = parseInt(header, 10);
  if (Number.isFinite(seconds)) {
    return { ms: seconds * 1000, source: `Retry-After: ${seconds}s` };
  }
  const until = Date.parse(header);
  if (Number.isFinite(until)) {
    return {
      ms: Math.max(0, until - Date.now()),
      source: `Retry-After date: ${header}`,
    };
  }

  // The header was not readable. On a cross-origin call that is usually CORS
  // rather than a missing header: unless the response lists Retry-After in
  // Access-Control-Expose-Headers, the browser hides it from script even though
  // it is plainly there in the network panel. Log what *was* visible so this is
  // provable rather than guessed at.
  console.warn(
    "[insights] 429 received but Retry-After was not readable from script.",
    {
      rawValue: header,
      readableHeaders: [...res.headers.keys()],
      note: "If the network panel shows a Retry-After that is missing from readableHeaders, the server is not exposing it via Access-Control-Expose-Headers and no client-side change can read it.",
      fallbackSeconds: RETRY_AFTER_FALLBACK_MS / 1000,
    }
  );
  return {
    ms: RETRY_AFTER_FALLBACK_MS,
    source: `Retry-After unreadable, using ${
      RETRY_AFTER_FALLBACK_MS / 1000
    }s fallback`,
  };
}

// Every Insights call goes through here, so authentication, throttling and
// error reporting are handled in exactly one place. _attempt is internal.
async function apiFetch(url, options = {}, _attempt = 0) {
  if (!premiumApi.access_token) throw new Error("Not logged in.");

  // Hold off if a previous 429 asked us to wait, however unrelated this call is.
  const waitFor = throttledUntil - Date.now();
  if (waitFor > 0) {
    setStatus(
      `Rate limited - waiting ${Math.ceil(
        waitFor / 1000
      )}s before the next request...`
    );
    await delay(waitFor);
  }

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${premiumApi.access_token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  // Read the body once, and only treat it as JSON if it parses: gateway errors
  // come back as HTML, which would otherwise surface as a JSON SyntaxError
  // instead of the status that actually explains the failure.
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch (_) {
    body = {};
  }
  if (res.ok) return body;

  // The per-user rate limit was hit. Record what the server asked for so that
  // every other pending call waits too, then retry this one. 429s get a much
  // larger allowance than other failures: waiting is exactly the right response
  // and the limit always clears, so giving up early just loses work.
  if (res.status === 429 && _attempt < MAX_THROTTLE_ATTEMPTS - 1) {
    const retry = retryAfterMs(res);
    throttledUntil = Math.max(throttledUntil, Date.now() + retry.ms);
    // Naming the source makes it obvious whether the server's own figure was
    // used or whether it had to be guessed.
    setStatus(
      `Rate limited - waiting ${Math.ceil(retry.ms / 1000)}s (${
        retry.source
      }), attempt ${_attempt + 2} of ${MAX_THROTTLE_ATTEMPTS}...`
    );
    await delay(retry.ms);
    return apiFetch(url, options, _attempt + 1);
  }

  // A 5xx is worth a couple of backed-off retries. Other 4xx will not fix
  // themselves.
  if (res.status >= 500 && _attempt < MAX_ATTEMPTS - 1) {
    const waitMs = 1000 * Math.pow(2, _attempt);
    setStatus(
      `Server returned ${res.status}, retrying in ${Math.round(
        waitMs / 1000
      )}s...`
    );
    await delay(waitMs);
    return apiFetch(url, options, _attempt + 1);
  }

  // Always lead with the status: a 403's "detail" is often just "No further
  // detail provided", which on its own says nothing about what went wrong.
  const detail = body.detail || body.developerMessage || body.title || "";
  const error = new Error(
    `${res.status} ${res.statusText}${detail ? " - " + detail : ""}`
  );
  // Carried so callers can branch on the status without parsing the message -
  // the where-clause discovery in submitQuery needs to spot a 400.
  error.status = res.status;
  throw error;
}

// Returns one entry per account/team the user administers.
function fetchContexts() {
  return apiFetch(`${INSIGHTS}/contexts`);
}

function postQuery(spec, contextId, where) {
  const id = encodeURIComponent(contextId);
  return apiFetch(
    // The reference documents this parameter as contextId, but the tutorial
    // uses context - and an unscoped query reads every account the admin
    // manages, which is both the original bug and very slow. Both spellings go
    // out, in the query string and the body; the unused one is ignored.
    `${INSIGHTS}/usage-queries?offset=0&limit=${PAGE}&contextId=${id}&context=${id}`,
    {
      method: "POST",
      body: JSON.stringify({
        ...spec,
        where: where,
        contextId: contextId,
        context: contextId,
      }),
    }
  );
}

async function submitQuery(spec, contextId, range) {
  // Syntax already known, or already known to be unsupported.
  if (whereForm !== -1) {
    const where =
      whereForm === null ? "" : WHERE_FORMS[whereForm](range.start, range.end);
    const res = await postQuery(spec, contextId, where);
    return res.id;
  }

  // First query of the session: find a date filter the service accepts. A
  // rejected query costs a round trip but no query execution.
  for (let i = 0; i < WHERE_FORMS.length; i++) {
    try {
      const res = await postQuery(
        spec,
        contextId,
        WHERE_FORMS[i](range.start, range.end)
      );
      whereForm = i;
      return res.id;
    } catch (err) {
      // Only a rejected clause is worth retrying with different syntax; auth
      // and permission failures would fail identically every time.
      if (err.status !== 400) throw err;
    }
  }

  // Nothing worked, so the window cannot be applied. Fall back to an unfiltered
  // query - the old behaviour - and say so, because it will be slow and the
  // "covering" range no longer means anything.
  whereForm = null;
  setError(
    new Error(
      "This account rejected every date filter this sample knows, so the full usage history was queried instead. Expect a long wait, and read the coverage note as covering all history."
    )
  );
  const res = await postQuery(spec, contextId, "");
  return res.id;
}

// Polls until a submitted query has results. Returns the first page, which the
// final poll already fetched.
async function pollQuery(queryId, myRun) {
  const started = Date.now();
  let attempt = 0;
  let last = "SUBMITTED";
  for (;;) {
    if (stale(myRun)) throw new Error("cancelled");
    const res = await apiFetch(
      `${INSIGHTS}/usage-queries/${queryId}?offset=0&limit=${PAGE}`
    );
    if (res.status === "COMPLETED") return res;
    if (res.status === "ERROR" || res.status === "EXPIRED") {
      throw new Error(`Query finished with status ${res.status}.`);
    }
    last = res.status || last;
    if (Date.now() - started > QUERY_TIMEOUT_MS) {
      // Naming the last status distinguishes "the service is still working" from
      // "we never got a usable answer", which a bare timeout does not.
      throw new Error(
        `Query ${queryId} was still ${last} after ${
          QUERY_TIMEOUT_MS / 1000
        }s. Try a single week, or an account with less usage.`
      );
    }
    attempt++;
    await delay(Math.min(1000 * attempt, 10000));
  }
}

// Walks every page of a query's results, handing each one to onPage as it
// arrives so the tables fill in progressively instead of in one late burst.
async function drainQuery(queryId, myRun, onPage) {
  let page = await pollQuery(queryId, myRun);
  const total =
    (page.pagination && page.pagination.totalResults) ||
    (page.rows || []).length;
  let seen = 0;
  for (;;) {
    if (stale(myRun)) return;
    const rows = page.rows || [];
    seen += rows.length;
    onPage(page.columns || [], rows, seen, total);
    // Advance by the rows actually returned rather than by PAGE, and stop on an
    // empty page, so a short page can neither skip rows nor loop forever.
    if (rows.length === 0 || seen >= total) return;
    page = await apiFetch(
      `${INSIGHTS}/usage-queries/${queryId}?offset=${seen}&limit=${PAGE}`
    );
  }
}

async function submitExport(reports, contextId) {
  const res = await apiFetch(`${INSIGHTS}/exports`, {
    method: "POST",
    // Without teamId the export covers every team the user manages.
    body: JSON.stringify({
      teamId: contextId,
      outputFormat: "EXCEL",
      reports: reports,
    }),
  });
  return res.id;
}

// An export is only downloadable once it reports COMPLETED - downloads[] is
// empty while it is still SUBMITTED.
async function pollExport(exportId, myRun) {
  const started = Date.now();
  let attempt = 0;
  for (;;) {
    if (stale(myRun)) throw new Error("cancelled");
    const res = await apiFetch(`${INSIGHTS}/exports/${exportId}`);
    if (res.status === "COMPLETED") return res;
    if (res.status === "ERROR" || res.status === "EXPIRED") {
      throw new Error(`Export finished with status ${res.status}.`);
    }
    if (Date.now() - started > EXPORT_TIMEOUT_MS) {
      throw new Error(
        `Timed out waiting for the export after ${EXPORT_TIMEOUT_MS / 1000}s.`
      );
    }
    attempt++;
    setStatus(`Export ${res.status || "SUBMITTED"}...`);
    await delay(Math.min(2000 * Math.pow(1.5, attempt - 1), 10000));
  }
}

/////////////////////////////////////////////////////////////////////
// Account dropdown
/////////////////////////////////////////////////////////////////////

function placeholderOption(select, text) {
  select.innerHTML = "";
  const option = document.createElement("option");
  option.value = "";
  option.textContent = text;
  select.appendChild(option);
}

function populateContextSelect(list) {
  const select = document.getElementById("contextSelect");
  if (!list.length) {
    placeholderOption(select, "No accounts found");
    selectedContextId = "";
    return;
  }

  select.innerHTML = "";
  list.forEach((ctx) => {
    const benefits = ctx.reportingBenefits || [];
    // Without this benefit the query API answers, but with no data - saying so
    // up front beats an empty table with no explanation.
    const usable = benefits.indexOf("ReportingAPIAccess") !== -1;
    const option = document.createElement("option");
    option.value = ctx.contextId;
    option.textContent =
      (ctx.alias || ctx.contextId) + (usable ? "" : " — no API access");
    option.disabled = !usable;
    select.appendChild(option);
  });

  // Keep the account chosen before the login redirect, if it is still usable.
  const remembered = localStorage.getItem(CONTEXT_KEY);
  const usableIds = list
    .filter(
      (c) => (c.reportingBenefits || []).indexOf("ReportingAPIAccess") !== -1
    )
    .map((c) => c.contextId);
  selectedContextId =
    usableIds.indexOf(remembered) !== -1 ? remembered : usableIds[0] || "";
  select.value = selectedContextId;
}

/////////////////////////////////////////////////////////////////////
// Result tables
/////////////////////////////////////////////////////////////////////

const HEADERS = {
  activeh: [
    "Full Name",
    "Product Name",
    "Earliest Usage Date",
    "Latest Usage Date",
    "Total Unique Days",
    "Potential Flex Candidate(7 days or less)",
    "Active Users(60 days)",
  ],
  inactiveh: [
    "Full Name",
    "Product Name",
    "Earliest Usage Date",
    "Latest Usage Date",
    "Total Unique Days",
    "Potential Flex Candidate(7 days or less)",
    "Inactive Users(60 days)",
  ],
  getData402: [
    "Users who can be moved to a collection",
    "Product Name",
    "Child Product Name",
  ],
  get208: [
    "Users who are only utilizing one product from a collection.",
    "Child Product Name",
    "Total Unique Days",
    "Unique Products",
  ],
};

const BODIES = ["active", "inactive", "getData403", "get209"];

function esc(value) {
  return String(value == null ? "" : value).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

function row(cells) {
  return (
    "<tr>" + cells.map((c) => "<td>" + esc(c) + "</td>").join("") + "</tr>"
  );
}

// Widens or narrows one column by dragging its header's trailing edge.
function beginColumnResize(event, table, th) {
  // Without this the drag selects the header text instead.
  event.preventDefault();

  // Freeze the browser's auto-computed widths before switching to a fixed
  // layout. Done on the first drag rather than up front so the tables still
  // size themselves naturally to their content until someone intervenes.
  if (table.style.tableLayout !== "fixed") {
    table.querySelectorAll("thead th").forEach((cell) => {
      cell.style.width = cell.offsetWidth + "px";
    });
    table.style.tableLayout = "fixed";
  }

  const startX = event.pageX;
  const startWidth = th.offsetWidth;
  const onMove = (moveEvent) => {
    const width = Math.max(
      MIN_COLUMN_PX,
      startWidth + moveEvent.pageX - startX
    );
    th.style.width = width + "px";
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.classList.remove("resizing-column");
  };
  document.body.classList.add("resizing-column");
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// Appends a drag handle to every header cell of a table.
function addColumnResizers(table) {
  table.querySelectorAll("thead th").forEach((th) => {
    const grip = document.createElement("span");
    grip.className = "col-resizer";
    // Empty, so it adds nothing to the text the excel export reads.
    th.appendChild(grip);
    grip.addEventListener("mousedown", (event) =>
      beginColumnResize(event, table, th)
    );
  });
}

// Clears the four result tables and writes their headers. The tbody elements
// are only ever emptied and refilled, never replaced - the inline "Export
// table to excel" handlers reach them through their parent tables.
function resetTables() {
  Object.keys(HEADERS).forEach((id) => {
    const thead = document.getElementById(id);
    thead.innerHTML =
      "<tr>" +
      HEADERS[id].map((h) => "<th>" + esc(h) + "</th>").join("") +
      "</tr>";
    // Rewriting the header wiped the previous handles, so re-attach. Any
    // widths the user had dragged reset with them, which is what you want when
    // a fresh report is starting. renderTables() only touches the tbodies, so
    // loading another week leaves the column widths alone.
    const table = thead.closest("table");
    table.style.tableLayout = "";
    addColumnResizers(table);
  });
  BODIES.forEach((id) => (document.getElementById(id).innerHTML = ""));
}

// Locates a column by name so a change to the query specs cannot silently
// shift every value by one, falling back to its expected position.
function colIndex(columns, name, fallback) {
  const found = columns.findIndex((c) => c === name || (c && c.name === name));
  return found === -1 ? fallback : found;
}

// Merges one page of usage rows into usageTotals. Because the weekly windows
// never overlap, a distinct-day count from a new week simply adds to the
// running total, and the first/last usage dates extend the known range.
function collectUsage(columns, rows) {
  const iName = colIndex(columns, "fullName", 0);
  const iProduct = colIndex(columns, "productName", 1);
  const iEarliest = colIndex(columns, "earliestUsageDate", 2);
  const iLatest = colIndex(columns, "latestUsageDate", 3);
  const iDays = colIndex(columns, "totalUniqueDays", 4);

  rows.forEach((r) => {
    const name = r[iName];
    const product = r[iProduct];
    const earliest = Date.parse(r[iEarliest]);
    const latest = Date.parse(r[iLatest]);
    const days = Number(r[iDays]) || 0;
    const key = name + "|" + product;
    const found = usageTotals.get(key);
    if (!found) {
      usageTotals.set(key, {
        name: name,
        product: product,
        earliest: earliest,
        latest: latest,
        days: days,
      });
      return;
    }
    if (Number.isFinite(earliest) && !(earliest >= found.earliest)) {
      found.earliest = earliest;
    }
    if (Number.isFinite(latest) && !(latest <= found.latest)) {
      found.latest = latest;
    }
    found.days += days;
  });
}

// Keyed on all three columns, so re-reading a week overwrites rather than
// duplicating.
function collectChild(columns, rows) {
  const iName = colIndex(columns, "fullName", 0);
  const iProduct = colIndex(columns, "productName", 1);
  const iChild = colIndex(columns, "childProductName", 2);

  rows.forEach((r) => {
    childTotals.set(r[iName] + "|" + r[iProduct] + "|" + r[iChild], {
      name: r[iName],
      product: r[iProduct],
      child: r[iChild],
    });
  });
}

// Rebuilds all four tables from everything accumulated so far. Called once per
// loaded week rather than per page: a few thousand rows re-render
// imperceptibly, and one user stays one row no matter how many weeks are in.
function renderTables() {
  // Rows are grouped by product, so counting a user's rows gives their exact
  // distinct product count - no uniqueProducts metric needed.
  const productCount = new Map();
  usageTotals.forEach((entry) => {
    productCount.set(entry.name, (productCount.get(entry.name) || 0) + 1);
  });

  const byName = (a, b) =>
    String(a.name).localeCompare(String(b.name)) ||
    String(a.product).localeCompare(String(b.product));
  // Sorted so a row keeps its position when another week is merged in.
  const entries = [...usageTotals.values()].sort(byName);
  const activeCutoff = Date.now() - 60 * DAY_MS;

  let activeHtml = "";
  let inactiveHtml = "";
  let singleHtml = "";
  entries.forEach((entry) => {
    const isActive = entry.latest >= activeCutoff;
    const cells = [
      entry.name,
      entry.product,
      shortDate(entry.earliest),
      shortDate(entry.latest),
      entry.days,
      entry.days >= 7 ? "No" : "Yes",
      isActive ? "Active" : "Inactive",
    ];
    if (isActive) activeHtml += row(cells);
    else inactiveHtml += row(cells);
    // Someone using a single product from a collection, on five days or fewer.
    if (entry.days <= 5 && productCount.get(entry.name) === 1) {
      singleHtml += row([entry.name, entry.product, entry.days, 1]);
    }
  });

  // A user on a standalone product whose name matches its parent collection can
  // be moved onto that collection.
  const collectionHtml = [...childTotals.values()]
    .sort(byName)
    .filter((entry) => entry.product === entry.child)
    .map((entry) => row([entry.name, entry.product, entry.child]))
    .join("");

  // Assigning innerHTML keeps the tbody nodes themselves, which the inline
  // "Export table to excel" handlers reach through their parent tables.
  document.getElementById("active").innerHTML = activeHtml;
  document.getElementById("inactive").innerHTML = inactiveHtml;
  document.getElementById("get209").innerHTML = singleHtml;
  document.getElementById("getData403").innerHTML = collectionHtml;
}

// Wraps a collector so every page also updates its share of the status line.
// Two queries drain at once, so each keeps its own entry.
function withProgress(label, collect) {
  return (columns, rows, seen, total) => {
    collect(columns, rows);
    progressLines.set(label, `${label} ${seen}/${total}`);
    setStatus([...progressLines.values()].join("   "));
  };
}

function forgetLoadedWeeks() {
  usageTotals.clear();
  childTotals.clear();
  loadedWeeks.clear();
  progressLines.clear();
}

// States how much history the tables actually cover, and whether that is enough
// for the columns that ask a 60-day question. Without this a single loaded week
// reads as fact: almost every user clears the 7-day Flex threshold, and a truly
// inactive user has no rows at all, so cannot appear.
function updateCoverage() {
  const el = document.getElementById("coverage");
  if (loadedWeeks.size === 0) {
    el.textContent = "";
    el.className = "";
    return;
  }
  const weeks = loadedWeeks.size;
  const newest = weekWindow(0);
  const oldest = weekWindow(weeks - 1);
  const span =
    whereForm === null
      ? "all available history"
      : `${shortDate(oldest.startMs)} to ${shortDate(newest.endMs)}`;
  const missing = WEEKS_FOR_60_DAYS - weeks;
  el.textContent =
    `Covering ${span} (${weeks} week${weeks === 1 ? "" : "s"}).` +
    (whereForm !== null && missing > 0
      ? ` The Inactive and Flex-candidate columns need about 60 days to be meaningful - load ${missing} more week${
          missing === 1 ? "" : "s"
        }.`
      : "");
  el.className =
    missing > 0 && whereForm !== null
      ? "alert alert-warning"
      : "alert alert-success";
}

/////////////////////////////////////////////////////////////////////

var premiumApi = {
  access_token: "",
  LogIn: ["Log In", "Logged In"],
  onLoad: async function () {
    const clientIdInput = document.getElementById("client_id");
    const storedClientId = localStorage.getItem(CLIENT_ID_KEY) || "";
    if (clientIdInput) clientIdInput.value = storedClientId;

    const params = new URLSearchParams(window.location.search);
    const authError = params.get("error");
    const code = params.get("code");
    if (authError) {
      setError(new Error(params.get("error_description") || authError));
      window.history.replaceState({}, document.title, APS_CALLBACK_URL);
    } else if (code) {
      // Read the one-time values out before clearing them.
      const expectedState = localStorage.getItem(STATE_KEY);
      const codeVerifier = localStorage.getItem(CODE_VERIFIER_KEY);
      const returnedState = params.get("state");

      // An authorization code is single use, so drop it from the address bar
      // and from history before doing anything else. Otherwise a refresh
      // replays a spent code and surfaces a confusing error.
      window.history.replaceState({}, document.title, APS_CALLBACK_URL);
      localStorage.removeItem(STATE_KEY);
      localStorage.removeItem(CODE_VERIFIER_KEY);

      if (!expectedState || returnedState !== expectedState) {
        setError(
          new Error(
            "Authorization state mismatch - the login response did not come from a request this page started. Please log in again."
          )
        );
      } else {
        try {
          const token = await exchangeToken(storedClientId, codeVerifier, code);
          premiumApi.access_token = token.access_token;
        } catch (err) {
          setError(err);
        }
      }
    }

    syncUi();
    if (!premiumApi.access_token) return;

    try {
      setStatus("Loading accounts...");
      const list = await fetchContexts();
      contexts = Array.isArray(list) ? list : [];
      populateContextSelect(contexts);
      setStatus("");
    } catch (err) {
      setError(err);
    }
    syncUi();
  },

  onContextChange: function () {
    // Invalidate anything still in flight for the previous account, so its
    // pages cannot land in the table now showing a different account.
    runId++;
    selectedContextId = document.getElementById("contextSelect").value;
    localStorage.setItem(CONTEXT_KEY, selectedContextId);
    // Another account's rows are not comparable, so the accumulated weeks go
    // with it.
    forgetLoadedWeeks();
    resetTables();
    updateCoverage();
    setStatus("");
    setError("");
    // The cancelled run will not release the buttons itself - it can no longer
    // tell whether the busy state still belongs to it.
    setBusy("");
  },

  // Loads one 7-day window and merges it into whatever is already loaded.
  loadWeek: async function (index, buttonId) {
    if (loadedWeeks.has(index)) return;
    const myRun = ++runId;
    setError("");
    showCollapse("demo", "demo1", "demo2", "demo4");
    setBusy(buttonId);
    progressLines.clear();
    const range = weekWindow(index);
    try {
      // Both queries are submitted first so the service runs them at the same
      // time, then drained concurrently - one slow query no longer holds up the
      // other, which is what made a full run feel endless.
      //
      // The very first submission of a session goes alone, because it is the
      // one that discovers the date-filter syntax; sending both at once would
      // make each of them pay for the same rejected attempts.
      let idUsage;
      let idChild;
      if (whereForm === -1) {
        idUsage = await submitQuery(SPEC_USAGE, selectedContextId, range);
        idChild = await submitQuery(SPEC_CHILD, selectedContextId, range);
      } else {
        [idUsage, idChild] = await Promise.all([
          submitQuery(SPEC_USAGE, selectedContextId, range),
          submitQuery(SPEC_CHILD, selectedContextId, range),
        ]);
      }
      await Promise.all([
        drainQuery(idUsage, myRun, withProgress("Usage", collectUsage)),
        drainQuery(idChild, myRun, withProgress("Collections", collectChild)),
      ]);
      if (stale(myRun)) return;

      // Only count the week once both queries have fully drained, so a failure
      // part way through does not leave a half-merged week counted as loaded.
      loadedWeeks.add(index);
      renderTables();
      updateCoverage();
      setStatus(
        `Loaded ${shortDate(range.startMs)} to ${shortDate(range.endMs)}.`
      );
    } catch (err) {
      if (!stale(myRun)) setError(err);
    } finally {
      if (!stale(myRun)) setBusy("");
    }
  },

  // Starts a fresh report at the most recent week.
  getusage: function () {
    forgetLoadedWeeks();
    resetTables();
    updateCoverage();
    return premiumApi.loadWeek(0, "GetUsageInformation");
  },

  // Extends the report one week further back. Weeks load contiguously, so the
  // next one to fetch is always the count of those already in.
  loadPriorWeek: function () {
    return premiumApi.loadWeek(loadedWeeks.size, "loadPriorWeek");
  },

  viewallexport: async function () {
    const myRun = ++runId;
    setError("");
    setBusy("viewAllExport");
    try {
      setStatus("Requesting export...");
      const exportId = await submitExport(["SUBSCRIPTIONS"], selectedContextId);
      const result = await pollExport(exportId, myRun);
      const url = ((result.downloads || [])[0] || {}).downloadURL;
      if (!url) throw new Error("The export completed with no download URL.");

      // Download this file in order to save it in a SharePoint location, which
      // can then be used for the PowerBI integration.
      document.getElementById("d").textContent = url;
      const anchor = document.getElementById("downloadAnchorElem");
      anchor.setAttribute("href", url);
      anchor.setAttribute("download", "insights-export.xlsx");
      anchor.click();
      setStatus("Export downloaded.");
    } catch (err) {
      if (!stale(myRun)) setError(err);
    } finally {
      if (!stale(myRun)) setBusy("");
    }
  },

  logIn: async function () {
    const clientIdInput = document.getElementById("client_id");
    const clientId = (clientIdInput ? clientIdInput.value : "").trim();
    if (!clientId) {
      setError(
        new Error("Please enter your APS app Client ID before logging in.")
      );
      return;
    }
    try {
      const codeVerifier = generateRandomString(64);
      const state = generateRandomString(16);
      localStorage.setItem(CLIENT_ID_KEY, clientId);
      localStorage.setItem(CODE_VERIFIER_KEY, codeVerifier);
      localStorage.setItem(STATE_KEY, state);
      setError("");

      const url = new URL(APS_AUTHORIZE_URL);
      url.searchParams.append("response_type", "code");
      url.searchParams.append("client_id", clientId);
      url.searchParams.append("redirect_uri", APS_CALLBACK_URL);
      url.searchParams.append("scope", APS_SCOPES.join(" "));
      // state, not nonce: state is what protects the callback against CSRF.
      // nonce only does anything when the openid scope is requested, which it
      // isn't here, so it was pure noise in the request.
      url.searchParams.append("state", state);
      url.searchParams.append(
        "code_challenge",
        await generateCodeChallenge(codeVerifier)
      );
      url.searchParams.append("code_challenge_method", "S256");
      window.location = url.toString();
    } catch (err) {
      setError(err);
    }
  },

  showInfo: function (text) {
    document.getElementById("Info").value = text;
  },

  logOut: function () {
    console.log("logOut");
    runId++;
    premiumApi.access_token = "";
    contexts = [];
    selectedContextId = "";
    localStorage.removeItem(CODE_VERIFIER_KEY);
    localStorage.removeItem(CONTEXT_KEY);
    location.href = APS_CALLBACK_URL;
  },
};
