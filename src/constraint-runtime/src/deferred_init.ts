export interface DeferredInitResult {
  trusted: boolean;
  pluginInit: boolean;
  skillInit: boolean;
  mcpPrefetch: boolean;
  sessionHooks: boolean;
}

export function runDeferredInit(trusted: boolean): DeferredInitResult {
  const enabled = Boolean(trusted);
  return {
    trusted,
    pluginInit: enabled,
    skillInit: enabled,
    mcpPrefetch: enabled,
    sessionHooks: enabled,
  };
}
