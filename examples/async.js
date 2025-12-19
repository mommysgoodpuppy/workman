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

export function fetch(url) {
  return fromJsPromise(globalThis.fetch(url));
}

export function json(response) {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return fromJsPromise(response.json());
}

export function listFromArray(array) {
  console.log("listFromArray input", Array.isArray(array), array?.length, Array.isArray(array) ? array.slice(0, 1) : array);
  if (array && typeof array === "object" && array.type === "List") {
    return array;
  }
  if (!Array.isArray(array)) {
    throw new TypeError("listFromArray expects a JavaScript array");
  }

  let list = { tag: "Empty", type: "List" };
  for (let index = array.length - 1; index >= 0; index -= 1) {
    list = {
      tag: "Link",
      type: "List",
      _0: array[index],
      _1: list,
    };
  }
  console.log("listFromArray output head", list);
  return list;
}