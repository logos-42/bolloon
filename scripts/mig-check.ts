import { migrateAllExternalAgents, formatMigrationNotices } from '../src/migration/external-agent-migrator.js';

async function main() {
  const r = await migrateAllExternalAgents();
  const rep = r.map((x) => ({
    source: x.source,
    persona: x.persona.length,
    skills: x.skillsCopied.length,
    memory: x.memoryCopied.length,
    docs: x.docsCopied.length,
    agentId: x.personaAgentId,
    errors: x.errors,
  }));
  console.log(JSON.stringify(rep, null, 2));
  console.log('NOTICES:');
  formatMigrationNotices(r).forEach((n) => console.log('  ' + n));
}

main();