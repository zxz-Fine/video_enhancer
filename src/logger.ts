export type LogLevel = 'info' | 'warn' | 'error' | 'gpu' | 'ai';

export interface LogEntry {
  time: string;
  level: LogLevel;
  msg: string;
}

const entries: LogEntry[] = [];
const listeners = new Set<(e: LogEntry) => void>();

export function log(level: LogLevel, msg: string): void {
  const e: LogEntry = {
    time: new Date().toTimeString().slice(0, 8),
    level,
    msg,
  };
  entries.push(e);
  if (entries.length > 500) entries.shift();
  listeners.forEach((fn) => fn(e));
  if (level === 'error') console.error(msg);
  else if (level === 'warn') console.warn(msg);
}

export function onLog(fn: (e: LogEntry) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getLogs(): LogEntry[] {
  return [...entries];
}
