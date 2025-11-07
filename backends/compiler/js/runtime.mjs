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

export function nativePrint(value) {
  console.log(value);
  return undefined;
}

const NONE_VALUE = Object.freeze({ tag: "None", type: "Option" });

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
