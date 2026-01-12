# Modules and Names (Normative)

This section defines modules, imports/exports, and name resolution.

Canonical Workman aims to keep module semantics simple and predictable.

---

## Modules

- A module is the contents of a single source file.
- Module identity is implementation-defined (e.g., file path normalization),
  but must be consistent within a build.

Implementation-defined (must be documented):
- How module specifiers (e.g., `"./file.wm"`, `"std/list"`) map to files.
- Whether the same file can be imported under multiple spellings and if so
  whether it produces one module or multiple distinct modules.

---

## Namespaces

Canonical Workman has at least these namespaces:
- **values**
- **types**
- **constructors**

An identifier may exist in multiple namespaces with the same spelling.

---

## Imports

- Imports are explicit and list the imported items.
- Importing `type T(..)` imports the type and the specified constructors.
- Namespace imports (`* as Name`) introduce a value-level namespace binding.

Name resolution rules:
- Local bindings shadow imported bindings in the value namespace.
- Type and constructor resolution rules are specified in the typing chapter.

---

## Exports

- Exports are explicit.
- Exporting a type does not implicitly export all constructors unless written
  explicitly.

---

## Cycles

Import cycles are **not permitted** in canonical Workman (v1). Implementations
must reject cyclic module dependencies.
