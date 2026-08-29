---
kind: task
category: "{workspace_name}"
parent: "[[P01_S01_{plan_name}]]"
level: 4
status: active
doc_role: pending
created: 
domain: "{domain}"
---

# P01_S01_T00B_pending_improvements

> **This document holds only what isn't done yet.** For what's currently true, see [[P01_S01_T00_current_rulings]].
> Finished items are **removed** from here — the rule goes to 재발방지대장, the fact goes to T00, the story goes to the journal.
> This document is not append-only. It's a **roster** items enter and leave.

## 1. Things to build (features)

| # | Domain | What | Why now | Prerequisite | Size | Stage |
|---|---|---|---|---|---|---|
| W-01 | Feature | | | | S/M/L | pending / started / on hold |

## 2. Open problems (troubleshooting — active)

| # | Domain | Symptom | How to reproduce | What's known about the cause so far | Workaround | Stage |
|---|---|---|---|---|---|---|
| A-01 | Spec | | | (write "unconfirmed" if unknown) | (write "none" if there isn't one) | investigating / pending / on hold |

## 3. On hold — tried, then deferred

| # | What | Why deferred | Condition to revisit |
|---|---|---|---|

---

## Five rules for filling this in

1. **Numbers are never reused.** Prefix `W-` (things to build) / `A-` (open problems) + a running number within the plan. A removed number stays retired.
2. **Finished means deleted.** This document has no `done`/`✅` status value. Follow the closure procedure in `record-update.md`.
3. **Write down "unknown."** Don't leave an unconfirmed cause blank — write `unconfirmed`. A blank cell can't be told apart from "nobody filled this in."
4. **One line is one line.** If it needs two lines, that belongs in the journal/changelog body instead.
5. **Domain stays inside the 6-value set** — `feature`·`ux`·`security`·`spec`·`infra`·`business`.
