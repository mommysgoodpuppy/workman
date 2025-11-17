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

function describeValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value && typeof value === "object") {
    if (typeof value.type === "string" && typeof value.tag === "string") {
      return `${value.type}.${value.tag}`;
    }
    try {
      const json = JSON.stringify(value);
      if (json !== undefined) {
        return json;
      }
    } catch {
      // Fall through to default string coercion
    }
  }
  return String(value);
}

export function nonExhaustiveMatch(scrutinee, info = {}) {
  const location = info.nodeId != null
    ? `nodeId ${info.nodeId}`
    : info.span
    ? `span ${info.span.start ?? "?"}-${info.span.end ?? "?"}`
    : "unknown location";
  const patterns = Array.isArray(info.patterns) && info.patterns.length > 0
    ? info.patterns.join(", ")
    : "unknown patterns";
  const valueDesc = describeValue(scrutinee);
  const error = new Error(
    `Non-exhaustive match at ${location}. Value ${valueDesc} is not handled. Patterns: ${patterns}.`,
  );
  const metadata = {
    kind: "non_exhaustive_match",
    nodeId: typeof info.nodeId === "number" ? info.nodeId : null,
    span: (info.span && typeof info.span === "object") ? info.span : null,
    patterns: Array.isArray(info.patterns) ? info.patterns : [],
    valueDescription: valueDesc,
  };
  Object.defineProperty(error, "workmanMetadata", {
    value: metadata,
    enumerable: false,
    configurable: true,
  });
  throw error;
}

const HANDLED_RESULT_PARAMS = Symbol.for("workmanHandledResultParams");

export function callInfectious(target, ...args) {
  const calleeInfo = unwrapResultForCall(target);
  if (calleeInfo.shortCircuit) {
    return calleeInfo.shortCircuit;
  }
  let callable = calleeInfo.value;
  let infected = calleeInfo.infected;
  let infectiousTypeName = null; // Track which infectious type is propagating
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
      // Remember the infectious type name from the first infected argument
      if (!infectiousTypeName && args[i]?.type) {
        infectiousTypeName = args[i].type;
      }
    }
    processedArgs[i] = argInfo.value;
  }

  if (typeof callable !== "function") {
    throw new Error("Attempted to call a non-function value");
  }

  const result = callable(...processedArgs);
  
  // Always check if result is already infectious, regardless of input infection
  if (result && typeof result === "object" && 
      typeof result.type === "string" && 
      typeof result.tag === "string" &&
      INFECTIOUS_TYPE_REGISTRY.has(result.type)) {
    // Result is already an infectious type, return as-is
    return result;
  }
  
  // If inputs were infected, wrap the plain result
  if (infected) {
    return wrapResultValue(result, infectiousTypeName);
  }
  
  // No infection, return plain result
  return result;
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
  // Get the infectious type name from the original target
  const infectiousTypeName = target?.type;
  return wrapResultValue(fieldValue, infectiousTypeName);
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

// Registry of infectious type metadata
// Maps type name -> { valueConstructor, effectConstructors }
const INFECTIOUS_TYPE_REGISTRY = new Map();

// Register infectious type metadata (called by generated code)
export function registerInfectiousType(typeName, valueConstructor, effectConstructors) {
  INFECTIOUS_TYPE_REGISTRY.set(typeName, {
    valueConstructor,
    effectConstructors: new Set(effectConstructors),
  });
}

export function unwrapResultForCall(value) {
  if (!value || typeof value !== "object") {
    return { value, infected: false };
  }
  if (typeof value.type !== "string" || typeof value.tag !== "string") {
    return { value, infected: false };
  }
  
  const metadata = INFECTIOUS_TYPE_REGISTRY.get(value.type);
  if (!metadata) {
    // Not a registered infectious type
    return { value, infected: false };
  }
  
  // Check if this is an effect constructor (short-circuit)
  if (metadata.effectConstructors.has(value.tag)) {
    return { value, infected: true, shortCircuit: value };
  }
  
  // Check if this is the value constructor (extract payload)
  if (value.tag === metadata.valueConstructor) {
    const payload = Object.prototype.hasOwnProperty.call(value, "_0")
      ? value._0
      : undefined;
    return { value: payload, infected: true };
  }
  
  // Unknown constructor for this infectious type - treat as non-infectious
  return { value, infected: false };
}

export function wrapResultValue(value, infectiousTypeName) {
  // If already an infectious type, return as-is
  if (value && typeof value === "object" && 
      typeof value.type === "string" && 
      typeof value.tag === "string" &&
      INFECTIOUS_TYPE_REGISTRY.has(value.type)) {
    return value;
  }
  
  // Wrap plain values using the infectious type's value constructor
  // When a function with clean return type is called with infectious arguments,
  // the result must be wrapped to maintain the infectious context
  if (infectiousTypeName && INFECTIOUS_TYPE_REGISTRY.has(infectiousTypeName)) {
    const metadata = INFECTIOUS_TYPE_REGISTRY.get(infectiousTypeName);
    return {
      tag: metadata.valueConstructor,
      type: infectiousTypeName,
      _0: value
    };
  }
  
  // Fallback: if no infectious type specified, return unwrapped
  // This shouldn't happen in correct code
  return value;
}
