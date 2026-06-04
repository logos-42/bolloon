import { Endpoint } from '@rayhanadev/iroh';
(async () => {
  console.log('A 启动...');
  const epA = await Endpoint.createWithOptions({ alpns: ['bolloon/iroh/1'] });
  await epA.online();
  const idA = epA.nodeId();
  console.log('A nodeId:', idA);

  console.log('B 启动...');
  const epB = await Endpoint.createWithOptions({ alpns: ['bolloon/iroh/1'] });
  await epB.online();
  const idB = epB.nodeId();
  console.log('B nodeId:', idB);

  // B accept 一会儿
  (async () => {
    console.log('B 接受中...');
    try {
      const c = await epB.accept();
      if (c) {
        console.log('B 接受到连接！rtt=', c.rtt());
        const bs = await c.acceptBi();
        const data = await bs.recv.readToEnd(1024);
        console.log('B 收到:', new TextDecoder().decode(data));
        await bs.send.send(new TextEncoder().encode('hello from B'));
        c.close();
      } else {
        console.log('B accept 返回 null (超时)');
      }
    } catch (e: any) { console.log('B accept err:', e.message); }
  })();

  await new Promise(r => setTimeout(r, 500));

  // A 连 B
  console.log('A 尝试连 B...');
  try {
    const c = await epA.connect(idB, 'bolloon/iroh/1');
    console.log('A 连接 B 成功, rtt=', c.rtt());
    const bs = await c.openBi();
    await bs.send.send(new TextEncoder().encode('hello from A'));
    const reply = await bs.recv.readToEnd(1024);
    console.log('A 收到回包:', new TextDecoder().decode(reply));
    c.close();
  } catch (e: any) { console.log('A→B FAIL:', e.message); }

  epA.close();
  epB.close();
  process.exit(0);
})();
