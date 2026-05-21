import { AgentAuthManager, KeyManager } from '@diap/sdk';
import { irohTransport } from './iroh-transport.js';

export async function bootstrapIroh(
  auth: AgentAuthManager,
  keyPair: Awaited<ReturnType<typeof KeyManager.generate>>,
  agentName: string
): Promise<string | null> {
  console.log('[Iroh] Starting iroh transport...');

  const node = await irohTransport.start();
  const nodeId = node.nodeId;
  console.log(`[Iroh] Node ID: ${nodeId}`);

  const services = [
    { serviceType: 'iroh', endpoint: nodeId },
    { serviceType: 'iroh-quic', endpoint: `iroh://${nodeId}` },
  ];

  try {
    const result = await auth.registerAgent(
      { name: agentName, services: services as any } as any,
      keyPair,
      nodeId
    );
    console.log(`[Iroh] Registered with DIAP: DID=${result.did.substring(0, 20)}...`);
  } catch (e) {
    console.warn('[Iroh] DIAP registration failed:', e);
  }

  irohTransport.onMessage('task', async (msg) => {
    console.log(`[Iroh] Received task from ${msg.from}: ${new TextDecoder().decode(msg.payload).substring(0, 50)}...`);
  });

  irohTransport.onMessage('relay', (msg) => {
    console.log(`[Iroh] Relay message from ${msg.from}`);
  });

  irohTransport.onMessage('blob', (msg) => {
    console.log(`[Iroh] Blob from ${msg.from}: ${msg.payload.length} bytes`);
  });

  return nodeId;
}

export async function connectToIrohPeer(targetNodeId: string, type: string, payload: string): Promise<boolean> {
  return irohTransport.sendMessage(targetNodeId, type, new TextEncoder().encode(payload));
}

export async function requestIrohPeer(targetNodeId: string, type: string, payload: string): Promise<string | null> {
  const response = await irohTransport.requestResponse(targetNodeId, type, new TextEncoder().encode(payload));
  return response ? new TextDecoder().decode(response) : null;
}

export function onIrohMessage(type: string, handler: (msg: { type: string; payload: Uint8Array; from: string }) => void): void {
  irohTransport.onMessage(type, handler);
}
