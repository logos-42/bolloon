import { Endpoint, Connection } from '@rayhanadev/iroh';

const IROH_ALPN = 'bolloon/iroh/1';

async function main() {
  console.log('=== iroh Debug Bi-stream ===\n');

  const server = await Endpoint.createWithOptions({ alpns: [IROH_ALPN] });
  await server.online();
  console.log('[Server] ID:', server.nodeId());

  const client = await Endpoint.createWithOptions({ alpns: [IROH_ALPN] });
  await client.online();
  console.log('[Client] ID:', client.nodeId());

  console.log('\n[Connect] Client connecting...');
  const clientConn = await client.connect(server.nodeId(), IROH_ALPN);
  console.log('[Client] Connected!');

  console.log('[Accept] Server accepting...');
  const serverConn = await server.accept();
  console.log('[Server] Accepted!');

  console.log('\n[Bi-stream] Client opening...');
  const clientBi = await clientConn.openBi();
  console.log('[Client] Bi-stream opened');

  console.log('[Bi-stream] Server accepting (with 2s timeout)...');
  const acceptPromise = serverConn.acceptBi();
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('acceptBi timeout')), 2000)
  );

  try {
    const serverBi = await Promise.race([acceptPromise, timeoutPromise]);
    console.log('[Server] Bi-stream accepted!');
  } catch (e: any) {
    console.log('[Server] Bi-stream accept error:', e.message);
    console.log('[Debug] Checking serverConn state...');
    console.log('  serverConn:', !!serverConn);
    console.log('  serverConn.remoteNodeId:', serverConn?.remoteNodeId?.());
  }

  console.log('\n[Cleanup]');
  clientConn.close();
  await server.close();
  await client.close();
}

main().catch(console.error);
