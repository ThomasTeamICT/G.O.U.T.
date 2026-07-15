# Eigen BRouter-profielen

Leg hier een bestand `wandelen.brf`, `fietsen.brf` of `mtb.brf` neer en de server
uploadt het automatisch naar de BRouter-instantie en gebruikt het voor die sport
(met nette terugval op het standaardprofiel als de upload of routering faalt).

Aanraders uit de community (gratis te downloaden, bestand hernoemen volstaat):

- **MTB (bos & singletracks):** de MTB-profielen van Poutnik —
  https://github.com/poutnikl/Brouter-profiles (bv. `MTB.brf` → hier opslaan als `mtb.brf`)
- **Fietsen (rustige wegen):** Poutniks *Trekking-LowTraffic*-varianten → `fietsen.brf`
- **Wandelen:** het standaard `hiking-beta`-profiel verkiest al paden, bos en
  trage wegen; een eigen `wandelen.brf` is zelden nodig.

Zonder bestanden hier gebruikt G.O.U.T.: wandelen → `hiking-beta`,
fietsen → `trekking`, mtb → `mtb` (indien aanwezig op de server, anders `trekking`).
Alles blijft ook overschrijfbaar via de env-variabelen `BROUTER_PROFILE_*`.
