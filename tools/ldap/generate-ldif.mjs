// Writes the directory for the OpenLDAP end-to-end test (M1-082) as LDIF: PEOPLE people in
// groups nested four levels deep (teams of five, groups of five teams, departments of eight
// groups, divisions of five departments; every tenth person also directly in a group), the
// same shape as apps/server/src/ldap/sync.scale.test.ts. Passwords come from the environment,
// made per run by tools/ldap/openldap-test.sh; none is written anywhere else.
//
//   node tools/ldap/generate-ldif.mjs <people> <out.ldif>
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [count = '10000', out = 'directory.ldif'] = process.argv.slice(2);
const people = Number(count);
const bindPassword = process.env.TASKMOOR_OPENLDAP_BIND_PASSWORD;
const userPassword = process.env.TASKMOOR_OPENLDAP_USER_PASSWORD;
if (!bindPassword || !userPassword) {
  console.error('TASKMOOR_OPENLDAP_BIND_PASSWORD and TASKMOOR_OPENLDAP_USER_PASSWORD are required');
  process.exit(2);
}
const base = 'dc=example,dc=com';
mkdirSync(dirname(out), { recursive: true });
const file = createWriteStream(out);
const entry = (lines) => file.write(`${lines.join('\n')}\n\n`);

entry([
  `dn: ${base}`,
  'objectClass: top',
  'objectClass: dcObject',
  'objectClass: organization',
  'o: Example',
  'dc: example',
]);
for (const ou of ['people', 'groups']) {
  entry([`dn: ou=${ou},${base}`, 'objectClass: organizationalUnit', `ou: ${ou}`]);
}
entry([
  `dn: cn=sync,${base}`,
  'objectClass: organizationalRole',
  'objectClass: simpleSecurityObject',
  'cn: sync',
  `userPassword: ${bindPassword}`,
]);
const person = (i) => `uid=p${i},ou=people,${base}`;
for (let i = 0; i < people; i++) {
  entry([
    `dn: ${person(i)}`,
    'objectClass: inetOrgPerson',
    `uid: p${i}`,
    `cn: Person ${i}`,
    `sn: ${i}`,
    `displayName: Person ${i}`,
    `mail: p${i}@openldap.test`,
    // The first five can sign in; the test changes one of their passwords.
    ...(i < 5 ? [`userPassword: ${userPassword}`] : []),
  ]);
}
const group = (cn) => `cn=${cn},ou=groups,${base}`;
const write = (cn, members) =>
  entry([
    `dn: ${group(cn)}`,
    'objectClass: groupOfNames',
    `cn: ${cn}`,
    ...members.map((m) => `member: ${m}`),
  ]);
const teams = Math.ceil(people / 5);
for (let t = 0; t < teams; t++) {
  const members = [];
  for (let i = t * 5; i < Math.min(people, t * 5 + 5); i++) members.push(person(i));
  write(`team-${t}`, members);
}
const groups = Math.ceil(teams / 5);
for (let g = 0; g < groups; g++) {
  const members = [];
  for (let t = g * 5; t < Math.min(teams, g * 5 + 5); t++) members.push(group(`team-${t}`));
  for (let i = 0; i < people; i += 10)
    if (Math.floor(i / 25) % groups === g) members.push(person(i));
  write(`group-${g}`, members);
}
const departments = Math.ceil(groups / 8);
for (let d = 0; d < departments; d++) {
  const members = [];
  for (let g = d * 8; g < Math.min(groups, d * 8 + 8); g++) members.push(group(`group-${g}`));
  write(`department-${d}`, members);
}
const divisions = Math.ceil(departments / 5);
for (let v = 0; v < divisions; v++) {
  const members = [];
  for (let d = v * 5; d < Math.min(departments, v * 5 + 5); d++)
    members.push(group(`department-${d}`));
  write(`division-${v}`, members);
}
file.end(() => {
  console.log(JSON.stringify({ people, groups: teams + groups + departments + divisions, out }));
});
