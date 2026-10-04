import type { Profile } from '../profile';
import { profileBullets } from '../profile';
import type { Answers } from '../answers';
import type { CvSelection } from '../apply/types';

export const MAX_BULLETS_PER_ROLE = 6;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderCvHtml(profile: Profile, answers: Answers, sel: CvSelection): string {
  const bullets = profileBullets(profile);
  const chosen = [...new Set(sel.bulletIds)].map((id) => bullets.find((b) => b.id === id)).filter((b): b is NonNullable<typeof b> => !!b);
  const groups = [...new Set([...sel.skillsOrder.filter((k) => profile.skills[k]), ...Object.keys(profile.skills)])];
  const contact = [answers.email, answers.phone, profile.location, answers.linkedin, answers.github, answers.portfolio]
    .filter((x): x is string => !!x).map(esc).join(' · ');

  const roles = profile.experience.map((e, ei) => {
    const items = chosen.filter((b) => b.id.startsWith(`e${ei}-`)).slice(0, MAX_BULLETS_PER_ROLE);
    if (!items.length) return '';
    return `<section class="role"><div class="rh"><b>${esc(e.role)}</b> — ${esc(e.company)}<span>${esc(e.start)} – ${esc(e.end)}</span></div><ul>${items.map((b) => `<li>${esc(b.text)}</li>`).join('')}</ul></section>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:Helvetica,Arial,sans-serif;font-size:10.5pt;color:#111;margin:0;line-height:1.35}
h1{font-size:18pt;margin:0}.hl{font-size:11pt;margin:2px 0 4px}.ct{font-size:9pt;color:#333}
h2{font-size:11pt;text-transform:uppercase;border-bottom:1px solid #999;margin:14px 0 6px;padding-bottom:2px}
.rh{display:flex;justify-content:space-between}.rh span{color:#444;font-size:9.5pt}ul{margin:4px 0 8px 16px;padding:0}li{margin:2px 0}
.sk b{text-transform:capitalize}
</style></head><body>
<h1>${esc(profile.name)}</h1><div class="hl">${esc(profile.headline)}</div><div class="ct">${contact}</div>
<h2>Summary</h2><p>${esc(profile.summary)}</p>
<h2>Skills</h2>${groups.map((k) => `<div class="sk"><b>${esc(k)}:</b> ${esc(profile.skills[k]!.join(', '))}</div>`).join('')}
<h2>Experience</h2>${roles}
<h2>Languages</h2><p>English: ${esc(profile.englishLevel)}</p>
</body></html>`;
}
