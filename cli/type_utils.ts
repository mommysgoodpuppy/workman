import { getProvenance, isHoleType } from "../src/types.ts";
import type { Type } from "../src/types.ts";
import type { Layer3Result } from "../src/layer3/mod.ts";

export function holeIdFromUnknown(type: Type): number | undefined {
  const provenance = getProvenance(type);
  if (!provenance) return undefined;

  if (provenance.kind === "expr_hole" || provenance.kind === "user_hole") {
    return (provenance as Record<string, unknown>).id as number;
  }

  if (provenance.kind === "incomplete") {
    return (provenance as Record<string, unknown>).nodeId as number;
  }

  if (
    provenance.kind === "error_not_function" ||
    provenance.kind === "error_inconsistent"
  ) {
    const inner = (provenance as Record<string, unknown>).calleeType ??
      (provenance as Record<string, unknown>).actual;
    if (inner && isHoleType(inner as Type)) {
      return holeIdFromUnknown(inner as Type);
    }
  }

  return undefined;
}

export function substituteHoleSolutionsInType(
  type: Type,
  layer3: Layer3Result,
): Type {
  switch (type.kind) {
    case "func":
      return {
        kind: "func",
        from: substituteHoleSolutionsInType(type.from, layer3),
        to: substituteHoleSolutionsInType(type.to, layer3),
      };
    case "constructor":
      return {
        kind: "constructor",
        name: type.name,
        args: type.args.map((arg) =>
          substituteHoleSolutionsInType(arg, layer3)
        ),
      };
    case "tuple":
      return {
        kind: "tuple",
        elements: type.elements.map((element) =>
          substituteHoleSolutionsInType(element, layer3)
        ),
      };
    case "record": {
      const updated = new Map<string, Type>();
      for (const [field, fieldType] of type.fields.entries()) {
        updated.set(field, substituteHoleSolutionsInType(fieldType, layer3));
      }
      return { kind: "record", fields: updated };
    }
    default:
      if (isHoleType(type)) {
        const holeId = holeIdFromUnknown(type);
        if (holeId !== undefined) {
          const solution = layer3.holeSolutions.get(holeId);
          if (solution?.state === "partial" && solution.partial?.known) {
            return substituteHoleSolutionsInType(
              solution.partial.known,
              layer3,
            );
          }
          if (solution?.state === "conflicted" && solution.conflicts?.length) {
            return type;
          }
        }
        const provenance = getProvenance(type);
        if (provenance?.kind === "error_inconsistent") {
          const expected = (provenance as Record<string, unknown>).expected as
            | Type
            | undefined;
          if (expected) {
            return substituteHoleSolutionsInType(expected, layer3);
          }
        }
        return type;
      }
      return type;
  }
}
