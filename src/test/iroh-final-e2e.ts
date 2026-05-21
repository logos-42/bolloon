import { Endpoint, Connection } from '@rayhanadev/iroh';

const IROH_ALPN = 'bolloon/iroh/1';

async function main() {
  console.log('=== iroh E2E Final Test ===\n');

  const serverEndpoint = await Endpoint.createWithOptions({ alpns: [IROH_ALPN] });
  await serverEndpoint.online();
  console.log('[Server] Started, ID:', serverEndpoint.nodeId().substring(0, 16) + '...');

  const clientEndpoint = await Endpoint.createWithOptions({ alpns: [IROH_ALPN] });
  await clientEndpoint.online();
  console.log('[Client] Started, ID:', clientEndpoint.nodeId().substring(0, 16) + '...');

  let serverConn: Connection | null = null;
  let serverConnPromise = serverEndpoint.accept().then(c => { serverConn = c; return c; });

  console.log('[Client] Connecting to server...');
  let clientConn: any = null;
  try {
    clientConn = await clientEndpoint.connect(serverEndpoint.nodeId(), IROH_ALPN);
    console.log('[Client] ✅ Connected!');
  } catch (e: any) {
    console.log('[Client] ❌ Failed:', e.message);
    return;
  }

  console.log('[Server] Waiting for accept...');
  try {
    await serverConnPromise;
    console.log('[Server] ✅ Connection accepted!');
  } catch (e: any) {
    console.log('[Server] ❌ Accept failed:', e.message);
    return;
  }

  console.log('[Client] Opening bi-stream...');
  let clientBi: any = null;
  try {
    clientBi = await clientConn.openBi();
    console.log('[Client] ✅ Bi-stream opened');
  } catch (e: any) {
    console.log('[Client] ❌ openBi failed:', e.message);
    return;
  }

  console.log('[Server] Accepting bi-stream...');
  let serverBi: any = null;
  try {
    serverBi = await serverConn!.acceptBi();
    console.log('[Server] ✅ Bi-stream accepted');
  } catch (e: any) {
    console.log('[Server] ❌ acceptBi failed:', e.message);
    return;
  }

  console.log('\n[Test] Sending message client → server...');
  const { send: cSend, recv: cRecv } = clientBi;
  await cSend.writeAll(Buffer.from('hello from client'));
  await cSend.finish();

  const { recv: sRecv, send: sSend } = serverBi;
  const msg = await sRecv.readToEnd(1024);
  console.log('[Server] ✅ Received:', new TextDecoder().decode(msg));

  console.log('[Server] Sending response...');
  await sSend.writeAll(Buffer.from('hello from server'));
  await sSend.finish();

  const resp = await cRecv.readToEnd(1024);
  console.log('[Client] ✅ Received:', new TextDecoder().decode(resp));

  console.log('\n✅✅✅ E2E TEST PASSED ✅✅✅');

  clientConn.close();
  await serverEndpoint.close();
  await clientEndpoint.close();
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
