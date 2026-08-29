import assert from "node:assert/strict";
import test from "node:test";
import { createCompletionWakeController } from "../src/completion-wake.mjs";

const wait = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

test("reconciles startup results and batches later completion follow-ups", async () => {
  let pending = ["task-a"];
  const followUps = [];
  const controller = createCompletionWakeController({
    listPending: async () => [...pending],
    sendFollowUp: async (ids) => followUps.push(ids),
    debounceMs: 5,
    retryMs: 5,
  });

  controller.start();
  await wait();
  assert.deepEqual(followUps, [["task-a"]]);

  pending = ["task-a", "task-b", "task-c"];
  controller.signal();
  controller.signal();
  await wait();
  assert.deepEqual(followUps, [["task-a"], ["task-b", "task-c"]]);

  controller.stop();
  pending.push("task-d");
  controller.signal();
  await wait();
  assert.equal(followUps.length, 2);
});

test("chunks more than twenty pending keys and reannounces durable work after restart", async () => {
  const pending = Array.from({ length: 45 }, (_, index) => `task-${index}`);
  const first = [];
  const controller = createCompletionWakeController({
    listPending: async () => pending,
    sendFollowUp: async (ids, metadata) => first.push({ ids, metadata }),
    debounceMs: 1,
    maxBatch: 20,
  });
  controller.start();
  await wait(40);
  controller.stop();
  assert.deepEqual(first.map((item) => item.ids.length), [20, 20, 5]);
  assert.deepEqual(first.map((item) => item.metadata.remaining), [25, 5, 0]);
  assert.deepEqual(first.flatMap((item) => item.ids), pending);

  const restarted = [];
  const restartController = createCompletionWakeController({
    listPending: async () => pending,
    sendFollowUp: async (ids) => restarted.push(ids),
    debounceMs: 1,
    maxBatch: 20,
  });
  restartController.start();
  await wait(40);
  restartController.stop();
  assert.deepEqual(restarted.map((ids) => ids.length), [20, 20, 5]);
});

test("retries a failed follow-up without acknowledging the result", async () => {
  let attempts = 0;
  const delivered = [];
  const controller = createCompletionWakeController({
    listPending: async () => ["task-retry"],
    sendFollowUp: async (ids) => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary delivery failure");
      delivered.push(ids);
    },
    debounceMs: 1,
    retryMs: 5,
  });

  controller.start();
  await wait(35);
  controller.stop();
  assert.equal(attempts, 2);
  assert.deepEqual(delivered, [["task-retry"]]);
});
