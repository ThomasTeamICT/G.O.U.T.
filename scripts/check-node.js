// Duidelijke melding i.p.v. een cryptische crash bij een te oude Node-versie
// (node:sqlite zit pas ingebouwd vanaf Node 22.5).
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 5)) {
  console.error(
    `\n✖ G.O.U.T. heeft Node.js 22.5 of nieuwer nodig — jij draait ${process.versions.node}.\n` +
    '  Download de actuele LTS via https://nodejs.org en probeer opnieuw.\n'
  );
  process.exit(1);
}
