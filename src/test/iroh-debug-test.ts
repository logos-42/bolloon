import { Endpoint } from '@rayhanadev/iroh';

const IROH_ALPN = 'bolloon/iroh/1';

async function testConnection() {
  console.log('=== iroh Connection Debug Test ===\n');

  console.log('[1] Starting server...');
  const server = await Endpoint.createWithOptions({ alpns: [IROH_ALPN] });
  await server.online();
  console.log(`    Server ID: ${server.nodeId()}`);
  console.log(`    Server addr: ${server.addr()}`);

  let acceptResult: any = null;
  const acceptPromise = server.accept().then(conn => {
    acceptResult = conn;
    console.log('[Server] ✅ Connection accepted!');
    return conn;
  }).catch(e => {
    console.log('[Server] ❌ Accept error:', e.message || e);
  });

  console.log('\n[2] Starting client...');
  const client = await Endpoint.createWithOptions({ alpns: [IROH_ALPN] });
  await client.online();
  console.log(`    Client ID: ${client.nodeId()}`);

  console.log('\n[3] Client connecting to server...');
  const connectPromise = client.connect(server.nodeId(), IROH_ALPN)
    .then(conn => {
      console.log('[Client] ✅ Connected!');
      return conn;
    })
    .catch(e => {
      console.log('[Client] ❌ Connection error:', e.message || e);
      return null;
    });

  console.log('    Waiting 20s for connection...');

  const timeout = new Promise(r => setTimeout(r, 20000));

  const result = await Promise.race([connectPromise, timeout]);

  if (result && result !== timeout) {
    console.log('\n[4] Connection established, testing message...');
    const { send, recv } = await result.openBi();
    await send.writeAll(Buffer.from('test:hello'));
    await send.finish();
    console.log('    Message sent');

    await new Promise(r => setTimeout(r, 2000));

    if (acceptResult) {
      const data = await recv.readToEnd(1024);
      console.log(`    ✅ Received: "${new TextDecoder().decode(data)}"`);
      console.log('\n✅ TEST PASSED');
    }
  } else if (!result) {
    console.log('\n❌ Connection failed');
  } else {
    console.log('\n⏳ Connection timed out');
  }

  await server.close().catch(() => {});
  await client.close().catch(() => {});
}

testConnection().catch(console.error);
