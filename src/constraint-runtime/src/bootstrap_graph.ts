export interface BootstrapGraph {
  stages: string[];
}

export function buildBootstrapGraph(): BootstrapGraph {
  return {
    stages: [
      'top-level prefetch side effects',
      'warning handler and environment guards',
      'CLI parser and pre-action trust gate',
      'setup() + commands/agents parallel load',
      'deferred init after trust',
      'mode routing: local / remote / ssh / teleport / direct-connect / deep-link',
      'query engine submit loop',
    ],
  };
}
