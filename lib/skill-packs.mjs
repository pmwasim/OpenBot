import { redactSecrets } from './provider.mjs';

export const SKILL_PACK_SCHEMA = 'openbot.skill-pack';
export const SKILL_PACK_LIMITS = Object.freeze({
  version: 1,
  maxSkills: 20,
  maxBytes: 60 * 1024,
  maxNameChars: 120,
  maxDescriptionChars: 400,
  maxInstructionChars: 8000
});

function invalid(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function parseInput(input) {
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > SKILL_PACK_LIMITS.maxBytes) throw invalid('Skill pack is too large.');
    try { return JSON.parse(input); } catch { throw invalid('Skill pack must be valid JSON.'); }
  }
  return input;
}

function normalizeSkill(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('Each skill pack entry must be an object.');
  const name = String(raw.name || '').trim();
  const description = redactSecrets(String(raw.description || '').trim());
  const instructions = redactSecrets(String(raw.instructions || raw.content || '').trim());
  if (!name || name.length > SKILL_PACK_LIMITS.maxNameChars) throw invalid('Skill pack names must be between 1 and 120 characters.');
  if (description.length > SKILL_PACK_LIMITS.maxDescriptionChars) throw invalid('Skill pack descriptions must be 400 characters or fewer.');
  if (!instructions || instructions.length > SKILL_PACK_LIMITS.maxInstructionChars) throw invalid('Skill pack instructions must be between 1 and 8000 characters.');
  return { name, description, instructions };
}

export function parseSkillPack(input) {
  const pack = parseInput(input);
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) throw invalid('Skill pack must be an object.');
  if (pack.schema !== SKILL_PACK_SCHEMA || Number(pack.version) !== SKILL_PACK_LIMITS.version) throw invalid('Unsupported skill pack schema or version.');
  if (!Array.isArray(pack.skills) || pack.skills.length > SKILL_PACK_LIMITS.maxSkills) throw invalid(`Skill packs must contain 0 to ${SKILL_PACK_LIMITS.maxSkills} skills.`);
  const seen = new Set();
  const skills = pack.skills.map(normalizeSkill);
  for (const skill of skills) {
    const key = skill.name.toLowerCase();
    if (seen.has(key)) throw invalid(`Skill pack contains duplicate skill name "${skill.name}".`);
    seen.add(key);
  }
  const normalized = { schema: SKILL_PACK_SCHEMA, version: SKILL_PACK_LIMITS.version, skills };
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > SKILL_PACK_LIMITS.maxBytes) throw invalid('Skill pack is too large.');
  return normalized;
}

export function createSkillPack(skills = []) {
  return parseSkillPack({ schema: SKILL_PACK_SCHEMA, version: SKILL_PACK_LIMITS.version, skills });
}

export async function importSkillPack(store, input) {
  if (!store?.listSkills || !store?.createSkill) throw new Error('importSkillPack requires a skill store.');
  const pack = parseSkillPack(input);
  const existing = new Set((await store.listSkills()).map((skill) => String(skill.name || '').toLowerCase()));
  const imported = [];
  const skipped = [];
  for (const skill of pack.skills) {
    const key = skill.name.toLowerCase();
    if (existing.has(key)) {
      skipped.push({ name: skill.name, reason: 'already_exists' });
      continue;
    }
    const created = await store.createSkill({ ...skill, owner: 'operator' });
    imported.push(created.skill);
    existing.add(key);
  }
  return { schema: pack.schema, version: pack.version, imported, skipped };
}
