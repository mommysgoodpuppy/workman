import { listMap, listJoin } from "../std/list.js";
import { strConcat, intToString, fromLiteral } from "../std/string.js";

const WM = {
  unit: undefined,
  
  mk(tag, ...fields) {
    const obj = { tag };
    fields.forEach((f, i) => obj[`_${i}`] = f);
    return obj;
  },
  
  getTag(v) { return v.tag; },
  getField(v, i) { return v[`_${i}`]; },
  
  tuple(...elements) { return elements; },
  getTuple(t, i) { return t[i]; },
  
  add(a, b) { return (a + b) | 0; },
  sub(a, b) { return (a - b) | 0; },
  mul(a, b) { return (a * b) | 0; },
  div(a, b) { return Math.trunc(a / b); },
  
  cmpInt(a, b) {
    if (a < b) return WM.mk(Tag_Ordering.LT);
    if (a > b) return WM.mk(Tag_Ordering.GT);
    return WM.mk(Tag_Ordering.EQ);
  },
  
  charEq(a, b) { return a === b; },
  print(x) { console.log(x); return WM.unit; },
  
  and(a, b) { return a && b; },
  or(a, b) { return a || b; },
  not(a) { return !a; },
  
  eqInt(a, b) { return a === b; },
  neInt(a, b) { return a !== b; },
  ltInt(a, b) { return a < b; },
  gtInt(a, b) { return a > b; },
  leInt(a, b) { return a <= b; },
  geInt(a, b) { return a >= b; },
  
  strFromLiteral(str) {
    // Convert JS string to List<Int> (char codes)
    // List has constructors: Link (tag 0), Empty (tag 1)
    let result = WM.mk(1); // Empty
    for (let i = str.length - 1; i >= 0; i--) {
      result = WM.mk(0, str.charCodeAt(i), result); // Link(charCode, rest)
    }
    return result;
  },
  
  panic(msg) { throw new Error(`Workman panic: ${msg}`); }
};

const Tag_List = {
  Empty: 0,
  Link: 1
};

const Empty = WM.mk(Tag_List.Empty);
function Link(...args) { return WM.mk(Tag_List.Link, ...args); }

const Tag_Ordering = { LT: 0, EQ: 1, GT: 2 };

const LT = WM.mk(Tag_Ordering.LT);
const EQ = WM.mk(Tag_Ordering.EQ);
const GT = WM.mk(Tag_Ordering.GT);

const Tag_Option = {
  None: 0,
  Some: 1
};

const None = WM.mk(Tag_Option.None);
function Some(...args) { return WM.mk(Tag_Option.Some, ...args); }

const Tag_RuntimeValue = {
  Unit: 0,
  Int: 1,
  Bool: 2,
  Char: 3,
  Str: 4,
  Tuple: 5,
  Data: 6,
  Closure: 7,
  Native: 8
};

function Unit(...args) { return WM.mk(Tag_RuntimeValue.Unit, ...args); }
function Int(...args) { return WM.mk(Tag_RuntimeValue.Int, ...args); }
function Bool(...args) { return WM.mk(Tag_RuntimeValue.Bool, ...args); }
function Char(...args) { return WM.mk(Tag_RuntimeValue.Char, ...args); }
function Str(...args) { return WM.mk(Tag_RuntimeValue.Str, ...args); }
function Tuple(...args) { return WM.mk(Tag_RuntimeValue.Tuple, ...args); }
function Data(...args) { return WM.mk(Tag_RuntimeValue.Data, ...args); }
function Closure(...args) { return WM.mk(Tag_RuntimeValue.Closure, ...args); }
function Native(...args) { return WM.mk(Tag_RuntimeValue.Native, ...args); }

function formatRuntimeValue(value) {
  for (;;) {
    const tag0 = WM.getTag(value);
    const tag_const1 = 0;
    const cond2 = WM.eqInt(tag0, tag_const1);
    let match_result69;
if (cond2) {
  const t3 = "unit";
  const t4 = fromLiteral(t3);
  match_result69 = t4;
} else {
  const tag_const5 = 1;
  const cond6 = WM.eqInt(tag0, tag_const5);
  let match_result68;
if (cond6) {
  const field_07 = WM.getField(value, 0);
  const t8 = intToString(field_07);
  match_result68 = t8;
} else {
  const tag_const9 = 2;
  const cond10 = WM.eqInt(tag0, tag_const9);
  let match_result67;
if (cond10) {
  const field_011 = WM.getField(value, 0);
  const t13 = "true";
  const t14 = fromLiteral(t13);
  match_result67 = t14;
} else {
  const tag_const15 = 3;
  const cond16 = WM.eqInt(tag0, tag_const15);
  let match_result66;
if (cond16) {
  const t17 = "char";
  const t18 = fromLiteral(t17);
  match_result66 = t18;
} else {
  const tag_const19 = 4;
  const cond20 = WM.eqInt(tag0, tag_const19);
  let match_result65;
if (cond20) {
  const field_021 = WM.getField(value, 0);
  match_result65 = field_021;
} else {
  const tag_const22 = 5;
  const cond23 = WM.eqInt(tag0, tag_const22);
  let match_result64;
if (cond23) {
  const field_024 = WM.getField(value, 0);
  const t25 = "tuple";
  const t26 = fromLiteral(t25);
  match_result64 = t26;
} else {
  const tag_const27 = 6;
  const cond28 = WM.eqInt(tag0, tag_const27);
  let match_result63;
if (cond28) {
  const field_029 = WM.getField(value, 0);
  const field_130 = WM.getField(value, 1);
  const tag31 = WM.getTag(field_130);
  const tag_const32 = 0;
  const cond33 = WM.eqInt(tag31, tag_const32);
  let match_result51;
if (cond33) {
  match_result51 = field_029;
} else {
  const tag_const34 = 1;
  const cond35 = WM.eqInt(tag31, tag_const34);
  let match_result50;
if (cond35) {
  const t36 = " ";
  const t37 = fromLiteral(t36);
  const t38 = " ";
  const t39 = fromLiteral(t38);
  const t40 = [formatRuntimeValue, field_130];
  const t41 = listMap(t40);
  const t42 = [t39, t41];
  const t43 = listJoin(t42);
  const t44 = [t37, t43];
  const t45 = strConcat(t44);
  const t46 = [field_029, t45];
  const t47 = strConcat(t46);
  match_result50 = t47;
} else {
  const panic_msg48 = "Non-exhaustive pattern match";
  const panic_result49 = WM.print(panic_msg48);
  match_result50 = panic_result49;
}
  match_result51 = match_result50;
}
  match_result63 = match_result51;
} else {
  const tag_const52 = 7;
  const cond53 = WM.eqInt(tag0, tag_const52);
  let match_result62;
if (cond53) {
  const t54 = "closure";
  const t55 = fromLiteral(t54);
  match_result62 = t55;
} else {
  const tag_const56 = 8;
  const cond57 = WM.eqInt(tag0, tag_const56);
  let match_result61;
if (cond57) {
  const field_058 = WM.getField(value, 0);
  match_result61 = field_058;
} else {
  const panic_msg59 = "Non-exhaustive pattern match";
  const panic_result60 = WM.print(panic_msg59);
  match_result61 = panic_result60;
}
  match_result62 = match_result61;
}
  match_result63 = match_result62;
}
  match_result64 = match_result63;
}
  match_result65 = match_result64;
}
  match_result66 = match_result65;
}
  match_result67 = match_result66;
}
  match_result68 = match_result67;
}
  match_result69 = match_result68;
}
    return match_result69;
  }
}

function format() {
  return formatRuntimeValue;
}

export { format };