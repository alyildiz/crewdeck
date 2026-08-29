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
