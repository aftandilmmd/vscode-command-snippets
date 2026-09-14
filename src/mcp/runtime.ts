import * as fs from 'fs';
import { runtimePath } from './paths';

/**
 * Written by the extension while it is running, read by the MCP server. It is the only
 * channel that can switch `run_snippet` on — the MCP process cannot read VS Code settings.
 */
export interface RuntimeInfo {
  allowRun: boolean;
  version: string;
  pid: number;
  lastSeen: number;
}

/** A heartbeat older than this means VS Code is gone (or crashed). */
export const STALE_AFTER_MS = 30_000;

export function readRuntime(now = Date.now()): RuntimeInfo | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(runtimePath(), 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const info = raw as Partial<RuntimeInfo>;
  if (typeof info.lastSeen !== 'number' || now - info.lastSeen > STALE_AFTER_MS) {
    return undefined;
  }
  return {
    allowRun: info.allowRun === true,
    version: typeof info.version === 'string' ? info.version : 'unknown',
    pid: typeof info.pid === 'number' ? info.pid : -1,
    lastSeen: info.lastSeen
  };
}

/** True when VS Code is running and the user has opted into agent-requested runs. */
export function runAllowed(now = Date.now()): boolean {
  return readRuntime(now)?.allowRun === true;
}
