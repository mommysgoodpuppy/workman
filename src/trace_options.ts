export interface TraceOptions {
  print: boolean;
  capture: boolean;
}

export const DEFAULT_TRACE_OPTIONS: TraceOptions = {
  print: false,
  capture: true,
};

export function applyTraceFlag(
  arg: string,
  options: TraceOptions,
): boolean {
  if (arg === "--trace") {
    options.print = true;
    options.capture = true;
    return true;
  }
  if (arg === "--perf") {
    options.print = false;
    options.capture = false;
    return true;
  }
  return false;
}
