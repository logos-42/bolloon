export interface Adapter {
  name: string;
  description: string;
}

export async function listAdapters(): Promise<Adapter[]> {
  return [
    { name: 'twitter', description: 'Twitter/X adapter' },
    { name: 'reddit', description: 'Reddit adapter' },
    { name: 'bilibili', description: 'Bilibili adapter' },
  ];
}