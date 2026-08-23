export function createCompletionWakeController({
  listPending,
  sendFollowUp,
  onReady = () => {},
  onError = () => {},
  debounceMs = 250,
  retryMs = 2000,
}) {
  let active = false;
  let delivering = false;
  let rescanRequested = false;
  let timer;
  const announced = new Set();

  const schedule = (delay = debounceMs) => {
    if (!active) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void deliver();
    }, delay);
  };

  const deliver = async () => {
    if (!active) return;
    if (delivering) {
      rescanRequested = true;
      return;
    }
    delivering = true;
    try {
      const pending = await listPending();
      if (!active) return;
      const ready = pending.filter((id) => !announced.has(id));
      if (ready.length === 0) return;
      await sendFollowUp(ready);
      if (!active) return;
      ready.forEach((id) => announced.add(id));
      onReady(ready, pending);
    } catch (error) {
      if (active) {
        onError(error);
        schedule(retryMs);
      }
    } finally {
      delivering = false;
      if (active && rescanRequested) {
        rescanRequested = false;
        schedule(0);
      }
    }
  };

  return {
    start() {
      active = true;
      announced.clear();
      schedule(0);
    },
    signal() {
      if (delivering) rescanRequested = true;
      else schedule();
    },
    stop() {
      active = false;
      rescanRequested = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
