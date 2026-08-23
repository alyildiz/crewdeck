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
  { id: "cleaned", status: "cleaned", observedStatus: "cleaned", agent: { state: "closed" } },
];

function commandFixture() {
  const widgets = [];
  let statusReads = 0;
  const command = createCrewCommand(async () => {
    statusReads += 1;
    return tasks;
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
    ["running", "blocked", "report-ready", "candidate", "missing-active"],
  );
});

test("/crew hides terminal durable tasks by default", async () => {
  const fixture = commandFixture();
  await fixture.command.handler("", fixture.ctx);

  const lines = fixture.widgets[0][1].join("\n");
  assert.match(lines, /missing-active/);
  assert.doesNotMatch(lines, /missing-collected|integrated|cleaned/);
  assert.deepEqual(fixture.widgets[0][2], { placement: "belowEditor" });
});

test("/crew all displays the complete durable task history", async () => {
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
