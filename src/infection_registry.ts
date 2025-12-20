import type {
  AnnotateDeclaration,
  DomainDeclaration,
  OpRuleDeclaration,
  PolicyDeclaration,
  Program,
  RuleEntry,
  RuleValuePart,
} from "./ast.ts";

export interface DomainRuleDefinition {
  name: string;
  stateKind?: string;
  merge?: string;
  mergeRow?: string;
  conflict?: string;
  conflictPairs?: [string, string][];
  boundary?: string;
  entries: RuleEntry[];
}

export interface OpRuleDefinition {
  name: string;
  domain?: string;
  target?: string;
  requiresExact?: string[];
  requiresAny?: string[];
  adds?: string[];
  removes?: string[];
  callPolicy?: string;
  rejectDomains?: string[];
  entries: RuleEntry[];
}

export interface PolicyDefinition {
  name: string;
  domain?: string;
  requireAtReturn?: string[];
  rejectsAllDomains?: boolean;
  rejectDomains?: string[];
  entries: RuleEntry[];
}

export interface AnnotationDefinition {
  target: string;
  policies: string[];
}

export interface InfectionSummary {
  domains: DomainRuleDefinition[];
  opRules: OpRuleDefinition[];
  policies: PolicyDefinition[];
  annotations: AnnotationDefinition[];
}

export class InfectionRegistry {
  domains = new Map<string, DomainRuleDefinition>();
  opRules = new Map<string, OpRuleDefinition>();
  policies = new Map<string, PolicyDefinition>();
  annotations = new Map<string, AnnotationDefinition>();

  clone(): InfectionRegistry {
    const cloned = new InfectionRegistry();
    for (const [name, rule] of this.domains) {
      cloned.domains.set(name, rule);
    }
    for (const [name, rule] of this.opRules) {
      cloned.opRules.set(name, rule);
    }
    for (const [name, rule] of this.policies) {
      cloned.policies.set(name, rule);
    }
    for (const [name, rule] of this.annotations) {
      cloned.annotations.set(name, rule);
    }
    return cloned;
  }

  mergeSummary(summary: InfectionSummary): void {
    for (const rule of summary.domains) {
      this.domains.set(rule.name, rule);
    }
    for (const rule of summary.opRules) {
      this.opRules.set(rule.name, rule);
    }
    for (const rule of summary.policies) {
      this.policies.set(rule.name, rule);
    }
    for (const annotation of summary.annotations) {
      this.annotations.set(annotation.target, annotation);
    }
  }
}

export function collectInfectionDeclarations(
  program: Program,
  options: { onlyExported?: boolean } = {},
): InfectionSummary {
  const summary: InfectionSummary = {
    domains: [],
    opRules: [],
    policies: [],
    annotations: [],
  };

  for (const decl of program.declarations) {
    if (options.onlyExported && !("export" in decl && decl.export)) {
      continue;
    }
    if (decl.kind === "domain") {
      summary.domains.push(parseDomainRule(decl));
    } else if (decl.kind === "op") {
      summary.opRules.push(parseOpRule(decl));
    } else if (decl.kind === "policy") {
      summary.policies.push(parsePolicyRule(decl));
    } else if (decl.kind === "annotate") {
      summary.annotations.push(parseAnnotationRule(decl));
    }
  }

  return summary;
}

function parseDomainRule(decl: DomainDeclaration): DomainRuleDefinition {
  return {
    name: decl.name,
    stateKind: getNameByKey(decl.entries, "stateKind"),
    merge: getNameByKey(decl.entries, "merge"),
    mergeRow: getNameByKey(decl.entries, "mergeRow"),
    conflict: getNameByKey(decl.entries, "conflict"),
    conflictPairs: getPairListByKey(decl.entries, "conflict"),
    boundary: getNameByKey(decl.entries, "boundary"),
    entries: decl.entries,
  };
}

function parseOpRule(decl: OpRuleDeclaration): OpRuleDefinition {
  return {
    name: decl.name,
    domain: getNameByKey(decl.entries, "domain"),
    target: getNameByKey(decl.entries, "target"),
    requiresExact: getListByKey(decl.entries, "requiresExact"),
    requiresAny: getListByKey(decl.entries, "requiresAny"),
    adds: getListByKey(decl.entries, "adds"),
    removes: getListByKey(decl.entries, "removes"),
    callPolicy: getNameByKey(decl.entries, "callPolicy") ??
      getNameByKey(decl.entries, "call_policy"),
    rejectDomains: getListByKey(decl.entries, "rejectDomains") ??
      getListByKey(decl.entries, "reject_domains"),
    entries: decl.entries,
  };
}

function parsePolicyRule(decl: PolicyDeclaration): PolicyDefinition {
  return {
    name: decl.name,
    domain: getNameByKey(decl.entries, "domain"),
    requireAtReturn: getListByKey(decl.entries, "requireAtReturn"),
    rejectsAllDomains: hasFlag(decl.entries, "rejectsAllDomains"),
    rejectDomains: getListByKey(decl.entries, "rejectDomains") ??
      getListByKey(decl.entries, "reject_domains"),
    entries: decl.entries,
  };
}

function parseAnnotationRule(decl: AnnotateDeclaration): AnnotationDefinition {
  return {
    target: decl.target,
    policies: [...decl.policies],
  };
}

function getNameByKey(entries: RuleEntry[], key: string): string | undefined {
  const entry = entries.find((rule) => rule.key === key);
  return entry ? getNameFromEntry(entry) : undefined;
}

function getListByKey(entries: RuleEntry[], key: string): string[] | undefined {
  const entry = entries.find((rule) => rule.key === key);
  return entry ? getListFromEntry(entry) : undefined;
}

function getPairListByKey(
  entries: RuleEntry[],
  key: string,
): [string, string][] | undefined {
  const entry = entries.find((rule) => rule.key === key);
  return entry ? getPairListFromEntry(entry) : undefined;
}

function hasFlag(entries: RuleEntry[], key: string): boolean {
  const entry = entries.find((rule) => rule.key === key);
  return Boolean(entry && !entry.value);
}

function getNameFromEntry(entry: RuleEntry): string | undefined {
  if (!entry.value) return undefined;
  const part = entry.value.parts[0];
  return part?.kind === "name" ? part.name : undefined;
}

function getListFromEntry(entry: RuleEntry): string[] | undefined {
  const listPart = findListPart(entry);
  return listPart?.kind === "list" ? listPart.items : undefined;
}

function getPairListFromEntry(
  entry: RuleEntry,
): [string, string][] | undefined {
  const listPart = findListPart(entry);
  return listPart?.kind === "pair_list" ? listPart.pairs : undefined;
}

function findListPart(entry: RuleEntry): RuleValuePart | undefined {
  if (!entry.value) return undefined;
  return entry.value.parts.find((part) =>
    part.kind === "list" || part.kind === "pair_list"
  );
}
