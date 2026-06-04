import { Endpoint } from '@rayhanadev/iroh';
(async () => {
  const ep = await Endpoint.createWithOptions({ alpns: ['bolloon/iroh/1'] });
  await ep.online();
  const id = ep.nodeId();
  console.log('nodeId:', id.substring(0, 24));
  console.log('isOnline:', ep.isOnline?.());
  try {
    const c = await ep.connect(id, 'bolloon/iroh/1');
    console.log('self rtt=', c.rtt());
  } catch (e: any) { console.log('self FAIL:', e.message); }
  try { console.log('addrs:', JSON.stringify(ep.addrs?.() ?? null)); } catch (e: any) { console.log('addrs err:', e.message); }
  ep.close();
  process.exit(0);
})();
