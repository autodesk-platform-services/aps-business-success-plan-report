# How the API data becomes the four tables

A plain-language walkthrough of everything that happens between the Insights API
response and the rows on screen, so the same behaviour can be rebuilt in another
app. All of the logic described here lives in `js/methods.js`.

## 1. The big picture

```
                    +-- Query A: usage ------+
one 7-day window -->|                        |--> two in-memory Maps --> 4 tables
                    +-- Query B: children ---+       (merged, keyed)      (derived)
```

Three ideas carry the whole design:

1. **Two queries, not four tables' worth.** Only two API queries are ever run.
   All four tables are *derived* from their results.
2. **Two Maps are the single source of truth.** Every page of every week is
   merged into `usageTotals` and `childTotals`. Nothing else is stored.
3. **Re-render from scratch.** After each week loads, the tables are rebuilt
   from the Maps. Rows are never appended to the DOM incrementally.

## 2. The two queries

Both are POSTed to `/insights/v1/usage-queries`, scoped to one account
(`contextId`), with a `where` clause limiting them to a 7-day window.

**Query A - usage** (drives 3 of the 4 tables)

```json
{ "fields":  ["fullName", "productName"],
  "metrics": ["earliestUsageDate", "latestUsageDate", "totalUniqueDays"] }
```

**Query B - children** (drives the 4th table)

```json
{ "fields": ["fullName", "productName", "childProductName"], "metrics": [] }
```

The `fields` list *is* the GROUP BY. That single fact explains two things:

- Query A returns **one row per (user, product)** pair - already aggregated
  server-side.
- Query B has to be a separate query: adding `childProductName` to Query A would
  change the grouping, and so change every row the other tables read.

The response is column-oriented:

```json
{ "columns": ["fullName", "productName", "earliestUsageDate", "..."],
  "rows":    [["Ada Lovelace", "AutoCAD", "2026-08-01", "2026-08-30", 12]],
  "pagination": { "totalResults": 4210 } }
```

Columns are looked up **by name** (`colIndex`), with the positional index only
as a fallback - so a change to the spec cannot silently shift every value by one.

## 3. Paging

A query is asynchronous: POST returns an id, then GET it until
`status === "COMPLETED"`. Then walk the pages:

```
seen = 0
loop:
  handle page.rows                  # merge into the Maps immediately
  seen += page.rows.length          # advance by rows RETURNED, not by page size
  stop if rows.length == 0 or seen >= pagination.totalResults
  fetch ?offset=seen&limit=100
```

Advancing by rows actually returned (rather than by the requested limit) means a
short page can neither skip rows nor loop forever.

## 4. Deduplication - the two Maps

Yes, there is deduplication, and it is done entirely with **Map keys**. There is
no scan for duplicates and no `distinct` pass anywhere.

### `usageTotals` - key: `fullName|productName`

```js
{ name, product, earliest, latest, days }
```

Merge rule when the key already exists:

| Field      | Rule                 | Effect                             |
|------------|----------------------|------------------------------------|
| `earliest` | keep the **minimum** | extends the known range backwards  |
| `latest`   | keep the **maximum** | extends it forwards                |
| `days`     | **add** (`+=`)       | see the note below                 |

The comparisons are written as `if (!(earliest >= found.earliest))` rather than
`<`, so a value that failed to parse (`NaN`) is rejected instead of overwriting
a good one.

> **Why adding `days` is safe.** The weekly windows are *disjoint* - week 0 is
> the last 7 days, week 1 the 7 before that, and so on, with no overlap. A
> distinct-day count from a fresh week therefore cannot double-count a day
> already in the total. This is the one assumption the whole aggregation rests
> on: **if your windows can overlap, you must not add.**

A `loadedWeeks` Set guards the other direction - a week already loaded is never
fetched twice.

### `childTotals` - key: `fullName|productName|childProductName`

```js
{ name, product, child }
```

Merge rule: **overwrite**. There is nothing to accumulate - the row is just the
fact that this user touched this child product - so re-reading a week replaces
the entry instead of duplicating it.

## 5. The derived tables

All four are built in one pass over `usageTotals`, plus one over `childTotals`.

First, one helper count:

```js
// rows are grouped by product, so a user's row COUNT is their distinct
// product count - no "uniqueProducts" metric is needed from the API
productCount = countBy(usageTotals.values(), e => e.name)
```

Then, with `activeCutoff = now - 60 days`:

| Table | Source | Condition | Columns |
|---|---|---|---|
| **Active users** | `usageTotals` | `latest >= activeCutoff` | name, product, earliest, latest, days, flex, "Active" |
| **Inactive users** | `usageTotals` | `latest < activeCutoff` | same, but "Inactive" |
| **Single-product users** | `usageTotals` | `days <= 5 && productCount[name] === 1` | name, product, days, `1` |
| **Collection candidates** | `childTotals` | `product === child` | name, product, child |

Two derived cells:

- **Potential Flex candidate** - `days >= 7 ? "No" : "Yes"`. Light usage is
  cheaper on Flex tokens than on a named subscription.
- **Active / Inactive** - the 60-day test above.

Rows are sorted by `(name, product)` so a row keeps its position on screen when
another week is merged in.

> **Coverage caveat worth reproducing.** With only one week loaded, both derived
> columns lie: almost everyone clears the 7-day Flex threshold, and a genuinely
> inactive user has no rows at all so cannot appear. Roughly **9 weeks** are
> needed before the 60-day columns mean anything. The app says so in a banner
> (`updateCoverage`); any reimplementation should too.

## 6. Reset rules

| Event | What is cleared |
|---|---|
| Switch account | both Maps, `loadedWeeks`, all tables - another account's rows are not comparable |
| "Load last week" | everything, then loads week 0 fresh |
| "Load prior week" | nothing - merges week `loadedWeeks.size` into what is there |

A `runId` counter is bumped on every new run; a page that arrives after the
counter moved is discarded, so a slow response cannot land in a table that is
now showing something else.

## 7. Minimal reimplementation

```js
const usageTotals = new Map();

function mergeUsagePage(columns, rows) {
  const i = (n) => columns.indexOf(n);
  for (const r of rows) {
    const key = r[i("fullName")] + "|" + r[i("productName")];
    const earliest = Date.parse(r[i("earliestUsageDate")]);
    const latest = Date.parse(r[i("latestUsageDate")]);
    const days = Number(r[i("totalUniqueDays")]) || 0;
    const found = usageTotals.get(key);
    if (!found) {
      usageTotals.set(key, {
        name: r[i("fullName")],
        product: r[i("productName")],
        earliest: earliest,
        latest: latest,
        days: days,
      });
      continue;
    }
    if (!(earliest >= found.earliest)) found.earliest = earliest;
    if (!(latest <= found.latest)) found.latest = latest;
    found.days += days; // safe only because the windows are disjoint
  }
}

function buildRows() {
  const productCount = new Map();
  for (const e of usageTotals.values())
    productCount.set(e.name, (productCount.get(e.name) || 0) + 1);

  const cutoff = Date.now() - 60 * 86400e3;
  return [...usageTotals.values()]
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.product.localeCompare(b.product)
    )
    .map((e) => ({
      ...e,
      flexCandidate: e.days < 7,
      active: e.latest >= cutoff,
      singleProduct: e.days <= 5 && productCount.get(e.name) === 1,
    }));
}
```

That is the entire transformation. Everything else in `methods.js` is auth,
paging, throttling and DOM work.
