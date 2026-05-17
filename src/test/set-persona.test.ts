import { config } from 'dotenv';
import * as path from 'path';

config();

async function testSetPersona() {
  console.log('=== 测试 set_persona 功能 ===\n');

  const { createAgentSession } = await import('../agents/pi-sdk.js');

  const session = await createAgentSession({ cwd: process.cwd() });

  const originalIdentity = session.getIdentity();
  console.log('原始身份:', originalIdentity.name);

  const originalPersona = session.getPersona();
  console.log('原始 persona:', originalPersona ? JSON.stringify(originalPersona, null, 2) : 'null');

  const newPersona = {
    name: 'TestBolloon',
    description: '一个测试用 bolloon',
    personality: '活泼好动',
    greeting: '你好！我是 TestBolloon！',
    capabilities: ['文档处理', '测试'],
    interests: ['测试', '开发']
  };

  await session.setPersona(newPersona);
  console.log('\n✅ 已设置新 persona');

  const updatedIdentity = session.getIdentity();
  console.log('更新后身份:', updatedIdentity.name);

  const updatedPersona = session.getPersona();
  console.log('更新后 persona:', updatedPersona ? JSON.stringify(updatedPersona, null, 2) : 'null');

  const personaFilePath = path.join(process.env.HOME || '/tmp', '.bolloon', 'persona.json');
  console.log('\n📁 persona.json 路径:', personaFilePath);

  const fs = await import('fs/promises');
  try {
    const fileContent = await fs.readFile(personaFilePath, 'utf-8');
    console.log('📄 文件内容:', fileContent);
  } catch (e) {
    console.log('读取文件失败:', e);
  }

  console.log('\n=== 测试完成 ===');
}

testSetPersona().catch(console.error);