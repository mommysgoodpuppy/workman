const PROMISE_TYPE_NAME = "Promise";
const PROMISE_VALUE_TAG = "Resolved";
const PROMISE_ERROR_TAG = "Rejected";

function promiseResolved(value) {
  return { type: PROMISE_TYPE_NAME, tag: PROMISE_VALUE_TAG, _0: value };
}

function promiseRejected(reason) {
  return { type: PROMISE_TYPE_NAME, tag: PROMISE_ERROR_TAG, _0: normalizeError(reason) };
}

function normalizeError(error) {
  if (error instanceof Error && typeof error.message === "string") {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch (_ignored) {
    return String(error);
  }
}

export function fromJsPromise(promiseLike) {
  if (promiseLike && typeof promiseLike.then === "function") {
    return Promise.resolve(promiseLike).then(
      (value) => promiseResolved(value),
      (error) => promiseRejected(error),
    );
  }
  return Promise.resolve(promiseResolved(promiseLike));
}

export function delayResolve(value, ms = 0) {
  return fromJsPromise(
    new Promise((resolve) => {
      setTimeout(() => resolve(value), ms);
    }),
  );
}

export function delayReject(reason, ms = 0) {
  return fromJsPromise(
    new Promise((_, reject) => {
      setTimeout(() => reject(reason), ms);
    }),
  );
}

export function fetchText(url) {
  if (typeof globalThis.fetch !== "function") {
    return Promise.resolve(
      promiseRejected("globalThis.fetch is not available in this environment"),
    );
  }

  return fromJsPromise(
    globalThis.fetch(url).then(async (response) => {
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return body;
    }),
  );
}
