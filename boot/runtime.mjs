export function nativeAdd(left, right) {
  return left + right;
}

export function nativeSub(left, right) {
  return left - right;
}

export function nativeMul(left, right) {
  return left * right;
}

export function nativeDiv(left, right) {
  return Math.trunc(left / right);
}

export function nativeCmpInt(left, right) {
  if (left < right) return { tag: "LT", type: "Ordering" };
  if (left > right) return { tag: "GT", type: "Ordering" };
  return { tag: "EQ", type: "Ordering" };
}

export function nativeCharEq(left, right) {
  return left === right;
}

function listToString(list) {
  if (!list || typeof list !== "object") {
    return String(list);
  }
  if (list.type === "List") {
    let result = "";
    let current = list;
    while (current.tag === "Link") {
      result += String.fromCharCode(current._0);
      current = current._1;
    }
    return result;
  }
  return String(list);
}

function formatValue(value) {
  if (value && typeof value === "object" && value.type === "List") {
    return listToString(value);
  }
  return value;
}

export function nativePrint(value) {
  console.log(formatValue(value));
  return undefined;
}

const HANDLED_RESULT_PARAMS = Symbol.for("workmanHandledResultParams");

export function callInfectious(target, ...args) {
  const calleeInfo = unwrapResultForCall(target);
  if (calleeInfo.shortCircuit) {
    return calleeInfo.shortCircuit;
  }
  let callable = calleeInfo.value;
  let infected = calleeInfo.infected;
  const handledParams = callable?.[HANDLED_RESULT_PARAMS];

  const processedArgs = new Array(args.length);
  for (let i = 0; i < args.length; i += 1) {
    if (handledParams instanceof Set && handledParams.has(i)) {
      processedArgs[i] = args[i];
      continue;
    }
    const argInfo = unwrapResultForCall(args[i]);
    if (argInfo.shortCircuit) {
      return argInfo.shortCircuit;
    }
    if (argInfo.infected) {
      infected = true;
    }
    processedArgs[i] = argInfo.value;
  }

  if (typeof callable !== "function") {
    throw new Error("Attempted to call a non-function value");
  }

  const result = callable(...processedArgs);
  if (!infected) {
    return result;
  }
  return wrapResultValue(result);
}

export function recordGetInfectious(target, field) {
  const targetInfo = unwrapResultForCall(target);
  if (targetInfo.shortCircuit) {
    return targetInfo.shortCircuit;
  }
  const value = targetInfo.value;
  if (!value || typeof value !== "object") {
    throw new Error(
      `Attempted to project '${field}' from a non-record value`,
    );
  }
  if (!(field in value)) {
    throw new Error(`Record is missing field '${field}'`);
  }
  const fieldValue = value[field];
  if (!targetInfo.infected) {
    return fieldValue;
  }
  return wrapResultValue(fieldValue);
}

const NONE_VALUE = Object.freeze({ tag: "None", type: "Option" });

// Legacy: Convert string literal to List<Int>
export function nativeStrFromLiteral(str) {
  let result = { tag: "Empty", type: "List" };
  for (let index = str.length - 1; index >= 0; index -= 1) {
    const charCode = str.charCodeAt(index);
    result = {
      tag: "Link",
      type: "List",
      _0: charCode,
      _1: result,
    };
  }
  return result;
}

// New dual representation API

// String literal to native String (just return the JS string)
export function nativeStringFromLiteral(str) {
  return str;
}

// Convert native String to List<Int>
export function nativeStringToList(str) {
  let result = { tag: "Empty", type: "List" };
  for (let index = str.length - 1; index >= 0; index -= 1) {
    const charCode = str.charCodeAt(index);
    result = {
      tag: "Link",
      type: "List",
      _0: charCode,
      _1: result,
    };
  }
  return result;
}

// Convert List<Int> to native String
export function nativeListToString(list) {
  let result = "";
  let current = list;
  while (current.tag === "Link") {
    result += String.fromCharCode(current._0);
    current = current._1;
  }
  return result;
}

export function nativeStrLength(str) {
  return str.length;
}

export function nativeStrCharAt(str, index) {
  if (index < 0) return NONE_VALUE;
  if (index >= str.length) return NONE_VALUE;
  const char = str[index];
  return {
    tag: "Some",
    type: "Option",
    _0: char,
  };
}

export function nativeStrSlice(str, start, end) {
  return str.slice(start, end);
}

// Note: String operations (concat, length, slice, etc.) are implemented
// in Workman stdlib using the conversion primitives above

export function markResultHandler(fn, handledParams) {
  const handledSet = new Set(handledParams);
  Object.defineProperty(fn, HANDLED_RESULT_PARAMS, {
    value: handledSet,
    enumerable: false,
  });
  return fn;
}

export function unwrapResultForCall(value) {
  if (isResultData(value)) {
    if (value.tag === "Err") {
      return { value, infected: true, shortCircuit: value };
    }
    if (value.tag === "Ok") {
      const payload = Object.prototype.hasOwnProperty.call(value, "_0")
        ? value._0
        : undefined;
      return { value: payload, infected: true };
    }
  }
  return { value, infected: false };
}

export function wrapResultValue(value) {
  if (isResultData(value)) {
    return value;
  }
  return { tag: "Ok", type: "Result", _0: value };
}

function isResultData(value) {
  return value && typeof value === "object" &&
    value.type === "Result" &&
    (value.tag === "Ok" || value.tag === "Err");
}
