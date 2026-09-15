# Why zsync exists

Hey there.

We recently moved the company's official time tracking from Clockify to Zoho People. That gave management one central place to review and control timesheets, but it also made everyday time tracking harder for the people doing the work.

Zoho's interface is unfamiliar to the team, and several common tasks are slower or less flexible than they were in Clockify.

**`zsync` bridges the gap.**

You track and manage project time in Clockify, then copy completed entries into Zoho People when they're ready. Zoho remains the official company record, while Clockify gives developers and project leads a more familiar and flexible place to do the daily work.

You can find the code in the [zsync GitHub repository](https://github.com/srafis/zsync) or install [zsync from npm](https://www.npmjs.com/package/@srafis/zsync).

The migration solved the need for a single, centrally managed timesheet. It didn't solve every part of the project team's daily workflow.

When the team evaluated alternatives, one requirement kept coming up: **the time-tracking tool needed an API so the automations around it could keep working.** A bridge between Clockify and Zoho gave us that flexibility without giving up Zoho's central oversight.

## Why the daily workflow needed help

Zoho People covers the central timesheet requirement, but the day-to-day workflow has several rough edges:

* Editing an entry's date is difficult.
* A running timer cannot start at a chosen time.
* People cannot easily see their team's tracked entries.
* Overlapping entries are rejected.
* Projects are tied to individual users instead of being shared globally.
* Jobs and tags are tied to projects instead of being shared globally.
* The page does not update live, so current totals may require a refresh.
* Starting a timer requires all the details up front.
* Reports are harder to generate and share, especially when a client needs a clear project summary.

The Chrome extension built by the team makes some of this easier. It helps with common actions such as starting, editing, deleting, and logging time.

It still cannot reproduce the Clockify workflow that developers and project leads are already used to.

That difference shows up in small but recurring problems. A lead reviewing a project may notice that an entry needs a billability change or another correction. Instead of fixing it directly, they may have to ask the person who created the entry to make the change.

Team reviews and reporting can require extra work for the same reason.

## How the Clockify-to-Zoho workflow works

Each project lead can create a Clockify workspace for their project and add the people working on it.

The workspace becomes the team's practical working area. The lead can:

* See the team's tracked entries.
* Correct entries when needed.
* Update details such as billability.
* Generate and share project reports.
* Use Clockify's APIs and integrations to automate parts of the workflow.

When the entries are complete, the lead runs `zsync`:

1. Select the relevant time period and entries.
2. Review the project and job mapping.
3. Confirm the sync.

`zsync` then creates or updates the corresponding Zoho People logs.

It also keeps source metadata so later runs can recognize entries that were previously synced and detect entries that were removed from Clockify.

The handoff is intentionally simple:

```text
Clockify for capture and project work
              ↓
            zsync
              ↓
Zoho People for the official company record
```

## What this keeps working

### Developers keep their workflow

Developers can continue using a familiar interface and the APIs and integrations that already fit into their workflow.

That includes automations that create time entries with an agent, as well as workflows that turn tracked time into retrospective sheets or project metrics.

The team doesn't need to rebuild those workflows around Zoho's interaction model.

### Project leads keep project-level control

Project leads can manage their own workspace, see what the team logged, correct details, and produce useful project reports without waiting for every small correction to go through the person who originally created an entry.

### Management keeps the official record

Upper management still gets the central control and visibility that motivated the move to Zoho People in the first place.

Zoho remains the **single official company timesheet**.

That gives each system a clear role:

* **Clockify:** daily time tracking, project work, reporting, and automation.
* **`zsync`:** controlled handoff between the two systems.
* **Zoho People:** official company timesheet and management oversight.

## What `zsync` does, and does not do

Run `zsync` when entries are complete and ready to become part of the official Zoho record.

It is a deliberate, **one-way sync from Clockify to Zoho People**.

`zsync` does **not**:

* Submit or approve timesheets.
* Copy Zoho edits back to Clockify.
* Run as a background service.
* Replace Zoho People as the official timesheet.

The result is a clear and reviewable path from project work to the company's official record.

Each system handles the part of the job it is best suited for:

**Project teams work in Clockify. `zsync` moves completed work across. Management works from Zoho People.**
