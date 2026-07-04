import { loadSkillsFromPaths, defaultSkillPaths } from '../../src/agents/skill-loader.ts';

const paths = defaultSkillPaths();
console.log('PATHS=' + JSON.stringify(paths));
const skills = await loadSkillsFromPaths(paths);
console.log('COUNT=' + skills.length);
for (const s of skills) {
  console.log(`SKILL name=${s.name} desc=${s.description?.slice(0, 80)}`);
}