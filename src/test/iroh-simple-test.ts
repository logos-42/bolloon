import { Endpoint, Connection } from '@rayhanadev/iroh';

const IROH_ALPN = 'bolloon/iroh/1';

async function testConnection() {
  console.log('=== iroh E2E Test (Simple) ===\n');

  console.log('[1] Starting server...');
  const server = await Endpoint.createWithOptions({ alpns: [IROH_ALPN] });
  await server.online();
  console.log(`    Server ID: ${server.nodeId()}`);

  console.log('[2] Starting client...');
  const client = await Endpoint.createWithOptions({ alpns: [IROH_ALPN] });
  await client.online();
  console.log(`    Client ID: ${client.nodeId()}`);

  console.log('\n[3] Client connecting...');
  let clientConn: any = null;
  try {
    clientConn = await client.connect(server.nodeId(), IROH_ALPN);
    console.log('[Client] ✅ Connected!');
  } catch (e: any) {
    console.log('[Client] ❌ Failed:', e.message || e);
    await server.close();
    await client.close();
    return;
  }

  console.log('[4] Client sending datagram...');
  try {
    clientConn.sendDatagram(Buffer.from('hello:test datagram'));
    console.log('    Datagram sent');
  } catch (e: any) {
    console.log('[Client] ❌ Datagram failed:', e.message || e);
  }

  console.log('[5] Waiting 3s...');
  await new Promise(r => setTimeout(r, 3000));

  console.log('[6] Closing connections...');
  clientConn.close();
  await server.close();
  await client.close();

  console.log('\n✅ Connection test completed');
}

testConnection().catch(console.error);
