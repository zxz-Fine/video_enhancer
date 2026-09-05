export type LogLevel = 'info' | 'warn' | 'error' | 'gpu' | 'ai';

export interface LogEntry {
  time: string;
  level: LogLevel;
  msg: string;
}

const entries: LogEntry[] = [];
const listeners = new Set<(e: LogEntry) => void>();
const clearListeners = new Set<() => void>();

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

export function onClear(fn: () => void): () => void {
  clearListeners.add(fn);
  return () => clearListeners.delete(fn);
}

/** 新任务开始时清空，避免上次日志干扰 */
export function clearLogs(): void {
  entries.length = 0;
  clearListeners.forEach((fn) => fn());
}

export function getLogs(): LogEntry[] {
  return [...entries];
}
