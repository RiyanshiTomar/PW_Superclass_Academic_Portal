const fs = require('fs');
const path = require('path');
const text = fs.readFileSync(path.join(process.cwd(), 'Acad Portal - Req -  Faculty (1).csv'), 'utf8');
const lines = text.replace(/\r\n/g, '\n').split('\n');
const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
const centreIdx = header.findIndex((h) => h.includes('center'));
if (centreIdx === -1) {
  console.error('Center column not found');
  process.exit(1);
}
const centres = new Map();
for (let i = 1; i < lines.length; i += 1) {
  const line = lines[i];
  if (!line.trim()) continue;
  const parts = line.split(',');
  const centre = (parts[centreIdx] || '').trim();
  if (!centre) continue;
  centres.set(centre, (centres.get(centre) || 0) + 1);
}
const entries = Array.from(centres.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
for (const [centre, count] of entries) {
  console.log(`${count} x ${JSON.stringify(centre)}`);
}
console.log('unique centre count:', entries.length);
