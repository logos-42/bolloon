import { Endpoint } from '@rayhanadev/iroh';

const IROH_ALPN = 'bolloon/iroh/1';

async function testConnection() {
  console.log('=== Direct Connection Test ===\n');

  // Server
  console.log('[1] Starting server...');
  const server = await Endpoint.createWithOptions({ alpns: [IROH_ALPN] });
  await server.online();
  const serverId = server.nodeId();
  console.log(`    Server ID: ${serverId}`);
  console.log(`    Server addr: ${server.addr()}`);

  // Accept in background
  let acceptedConn: any = null;
  server.accept().then((conn: any) => {
    console.log('[Server] Connection accepted!');
    acceptedConn = conn;
  });

  // Client
  console.log('\n[2] Starting client...');
  const client = await Endpoint.createWithOptions({ alpns: [IROH_ALPN] });
  await client.online();
  const clientId = client.nodeId();
  console.log(`    Client ID: ${clientId}`);

  console.log('\n[3] Client connecting to server...');
  try {
    const conn = await client.connect(serverId, IROH_ALPN);
    console.log('[Client] Connected!');
    console.log(`    Remote: ${conn.remoteNodeId()}`);

    // Send message
    console.log('\n[4] Client sending message...');
    const { send, recv } = await conn.openBi();
    await send.writeAll(Buffer.from('hello:world'));
    await send.finish();

    console.log('[5] Waiting for server to receive...');
    await new Promise(r => setTimeout(r, 2000));

    if (acceptedConn) {
      console.log('[Server] Reading message...');
      const data = await recv.readToEnd(1024);
      console.log(`    Received: "${new TextDecoder().decode(data)}"`);
      console.log('✅ CONNECTION TEST PASSED');
    } else {
      console.log('❌ Server did not accept connection');
    }

    conn.close();
  } catch (e) {
    console.log('[Client] Connection failed:', e);
    console.log('❌ CONNECTION TEST FAILED');
  }

  await server.close();
  await client.close();
  console.log('\nDone');
}

testConnection().catch(console.error);
