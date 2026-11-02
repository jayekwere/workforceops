import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
for (const path of paths) {
  if (path.endsWith('.png')) continue;
  const content = readFileSync(path, 'utf8');
  if (content.includes(String.fromCodePoint(0x2014)))
    throw new Error('Disallowed punctuation: ' + path);
  if (/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{25,}/.test(content))
    throw new Error('Credential pattern: ' + path);
}
console.log('PASS: tracked text and credential-pattern policy');
