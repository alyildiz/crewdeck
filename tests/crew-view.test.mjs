import assert from "node:assert/strict";
import test from "node:test";
import { createCrewCommand, currentCrewTasks } from "../src/crew-view.mjs";

const tasks = [
  { id: "running", status: "running", observedStatus: "running", agent: { state: "working" } },
  { id: "blocked", status: "running", observedStatus: "blocked", agent: { state: "blocked" } },
  { id: "report-ready", status: "running", observedStatus: "report-ready", agent: { state: "idle" } },
  { id: "candidate", status: "running", observedStatus: "candidate", agent: { state: "done" } },
  { id: "missing-active", status: "running", observedStatus: "running", agent: { state: "missing" } },
  { id: "missing-collected", status: "running", observedStatus: "report-collected", agent: { state: "missing" } },
  { id: "integrated", status: "integrated", observedStatus: "integrated", agent: { state: "idle" } },
  { id: "pr-merged", status: "pr-merged", observedStatus: "pr-merged", agent: { state: "closed" } },
  { id: "abandon-pending", status: "abandoned", observedStatus: "abandon-cleanup-pending", agent: { state: "missing" } },
  { id: "abandoned", status: "abandoned", observedStatus: "abandoned", agent: { state: "closed" } },
  { id: "orphan-reconciled", status: "orphan-reconciled", observedStatus: "orphan-reconciled", agent: { state: "closed" } },
  { id: "cleaned", status: "cleaned", observedStatus: "cleaned", agent: { state: "closed" } },
];

function commandFixture() {
  const widgets = [];
  let statusReads = 0;
  const command = createCrewCommand(async ({ scope, limit, cursor }) => {
    statusReads += 1;
    const selected = scope === "all" ? tasks : currentCrewTasks(tasks);
    return { tasks: selected.slice(0, limit), pagination: { nextCursor: cursor ? null : undefined } };
  });
  const ctx = {
    ui: {
      setWidget: (...args) => widgets.push(args),
      notify: () => assert.fail("unexpected notification"),
    },
  };
  return { command, ctx, widgets, get statusReads() { return statusReads; } };
}

test("default crew view keeps active and actionable tasks, including a missing active agent", () => {
  assert.deepEqual(
    currentCrewTasks(tasks).map((task) => task.id),
    ["running", "blocked", "report-ready", "candidate", "missing-active", "missing-collected", "integrated", "abandon-pending"],
  );
});

test("/crew hides terminal durable tasks by default", async () => {
  const fixture = commandFixture();
  await fixture.command.handler("", fixture.ctx);

  const lines = fixture.widgets[0][1].join("\n");
  assert.match(lines, /missing-active/);
  assert.match(lines, /abandon-pending/);
  assert.match(lines, /missing-collected/);
  assert.match(lines, /integrated/);
  assert.doesNotMatch(lines, /pr-merged|abandoned|orphan-reconciled|cleaned/);
  assert.deepEqual(fixture.widgets[0][2], { placement: "belowEditor" });
});

test("/crew all displays one bounded durable task page", async () => {
  const fixture = commandFixture();
  await fixture.command.handler(" all ", fixture.ctx);

  const lines = fixture.widgets[0][1].join("\n");
  for (const task of tasks) assert.match(lines, new RegExp(task.id));
});

test("/crew clear hides the widget without reading task status", async () => {
  const fixture = commandFixture();
  await fixture.command.handler("clear", fixture.ctx);

  assert.equal(fixture.statusReads, 0);
  assert.deepEqual(fixture.widgets, [["crewdeck", undefined]]);
});

function opaqueCursor(scope) {
  return Buffer.from(JSON.stringify({ v: 1, scope, generation: "gen", after: "running" }), "utf8").toString("base64url");
}

test("/crew <cursor> replays an active-scope page cursor in its own scope", async () => {
  const calls = [];
  const command = createCrewCommand(async (options) => {
    calls.push(options);
    return {
      scope: "active",
      tasks: currentCrewTasks(tasks).slice(0, options.limit),
      pagination: { nextCursor: `${opaqueCursor("active")}2` },
    };
  });
  const widgets = [];
  const ctx = {
    ui: {
      setWidget: (...args) => widgets.push(args),
      notify: () => assert.fail("unexpected notification"),
    },
  };
  const cursor = opaqueCursor("active");
  await command.handler(cursor, ctx);

  assert.deepEqual(calls, [{ scope: "active", limit: 20, cursor }]);
  const lines = widgets[0][1];
  assert.match(lines.at(-1), /^Crewdeck: page truncated; continue with \/crew [A-Za-z0-9_-]+$/);
  assert.doesNotMatch(lines.at(-1), /\/crew all /);
});

test("/crew all <cursor> still replays an all-scope page cursor", async () => {
  const calls = [];
  const command = createCrewCommand(async (options) => {
    calls.push(options);
    return {
      scope: "all",
      tasks: tasks.slice(0, options.limit),
      pagination: { nextCursor: `${opaqueCursor("all")}2` },
    };
  });
  const widgets = [];
  const ctx = {
    ui: {
      setWidget: (...args) => widgets.push(args),
      notify: () => assert.fail("unexpected notification"),
    },
  };
  const cursor = opaqueCursor("all");
  await command.handler(`all ${cursor}`, ctx);

  assert.deepEqual(calls, [{ scope: "all", limit: 50, cursor }]);
  assert.match(widgets[0][1].at(-1), /continue with \/crew all [A-Za-z0-9_-]+/);
});

test("/crew notifies an error for an invalid bare cursor instead of rendering", async () => {
  const command = createCrewCommand(async () => assert.fail("getPage must not run for an invalid cursor"));
  const widgets = [];
  const notifications = [];
  const ctx = {
    ui: {
      setWidget: (...args) => widgets.push(args),
      notify: (message, level) => notifications.push([message, level]),
    },
  };
  await command.handler("not-a-cursor", ctx);

  assert.equal(widgets.length, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0][1], "error");
  assert.match(notifications[0][0], /cursor/i);
});
