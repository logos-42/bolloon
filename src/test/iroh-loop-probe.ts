/**
 * 探针：完全复刻 probe2 成功路径，但 B 用循环 accept
 */
import { Endpoint } from '@rayhanadev/iroh';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const epA = await Endpoint.createWithOptions({ alpns: ['bolloon/iroh/1'] });
  await epA.online();
  const epB = await Endpoint.createWithOptions({ alpns: ['bolloon/iroh/1'] });
  await epB.online();
  const idA = epA.nodeId();
  const idB = epB.nodeId();
  console.log('A:', idA.substring(0, 20));
  console.log('B:', idB.substring(0, 20));

  // B 开一个 accept 监听 (用 Promise.race 模拟"等一个连接")
  const acceptOne = (async () => {
    console.log('B: 等待入站 #1...');
    const c = await epB.accept();
    if (!c) { console.log('B: accept null'); return null; }
    console.log(`B: 收到入站 #1, rtt=${c.rtt()}`);
    c.acceptBi().then(async (bs) => {
      const data = await bs.recv.readToEnd(64*1024);
      console.log(`B: 读到 (${data.length} bytes): ${new TextDecoder().decode(data).substring(0,40)}`);
      await bs.send.write(Buffer.from('pong-from-B'));
      await bs.send.finish();
      c.close();
    });
    return c;
  })();

  await sleep(500);  // 关键：让 B 处于 accept 阻塞状态

  // A 连 B
  console.log('A: 连 B...');
  try {
    const c = await epA.connect(idB, 'bolloon/iroh/1');
    console.log('A: connected! rtt=', c.rtt());
    const bs = await c.openBi();
    await bs.send.write(Buffer.from('hello-A-1'));
    await bs.send.finish();
    const reply = await bs.recv.readToEnd(64*1024);
    console.log('A: 收到回包:', new TextDecoder().decode(reply));
    c.close();
  } catch (e: any) { console.log('A: FAIL:', e.message); }

  await acceptOne.catch(() => {});
  await sleep(300);

  // 第二个连接：先开 B accept 再 A 连
  const acceptTwo = (async () => {
    const c = await epB.accept();
    if (!c) return null;
    console.log(`B: 收到入站 #2, rtt=${c.rtt()}`);
    c.acceptBi().then(async (bs) => {
      const data = await bs.recv.readToEnd(64*1024);
      console.log(`B: 读到 #2: ${new TextDecoder().decode(data).substring(0,40)}`);
      await bs.send.write(Buffer.from('pong-from-B-2'));
      await bs.send.finish();
      c.close();
    });
    return c;
  })();
  await sleep(500);
  console.log('A: 连 B 第 2 次...');
  try {
    const c = await epA.connect(idB, 'bolloon/iroh/1');
    console.log('A: connected #2! rtt=', c.rtt());
    const bs = await c.openBi();
    await bs.send.write(Buffer.from('hello-A-2'));
    await bs.send.finish();
    const reply = await bs.recv.readToEnd(64*1024);
    console.log('A: 收到 #2:', new TextDecoder().decode(reply));
    c.close();
  } catch (e: any) { console.log('A: #2 FAIL:', e.message); }

  await acceptTwo.catch(() => {});
  await sleep(300);
  epA.close(); epB.close();
  process.exit(0);
})();
