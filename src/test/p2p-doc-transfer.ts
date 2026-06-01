import { irohTransport } from '../network/iroh-transport.js';
import * as fs from 'fs';
import * as path from 'path';

const args = process.argv.slice(2);
const role = args[0] as 'server' | 'client';
const targetNodeId = args[1];

if (!role || !['server', 'client'].includes(role)) {
  console.log('Usage:');
  console.log('  Server: npx tsx src/test/p2p-doc-transfer.ts server');
  console.log('  Client: npx tsx src/test/p2p-doc-transfer.ts client <server-node-id>');
  process.exit(1);
}

async function readDoc(filePath: string): Promise<{ name: string; content: string; size: number }> {
  const content = fs.readFileSync(filePath, 'utf-8');
  return {
    name: path.basename(filePath),
    content,
    size: Buffer.byteLength(content, 'utf-8'),
  };
}

async function runServer() {
  console.log('[Server] Starting iroh transport for document transfer test...');
  const node = await irohTransport.start();
  console.log('[Server] Node ID:', node.nodeId);
  console.log('[Server] Waiting for document transfers...\n');

  let docCount = 0;

  irohTransport.onMessage('doc-md', (msg) => {
    docCount++;
    const content = new TextDecoder().decode(msg.payload);
    console.log(`[Server] #${docCount} MD Doc from ${msg.from.substring(0, 16)}...`);
    console.log(`[Server] Size: ${content.length} bytes`);
    console.log(`[Server] Preview: "${content.substring(0, 80)}..."`);
    irohTransport.sendMessage(msg.from, 'ack-md', new TextEncoder().encode('md-received'));
  });

  irohTransport.onMessage('doc-yaml', (msg) => {
    docCount++;
    const content = new TextDecoder().decode(msg.payload);
    console.log(`[Server] #${docCount} YAML Doc from ${msg.from.substring(0, 16)}...`);
    console.log(`[Server] Size: ${content.length} bytes`);
    console.log(`[Server] Preview: "${content.substring(0, 80)}..."`);
    irohTransport.sendMessage(msg.from, 'ack-yaml', new TextEncoder().encode('yaml-received'));
  });

  irohTransport.onMessage('doc-html', (msg) => {
    docCount++;
    const content = new TextDecoder().decode(msg.payload);
    console.log(`[Server] #${docCount} HTML Doc from ${msg.from.substring(0, 16)}...`);
    console.log(`[Server] Size: ${content.length} bytes`);
    console.log(`[Server] Preview: "${content.substring(0, 80)}..."`);
    irohTransport.sendMessage(msg.from, 'ack-html', new TextEncoder().encode('html-received'));
  });

  console.log('[Server] Ready. Press Ctrl+C to stop.');
  await new Promise(() => {});
}

async function runClient(targetId: string) {
  if (!targetId) {
    console.error('[Client] Error: target node ID required');
    process.exit(1);
  }

  console.log('[Client] Starting iroh transport for document transfer test...');
  const node = await irohTransport.start();
  console.log('[Client] Node ID:', node.nodeId);
  console.log('[Client] Target:', targetId);
  console.log('');

  const acks = { md: false, yaml: false, html: false };

  irohTransport.onMessage('ack-md', (msg) => {
    console.log(`[Client] ✅ MD doc acknowledged by server`);
    acks.md = true;
  });

  irohTransport.onMessage('ack-yaml', (msg) => {
    console.log(`[Client] ✅ YAML doc acknowledged by server`);
    acks.yaml = true;
  });

  irohTransport.onMessage('ack-html', (msg) => {
    console.log(`[Client] ✅ HTML doc acknowledged by server`);
    acks.html = true;
  });

  await new Promise(resolve => setTimeout(resolve, 500));

  console.log('[Client] Loading test documents...\n');

  const testDocs = [
    { type: 'doc-md', path: 'src/bollharness/docs/practice.md', label: 'MD' },
    { type: 'doc-yaml', path: 'src/bollharness/.boll/MANIFEST.yaml', label: 'YAML' },
    { type: 'doc-html', path: 'src/web/index.html', label: 'HTML' },
  ];

  for (const doc of testDocs) {
    try {
      const docInfo = await readDoc(doc.path);
      console.log(`[Client] Sending ${doc.label} document: ${docInfo.name} (${docInfo.size} bytes)`);
      const success = await irohTransport.sendMessage(
        targetId,
        doc.type,
        new TextEncoder().encode(docInfo.content)
      );
      console.log(`[Client] Send result: ${success ? '✅ SUCCESS' : '❌ FAILED'}`);
    } catch (e: any) {
      console.log(`[Client] ❌ Error sending ${doc.label}: ${e.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('\n[Client] Waiting for acknowledgements...');
  await new Promise(resolve => setTimeout(resolve, 3000));

  console.log('\n=== Test Summary ===');
  console.log(`  MD document:   ${acks.md ? '✅ Acknowledged' : '❌ Not acknowledged'}`);
  console.log(`  YAML document: ${acks.yaml ? '✅ Acknowledged' : '❌ Not acknowledged'}`);
  console.log(`  HTML document: ${acks.html ? '✅ Acknowledged' : '❌ Not acknowledged'}`);

  await irohTransport.shutdown();
  console.log('[Client] Done');
}

if (role === 'server') {
  runServer();
} else {
  runClient(targetNodeId!);
}