Workman: First-Class Record Declarations (Plan)

Goals
- Make `record` declarations first-class values that can define data + functions.
- Keep file-level modules for compilation units; improve ergonomics without removing modules.
- Allow `record Point { x: Int, y: Int, add: (dx, dy) => { ... } }` and
  `let p = .{ x: 1, y: 2 }; p.add(3, 4);`.

Current State (Observed)
- `record Name { ... }` is parsed as a type alias (`TypeDeclaration`) with `declarationKind: "record"`.
- Record types use `{ field: Type }` syntax; record values use `{ field: expr }`.
- There is no value-level constructor emitted for `record` declarations.
- Modules are file-level graphs (`src/module_loader.ts`); value and type namespaces are separate.

Proposed Surface Syntax
- Record declaration (new first-class top-level item):
  record Point { x: Int, y: Int, add: (dx, dy) => { ... } };
- Construction:
  let p = .{ x: 1, y: 2 };
- Access:
  p.add(3, 4);

Semantics (Target)
- A record declaration introduces:
  - A type `Point`
  - Default method/field definitions for `Point` instances
- Record literals remain `.{ ... }` and are nominally typed:
  - If the fields uniquely match a known record type, that type is selected.
  - Missing fields are filled from the record declaration defaults.
  - If no match or multiple matches, report ambiguity (existing behavior).
- Typed fields with no value are required instance fields.
- Value fields become default methods/fields on the constructed record.
- Module exports: `export record Point` exports the type (no constructor value).

AST Changes
- Add a new `RecordDeclaration` node to `src/ast.ts` and `TopLevel`.
  Suggested shape:
  - kind: "record_decl"
  - name, typeParams
  - members: RecordMember[]
  - export, comments, formatting flags
- Add `RecordMember` variants:
  - typed field: name + TypeExpr (no value)
  - value field: name + Expr (optional type annotation)
  - (optional) method sugar: name + parameters + body

Parser Changes
- Extend `record` parsing to handle mixed members:
  - `name: Type` -> typed field
  - `name: Expr` -> value field
  - `name(params) => { ... }` -> method sugar (optional)
- Keep record type literals `{ ... }` unchanged for type expressions.
- Preserve existing `record` type aliases for backward compatibility or
  migrate to `type` aliases internally.

Type Checking / Inference
- Treat `record_decl` as a source of:
  - Type info for `Point` (record type)
  - Default value/method fields for that type
- Record literal typing:
  - Use existing nominal record detection to pick `Point`.
  - If a matching record is found, fill any missing fields from defaults.
  - If a required field is missing and no default exists, error.
- Method binding semantics (no `self`):
  - Methods can reference declared fields by name (closure capture of instance).
  - The compiler rewrites method bodies to capture instance fields.

Lowering / Desugaring
- Suggested desugaring (default merge):
  record Point { x: Int, y: Int, add: (dx, dy) => { ... } }
  =>
  type Point = { x: Int, y: Int, add: (Int, Int) -> Point };
  let __defaults_Point = { add: (dx, dy) => { ... } };
  // For any literal .{ x: 1, y: 2 } typed as Point:
  // merge defaults and provided fields, with provided fields winning.
  // result: { add: __defaults_Point.add, x: 1, y: 2 }

Module Loader / Exports
- Exporting a record should export the type and the constructor value.
- Ensure duplicate checks allow type/value sharing for the same name.

Codegen / Backend
- Emit constructor as a function.
- Record value layout should match the existing record literal layout.
- Methods are just fields holding functions.

Open Questions
- Method scope: closure capture vs explicit `self`?
- Should value fields be allowed to reference other value fields? If so,
  define evaluation order or require `self`.
- Should `record` permit explicit default values for typed fields?
- Backward compatibility: keep `record` as type alias or migrate?

Milestones (Implementation Outline)
1) AST: add `RecordDeclaration` and member nodes.
2) Parser: parse mixed record members into new AST.
3) Inference: build type info + constructor binding.
4) Codegen: lower constructor to function + record literal.
5) Module loader: export both type + value and update duplicate checks.
