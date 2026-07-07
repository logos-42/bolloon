import { describe, it } from 'vitest';

describe('env probe', () => {
  it('capture HOME on import', () => {
    console.log('IMPORT-TIME HOME:', JSON.stringify(process.env.HOME));
    console.log('IMPORT-TIME USERPROFILE:', JSON.stringify(process.env.USERPROFILE));
  });
  it('capture HOME in beforeEach via top-level constant', async () => {
    const path = await import('path');
    const cap = path.join(process.env.HOME || '/tmp', '.bolloon', 'human-values');
    console.log('LIVE PATH JOIN:', cap);
  });
});
