import { Endpoint, Connection } from '@rayhanadev/iroh';

const IROH_ALPN = 'bolloon/iroh/1';

async function testConnection() {
  console.log('=== iroh E2E Test ===\n');

  console.log('[1] Starting server...');
  const server = await Endpoint.createWithOptions({ alpns: [IROH_ALPN] });
  await server.online();
  console.log(`    Server ID: ${server.nodeId()}`);

  let serverConn: Connection | null = null;

  server.accept().then((conn: Connection) => {
    serverConn = conn;
    console.log('[Server] ✅ Connection accepted!');
  }).catch((e: any) => {
    console.log('[Server] ❌ Accept error:', e.message || e);
  });

  console.log('\n[2] Starting client...');
  const client = await Endpoint.createWithOptions({ alpns: [IROH_ALPN] });
  await client.online();
  console.log(`    Client ID: ${client.nodeId()}`);

  console.log('\n[3] Client connecting to server...');
  let clientConn: any = null;
  try {
    clientConn = await client.connect(server.nodeId(), IROH_ALPN);
    console.log('[Client] ✅ Connected!');
  } catch (e: any) {
    console.log('[Client] ❌ Connection failed:', e.message || e);
    await server.close();
    await client.close();
    return;
  }

  console.log('\n[4] Waiting for server to accept connection...');
  let waitCount = 0;
  while (!serverConn && waitCount < 20) {
    await new Promise(r => setTimeout(r, 500));
    waitCount++;
    process.stdout.write(`    Waiting... ${waitCount}/20\r`);
  }
  console.log('');

  if (!serverConn) {
    console.log('❌ Server did not accept connection');
    await server.close();
    await client.close();
    return;
  }

  console.log('[5] Client opening bi-stream...');
  const clientStreams = await clientConn.openBi();
  console.log('    Bi-stream opened');

  console.log('[6] Server accepting bi-stream...');
  let serverStreams: any = null;
  try {
    serverStreams = await serverConn.acceptBi();
    console.log('    Bi-stream accepted');
  } catch (e: any) {
    console.log('[Server] ❌ Accept bi error:', e.message || e);
  }

  if (!serverStreams) {
    console.log('❌ Server could not accept bi-stream');
    clientConn.close();
    await server.close();
    await client.close();
    return;
  }

  console.log('\n[7] Client sending message...');
  const { send: clientSend, recv: clientRecv } = clientStreams;
  const message = 'hello:this is a test message';
  await clientSend.writeAll(Buffer.from(message));
  await clientSend.finish();
  console.log(`    Sent: "${message}"`);

  console.log('[8] Server receiving message...');
  const { recv: serverRecv } = serverStreams;
  const received = await serverRecv.readToEnd(1024);
  console.log(`    ✅ Received: "${new TextDecoder().decode(received)}"`);

  console.log('\n[9] Server sending response...');
  const { send: serverSend } = serverStreams;
  const response = 'response:hello from server';
  await serverSend.writeAll(Buffer.from(response));
  await serverSend.finish();
  console.log(`    Sent: "${response}"`);

  console.log('[10] Client receiving response...');
  const resp = await clientRecv.readToEnd(1024);
  console.log(`    ✅ Received: "${new TextDecoder().decode(resp)}"`);

  console.log('\n✅✅✅ FULL E2E TEST PASSED ✅✅✅');

  clientConn.close();
  await server.close();
  await client.close();
}

testConnection().catch(console.error);
