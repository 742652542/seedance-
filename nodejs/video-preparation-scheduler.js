export function createVideoPreparationScheduler({ start }) {
  let active = null;
  let blockedError = null;
  const waiting = [];

  function release(entry) {
    if (blockedError || active !== entry) return;
    active = null;
    drain();
  }

  function drain() {
    if (blockedError || active || waiting.length === 0) return;

    const entry = waiting.shift();
    active = entry;
    let lifecycle;

    try {
      lifecycle = Promise.resolve(start(entry.item, () => release(entry)));
    } catch (error) {
      entry.reject(error);
      if (error?.blocksPreparationQueue) {
        blockedError = error;
        return;
      }
      release(entry);
      return;
    }

    lifecycle.then(
      (result) => {
        entry.resolve(result);
        release(entry);
      },
      (error) => {
        entry.reject(error);
        if (active === entry && error?.blocksPreparationQueue) {
          blockedError = error;
          return;
        }
        release(entry);
      },
    );
  }

  return {
    enqueue(item) {
      const result = new Promise((resolve, reject) => {
        waiting.push({ item, resolve, reject });
      });
      drain();
      return result;
    },

    queuePosition(id) {
      if (active?.item.id === id) return 0;
      const index = waiting.findIndex((entry) => entry.item.id === id);
      return index === -1 ? null : index + 1;
    },

    isBlocked() {
      return blockedError !== null;
    },

    blockedReason() {
      return blockedError;
    },
  };
}
