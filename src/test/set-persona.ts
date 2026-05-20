import { config } from 'dotenv';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { PersonaDoc } from '../social/heartbeat.js';

config();

const PERSONA_TEMPLATE_PATH = path.join('src', 'bollharness', 'templates', 'persona', 'default.json');
const PERSONA_PATH = path.join(process.env.HOME || '/tmp', '.bolloon', 'persona.json');

async function loadPersonaTemplate(): Promise<PersonaDoc> {
  const content = await fs.readFile(PERSONA_TEMPLATE_PATH, 'utf-8');
  const persona = JSON.parse(content) as PersonaDoc;
  persona.createdAt = new Date().toISOString();
  persona.updatedAt = new Date().toISOString();
  return persona;
}

async function testSetPersona() {
  console.log('=== 测试 set_persona 功能 ===\n');

  const { createAgentSession } = await import('../agents/pi-sdk.js');

  const session = await createAgentSession({ cwd: process.cwd() });

  const originalIdentity = session.getIdentity();
  console.log('原始身份:', originalIdentity.name);

  const originalPersona = session.getPersona();
  console.log('原始 persona:', originalPersona ? JSON.stringify(originalPersona, null, 2) : 'null');

  const newPersona = await loadPersonaTemplate();
  console.log('\n📄 从模板加载 persona:', JSON.stringify(newPersona, null, 2));

  await session.setPersona(newPersona);
  console.log('\n✅ 已设置新 persona');

  const updatedIdentity = session.getIdentity();
  console.log('更新后身份:', updatedIdentity.name);

  const updatedPersona = session.getPersona();
  console.log('更新后 persona:', updatedPersona ? JSON.stringify(updatedPersona, null, 2) : 'null');

  console.log('\n📁 persona.json 路径:', PERSONA_PATH);

  try {
    const fileContent = await fs.readFile(PERSONA_PATH, 'utf-8');
    console.log('📄 文件内容:', fileContent);
  } catch (e) {
    console.log('读取文件失败:', e);
  }

  console.log('\n=== 测试完成 ===');
}

testSetPersona().catch(console.error);