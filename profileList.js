const fs = require('fs');
const path = require('path');

// Parse `hermes profile list` output into {name, model} entries, filtering
// out Hermes's built-in `default` scaffold unless the user actually has a
// Circe-managed profiles/default/ directory. Non-default names are never
// filtered — presence/absence of their directory doesn't gate them (they
// may be listed by hermes for reasons Circe doesn't track).
function parseProfilesList(text, hermesHome) {
  const profiles = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    if (!/^\s*[◆◇•\s]/.test(line)) continue;
    const m = line.match(/^\s*[◆◇•]?\s*([A-Za-z0-9_-]+)\s+(\S+)/);
    if (!m) continue;
    const name = m[1];
    const model = m[2];
    if (name === 'Profile' || name.startsWith('─')) continue;
    // Hermes ships a built-in `default` entry (marked ◆) as its root config.
    // It has no Circe-written provider block, so hitting `session/new` on it
    // yields "Internal error" / 529 from whatever fallback provider Hermes
    // picks. Only surface `default` if the user has an actual profile dir.
    if (name === 'default') {
      const dir = path.join(hermesHome, 'profiles', 'default');
      if (!fs.existsSync(dir)) continue;
    }
    profiles.push({ name, model });
  }
  return profiles;
}

async function loadProfiles(runHermes, hermesHome) {
  const out = await runHermes(['profile', 'list']);
  return parseProfilesList(out, hermesHome);
}

module.exports = { parseProfilesList, loadProfiles };
