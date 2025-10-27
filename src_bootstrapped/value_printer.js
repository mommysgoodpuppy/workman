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
  
  // cmpInt not needed
  
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
  
  panic(msg) { throw new Error(`Workman panic: ${msg}`); }
};

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

const Tag_List = {
  Link: 0,
  Empty: 1
};

function Link(...args) { return WM.mk(Tag_List.Link, ...args); }
const Empty = WM.mk(Tag_List.Empty);

const Tag_Option = {
  Some: 0,
  None: 1
};

function Some(...args) { return WM.mk(Tag_Option.Some, ...args); }
const None = WM.mk(Tag_Option.None);

function concat(a, b) {
  return a;
}

function intToString(n) {
  const t0 = "<?>";
  return t0;
}

function charToString(code) {
  const t1 = "<?>";
  return t1;
}

function listMap(f, list) {
  for (;;) {
    const tag2 = WM.getTag(list);
    const tag_const3 = 1;
    const cond4 = WM.eqInt(tag2, tag_const3);
    let match_result18;
if (cond4) {
  const t5 = [];
  const t6 = WM.mk(1, ...t5);
  match_result18 = t6;
} else {
  const tag_const7 = 0;
  const cond8 = WM.eqInt(tag2, tag_const7);
  let match_result17;
if (cond8) {
  const field_09 = WM.getField(list, 0);
  const field_110 = WM.getField(list, 1);
  const t11 = f(field_09);
  const t12 = listMap(f, field_110);
  const t13 = [t11, t12];
  const t14 = WM.mk(0, ...t13);
  match_result17 = t14;
} else {
  const panic_msg15 = "Non-exhaustive pattern match";
  const panic_result16 = WM.print(panic_msg15);
  match_result17 = panic_result16;
}
  match_result18 = match_result17;
}
    return match_result18;
  }
}

function listJoin(sep, list) {
  for (;;) {
    const tag19 = WM.getTag(list);
    const tag_const20 = 1;
    const cond21 = WM.eqInt(tag19, tag_const20);
    let match_result42;
if (cond21) {
  const t22 = "";
  match_result42 = t22;
} else {
  const tag_const23 = 0;
  const cond24 = WM.eqInt(tag19, tag_const23);
  let match_result41;
if (cond24) {
  const field_025 = WM.getField(list, 0);
  const field_126 = WM.getField(list, 1);
  const tag27 = WM.getTag(field_126);
  const tag_const28 = 1;
  const cond29 = WM.eqInt(tag27, tag_const28);
  let match_result38;
if (cond29) {
  match_result38 = field_025;
} else {
  const tag_const30 = 0;
  const cond31 = WM.eqInt(tag27, tag_const30);
  let match_result37;
if (cond31) {
  const t32 = listJoin(sep, field_126);
  const t33 = concat(sep, t32);
  const t34 = concat(field_025, t33);
  match_result37 = t34;
} else {
  const panic_msg35 = "Non-exhaustive pattern match";
  const panic_result36 = WM.print(panic_msg35);
  match_result37 = panic_result36;
}
  match_result38 = match_result37;
}
  match_result41 = match_result38;
} else {
  const panic_msg39 = "Non-exhaustive pattern match";
  const panic_result40 = WM.print(panic_msg39);
  match_result41 = panic_result40;
}
  match_result42 = match_result41;
}
    return match_result42;
  }
}

function formatRuntimeValue(value) {
  for (;;) {
    const tag43 = WM.getTag(value);
    const tag_const44 = 0;
    const cond45 = WM.eqInt(tag43, tag_const44);
    let match_result126;
if (cond45) {
  const t46 = "()";
  match_result126 = t46;
} else {
  const tag_const47 = 1;
  const cond48 = WM.eqInt(tag43, tag_const47);
  let match_result125;
if (cond48) {
  const field_049 = WM.getField(value, 0);
  const t50 = intToString(field_049);
  match_result125 = t50;
} else {
  const tag_const51 = 2;
  const cond52 = WM.eqInt(tag43, tag_const51);
  let match_result124;
if (cond52) {
  const field_053 = WM.getField(value, 0);
  const t55 = "true";
  match_result124 = t55;
} else {
  const tag_const56 = 3;
  const cond57 = WM.eqInt(tag43, tag_const56);
  let match_result123;
if (cond57) {
  const field_058 = WM.getField(value, 0);
  const t59 = "'";
  const t60 = charToString(field_058);
  const t61 = "'";
  const t62 = concat(t60, t61);
  const t63 = concat(t59, t62);
  match_result123 = t63;
} else {
  const tag_const64 = 4;
  const cond65 = WM.eqInt(tag43, tag_const64);
  let match_result122;
if (cond65) {
  const field_066 = WM.getField(value, 0);
  match_result122 = field_066;
} else {
  const tag_const67 = 5;
  const cond68 = WM.eqInt(tag43, tag_const67);
  let match_result121;
if (cond68) {
  const field_069 = WM.getField(value, 0);
  const tag70 = WM.getTag(field_069);
  const tag_const71 = 1;
  const cond72 = WM.eqInt(tag70, tag_const71);
  let match_result86;
if (cond72) {
  const t73 = "()";
  match_result86 = t73;
} else {
  const tag_const74 = 0;
  const cond75 = WM.eqInt(tag70, tag_const74);
  let match_result85;
if (cond75) {
  const t76 = "(";
  const t77 = ", ";
  const t78 = listMap(formatRuntimeValue, field_069);
  const t79 = listJoin(t77, t78);
  const t80 = ")";
  const t81 = concat(t79, t80);
  const t82 = concat(t76, t81);
  match_result85 = t82;
} else {
  const panic_msg83 = "Non-exhaustive pattern match";
  const panic_result84 = WM.print(panic_msg83);
  match_result85 = panic_result84;
}
  match_result86 = match_result85;
}
  match_result121 = match_result86;
} else {
  const tag_const87 = 6;
  const cond88 = WM.eqInt(tag43, tag_const87);
  let match_result120;
if (cond88) {
  const field_089 = WM.getField(value, 0);
  const field_190 = WM.getField(value, 1);
  const tag91 = WM.getTag(field_190);
  const tag_const92 = 1;
  const cond93 = WM.eqInt(tag91, tag_const92);
  let match_result105;
if (cond93) {
  match_result105 = field_089;
} else {
  const tag_const94 = 0;
  const cond95 = WM.eqInt(tag91, tag_const94);
  let match_result104;
if (cond95) {
  const t96 = " ";
  const t97 = " ";
  const t98 = listMap(formatRuntimeValue, field_190);
  const t99 = listJoin(t97, t98);
  const t100 = concat(t96, t99);
  const t101 = concat(field_089, t100);
  match_result104 = t101;
} else {
  const panic_msg102 = "Non-exhaustive pattern match";
  const panic_result103 = WM.print(panic_msg102);
  match_result104 = panic_result103;
}
  match_result105 = match_result104;
}
  match_result120 = match_result105;
} else {
  const tag_const106 = 7;
  const cond107 = WM.eqInt(tag43, tag_const106);
  let match_result119;
if (cond107) {
  const t108 = "<closure>";
  match_result119 = t108;
} else {
  const tag_const109 = 8;
  const cond110 = WM.eqInt(tag43, tag_const109);
  let match_result118;
if (cond110) {
  const field_0111 = WM.getField(value, 0);
  const t112 = "<native ";
  const t113 = ">";
  const t114 = concat(field_0111, t113);
  const t115 = concat(t112, t114);
  match_result118 = t115;
} else {
  const panic_msg116 = "Non-exhaustive pattern match";
  const panic_result117 = WM.print(panic_msg116);
  match_result118 = panic_result117;
}
  match_result119 = match_result118;
}
  match_result120 = match_result119;
}
  match_result121 = match_result120;
}
  match_result122 = match_result121;
}
  match_result123 = match_result122;
}
  match_result124 = match_result123;
}
  match_result125 = match_result124;
}
  match_result126 = match_result125;
}
    return match_result126;
  }
}

function format() {
  return formatRuntimeValue;
}

export { format };