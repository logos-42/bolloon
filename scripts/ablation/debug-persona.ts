import { loadPersonaDocs, formatPersonaForSystemPrompt } from '../../src/bootstrap/persona-loader.ts';

const docs = await loadPersonaDocs('agent_33e1fa85');
console.log('agentId:', docs.agentId);
console.log('soul len:', docs.soul.length);
console.log('identity len:', docs.identity.length);
console.log('---');
const text = formatPersonaForSystemPrompt(docs, 4000);
console.log('TEXT_LEN=' + text.length);
const idIdx = text.indexOf('## Identity');
const soulIdx = text.indexOf('## Soul');
console.log('ID_IDX=' + idIdx);
console.log('SOUL_IDX=' + soulIdx);
console.log('ID_BEFORE_SOUL=' + (idIdx < soulIdx));
console.log('---');
console.log('FIRST_500:', text.substring(0, 500));