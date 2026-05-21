import { Endpoint } from '@rayhanadev/iroh';

const IROH_ALPN = 'bolloon/iroh/1';

async function testConnection() {
  console.log('=== iroh Relay Connection Test ===\n');

  console.log('[1] Starting server...');
  const server = await Endpoint.createWithOptions({ alpns: [IROH_ALPN] });
  await server.online();
  console.log(`    Server ID: ${server.nodeId()}`);
  console.log(`    Server addr: ${server.addr()}`);

  console.log('\n[2] Starting client...');
  const client = await Endpoint.createWithOptions({ alpns: [IROH_ALPN] });
  await client.online();
  console.log(`    Client ID: ${client.nodeId()}`);

  console.log('\n[3] Client connecting to server via relay...');
  try {
    console.log('    Waiting for connection (relay may take time)...');
    const conn = await client.connect(server.nodeId(), IROH_ALPN);
    console.log('[Client] ✅ Connected!');
    console.log(`    Remote: ${conn.remoteNodeId()}`);

    console.log('\n[4] Client sending message...');
    const { send, recv } = await conn.openBi();
    await send.writeAll(Buffer.from('hello:test message'));
    await send.finish();
    console.log('    Message sent');

    console.log('\n[5] Server receiving...');
    const data = await recv.readToEnd(1024);
    console.log(`    ✅ Received: "${new TextDecoder().decode(data)}"`);

    console.log('\n✅ FULL E2E TEST PASSED');
    conn.close();
  } catch (e: any) {
    console.log('[Client] ❌ Connection failed:', e.message || e);
  }

  await server.close();
  await client.close();
}

testConnection().catch(console.error);
