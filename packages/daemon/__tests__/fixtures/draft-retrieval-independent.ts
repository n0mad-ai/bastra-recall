/** Second frozen DE/EN corpus, authored separately from the technical C corpus.
 * Fifty operational/non-software topics, four independently phrased rows each.
 * This fixture is measured, never used to select or tune the fixed DF rule. */
import { draftFingerprint, draftId, type Draft } from "../../src/draft-store.js";
const FACTS: [string,string,string,string][] = [
 ["Im Dentallabor werden Keramikkronen vor der Glasur sandgestrahlt","Dental laboratory ceramic crowns are sandblasted before glazing","Wann werden Keramikkronen sandgestrahlt?","Are ceramic crowns sandblasted before glazing?"],
 ["Die Seilbahn fährt bei Gewitterwarnung sofort zur Talstation","The cable car returns to the valley station during thunderstorm warnings","Was tut die Seilbahn bei Gewitterwarnung?","Where does the cable car go during thunderstorm warnings?"],
 ["Der Windkanal misst den Luftwiderstand mit einer Kraftmessdose","The wind tunnel measures aerodynamic drag with a load cell","Wie misst der Windkanal den Luftwiderstand?","How does the wind tunnel measure aerodynamic drag?"],
 ["Im Lederatelier wird Sattelleder ausschließlich mit Bienenwachs gepflegt","The leather atelier treats saddle leather exclusively with beeswax","Wie wird Sattelleder im Lederatelier gepflegt?","How is saddle leather treated with beeswax?"],
 ["Die Pralinenfüllung kühlt vor dem Verschließen auf Zimmertemperatur","The chocolate filling cools to room temperature before sealing","Wann erreicht die Pralinenfüllung Zimmertemperatur?","Does the chocolate filling cool before sealing?"],
 ["Der Gezeitenkalender zeigt Springtiden mit einem violetten Kreis","The tidal calendar marks spring tides with a violet circle","Wie zeigt der Gezeitenkalender Springtiden?","How are spring tides marked in the tidal calendar?"],
 ["Das Notariatsarchiv bewahrt Vollmachten in säurefreien Umschlägen","The notarial archive stores powers of attorney in acidfree envelopes","Wo liegen Vollmachten im Notariatsarchiv?","What envelopes does the notarial archive use?"],
 ["Die Sternwarte schließt ihre Kuppel automatisch bei Schneefall","The observatory closes its dome automatically during snowfall","Wann schließt die Sternwarte ihre Kuppel?","Does the observatory dome close during snowfall?"],
 ["Die Uhrenwerkstatt prüft Hemmungsräder unter dem Stereomikroskop","The watch workshop examines escapement wheels under a stereomicroscope","Wie prüft die Uhrenwerkstatt Hemmungsräder?","How are escapement wheels examined with a stereomicroscope?"],
 ["Das Fährticket enthält einen Barcode für die Fahrradmitnahme","The ferry ticket includes a barcode for bicycle transport","Wozu enthält das Fährticket einen Barcode?","Does the ferry ticket cover bicycle transport?"],
 ["Der Edelsteinschleifer verwendet Diamantpaste für die Endpolitur","The gemstone cutter uses diamond paste for final polishing","Was verwendet der Edelsteinschleifer zur Endpolitur?","Does the gemstone cutter use diamond paste?"],
 ["Im Segelflugzeug wird der Höhenmesser vor dem Windenstart eingestellt","The glider altimeter is adjusted before the winch launch","Wann wird der Höhenmesser beim Windenstart eingestellt?","When is the glider altimeter adjusted?"],
 ["Der Akustikraum hat hinter den Vorhängen zusätzliche Bassabsorber","The acoustic room has extra bass absorbers behind the curtains","Wo stehen die Bassabsorber im Akustikraum?","Where are the acoustic room bass absorbers?"],
 ["Die Maskenbildnerin klebt Perücken mit wasserlöslichem Hautkleber","The makeup artist attaches wigs with watersoluble skin adhesive","Welchen Hautkleber nutzt die Maskenbildnerin?","How does the makeup artist attach wigs?"],
 ["Der Hubschrauberlandeplatz wird nachts von Randfeuern beleuchtet","The helicopter landing pad uses perimeter lights at night","Wie wird der Hubschrauberlandeplatz von Randfeuern beleuchtet?","What lights illuminate the helicopter landing pad?"],
 ["Die Käsereifung erfolgt auf unbehandelten Fichtenbrettern","Cheese maturation takes place on untreated spruce boards","Welche Fichtenbretter dienen der Käsereifung?","Which boards are used for cheese maturation?"],
 ["Die Restauratorin fixiert Pigmentschichten mit Hausenblase","The conservator secures pigment layers with isinglass","Wie fixiert die Restauratorin Pigmentschichten?","How does the conservator secure pigment layers?"],
 ["Der Zirkuswagen lagert Zuggeschirre im belüfteten Seitenkasten","The circus wagon stores harnesses in a ventilated side compartment","Wo lagert der Zirkuswagen Zuggeschirre?","Where are harnesses stored in the circus wagon?"],
 ["Die Wasserrettung markiert Strömungsrinnen mit gelben Bojen","The water rescue team marks current channels with yellow buoys","Wie markiert die Wasserrettung Strömungsrinnen?","How does water rescue mark current channels?"],
 ["Das Konservatorium vergibt Übungsräume über ein Losverfahren","The conservatory allocates rehearsal rooms by lottery","Wie vergibt das Konservatorium Übungsräume?","How does the conservatory allocate rehearsal rooms?"],
 ["Der Parkscheinautomat akzeptiert Kupfermünzen nur im Sammelfach","The parking meter accepts copper coins only in the collection tray","Wo akzeptiert der Parkscheinautomat Kupfermünzen?","Where does the parking meter accept copper coins?"],
 ["Das Planetarium projiziert Sternbilder mit getrennten Glasdias","The planetarium projects constellations using separate glass slides","Wie projiziert das Planetarium Sternbilder?","How does the planetarium project constellations?"],
 ["Die Tischlerei lagert Furnierblätter zwischen Filzplatten","The joinery stores veneer sheets between felt boards","Wo lagert die Tischlerei Furnierblätter?","Where does the joinery store veneer sheets?"],
 ["Die Schleusenwärterin prüft Torverriegelungen vor dem Fluten","The lock keeper checks gate latches before flooding","Wann prüft die Schleusenwärterin Torverriegelungen?","When does the lock keeper check gate latches?"],
 ["Der Luftballonverkäufer verwendet Heliumventile mit Rückschlagsicherung","The balloon vendor uses helium valves with backflow protection","Welche Heliumventile nutzt der Luftballonverkäufer?","Which helium valves does the balloon vendor use?"],
 ["Die Porzellanmanufaktur stempelt Seriennummern vor dem Glasieren","The porcelain factory stamps serial numbers before glazing","Wann stempelt die Porzellanmanufaktur Seriennummern?","When does the porcelain factory stamp serial numbers?"],
 ["Der Kranführer bekommt Anschlagpläne vom Baustellenkoordinator","The crane operator receives rigging plans from the site coordinator","Woher bekommt der Kranführer Anschlagpläne?","Who gives the crane operator rigging plans?"],
 ["Die Stiftsbibliothek schützt Pergamentrollen mit Baumwollhüllen","The monastic library protects parchment rolls with cotton sleeves","Wie schützt die Stiftsbibliothek Pergamentrollen?","How does the monastic library protect parchment rolls?"],
 ["Die Blindenwerkstatt verpackt Bürstenwaren in tastbar beschriftete Kartons","The sheltered workshop packs brushware in tactile labelled cartons","Wie verpackt die Blindenwerkstatt Bürstenwaren?","How does the sheltered workshop pack brushware?"],
 ["Die Straßenreinigung kehrt Kopfsteinpflaster mit weichen Walzen","The street cleaning crew sweeps cobblestones with soft rollers","Wie kehrt die Straßenreinigung Kopfsteinpflaster?","How does street cleaning sweep cobblestones?"],
 ["Die Imkergenossenschaft lagert Honigwaben im lichtdichten Kühlraum","The beekeeping cooperative stores honeycombs in a lightproof coldroom","Wo lagert die Imkergenossenschaft Honigwaben?","Where does the beekeeping cooperative store honeycombs?"],
 ["Die Ballonfahrt startet nach einer schriftlichen Windfreigabe","The balloon flight starts after written wind clearance","Wann startet die Ballonfahrt nach Windfreigabe?","Does the balloon flight need wind clearance?"],
 ["Der Trachtenverein reinigt Filzhüte mit einer Rosshaarbürste","The costume association cleans felt hats with a horsehair brush","Wie reinigt der Trachtenverein Filzhüte?","How does the costume association clean felt hats?"],
 ["Die Druckluftanlage entwässert Kondensat täglich am Tiefpunkt","The compressed air plant drains condensate daily at the lowest point","Wo entwässert die Druckluftanlage Kondensat?","Where does the compressed air plant drain condensate?"],
 ["Die Gepäckförderanlage sortiert Übergrößen auf ein getrenntes Rollenband","The baggage conveyor sorts oversized luggage onto a separate roller belt","Wie sortiert die Gepäckförderanlage Übergrößen?","How does the baggage conveyor handle oversized luggage?"],
 ["Das Hörgerät speichert Lautstärkeprofile für verschiedene Gesprächssituationen","The hearing aid stores volume profiles for different conversation settings","Welche Lautstärkeprofile speichert das Hörgerät?","What volume profiles does the hearing aid store?"],
 ["Die Leuchtturmwärterin prüft Fresnellinsen jeden Sonnenuntergang","The lighthouse keeper checks Fresnel lenses at every sunset","Wann prüft die Leuchtturmwärterin Fresnellinsen?","When does the lighthouse keeper check Fresnel lenses?"],
 ["Die Blumenbinderei befestigt Trockenblüten mit Floristendraht","The flower workshop secures dried blossoms with florist wire","Wie befestigt die Blumenbinderei Trockenblüten?","How does the flower workshop secure dried blossoms?"],
 ["Die Fechtgruppe lagert Degenmasken getrennt von verschwitzten Jacken","The fencing group stores epee masks separately from sweaty jackets","Wo lagert die Fechtgruppe Degenmasken?","How does the fencing group store epee masks?"],
 ["Der Schornsteinfeger dokumentiert Rußablagerungen mit einer Inspektionskamera","The chimney sweep documents soot deposits with an inspection camera","Wie dokumentiert der Schornsteinfeger Rußablagerungen?","How does the chimney sweep document soot deposits?"],
 ["Die Funkleitstelle führt Gesprächsprotokolle mit durchlaufenden Zeitmarken","The radio control centre keeps conversation records with continuous timestamps","Wie führt die Funkleitstelle Gesprächsprotokolle?","How does the radio control centre keep conversation records?"],
 ["Der Schweißbetrieb lagert Argonflaschen aufrecht mit Schutzkappen","The welding company stores argon cylinders upright with protective caps","Wie lagert der Schweißbetrieb Argonflaschen?","How does the welding company store argon cylinders?"],
 ["Die Bergrettung überprüft Steigeisen vor jeder Winterübung","The mountain rescue team checks crampons before every winter exercise","Wann überprüft die Bergrettung Steigeisen?","When does mountain rescue check crampons?"],
 ["Die Gebärdensprachschule verwendet Wandspiegel zur Haltungskontrolle","The sign language school uses wall mirrors for posture checks","Wozu verwendet die Gebärdensprachschule Wandspiegel?","What wall mirrors does the sign language school use?"],
 ["Der Münzprüfer vermisst Riffelränder unter einem Messprojektor","The coin examiner measures reeded edges under a measuring projector","Wie vermisst der Münzprüfer Riffelränder?","How does the coin examiner measure reeded edges?"],
 ["Die Reisekofferwerkstatt ersetzt Zahlenschlösser nach Eigentumsnachweis","The suitcase workshop replaces combination locks after ownership proof","Wann ersetzt die Reisekofferwerkstatt Zahlenschlösser?","When does the suitcase workshop replace combination locks?"],
 ["Die Zollabfertigung versieht Frachtplomben mit fortlaufenden Prüfnummern","The customs clearance office labels cargo seals with consecutive check numbers","Wie kennzeichnet die Zollabfertigung Frachtplomben?","How does customs clearance label cargo seals?"],
 ["Das Korbflechtatelier weicht Weidenruten vor dem Flechten ein","The basket weaving atelier soaks willow rods before weaving","Wann weicht das Korbflechtatelier Weidenruten ein?","When does basket weaving soak willow rods?"],
 ["Die Kartenmanufaktur trocknet Büttenpapier auf einem Drahtgitter","The card factory dries handmade paper on a wire mesh","Wo trocknet die Kartenmanufaktur Büttenpapier?","Where does the card factory dry handmade paper?"],
 ["Die Sportorthopädie passt Knieorthesen im stehenden Zustand an","The sports orthopaedics clinic fits knee braces while standing","Wie passt die Sportorthopädie Knieorthesen an?","How does sports orthopaedics fit knee braces?"],
];
const UNRELATED = ["Please write three unit tests for the new discount calculation","Erkläre mir die Zusammensetzung von Sonnenplasma","Bitte berechne die Entfernung zwischen zwei Galaxien","Which planets have rings around them","Translate my birthday invitation into Italian","Ich möchte heute Pizza bestellen","Bitte erstelle eine Einkaufsliste für morgen","Who discovered the periodic table","How many sides does a regular hexagon have","Erzähle mir eine Geschichte über einen Drachen","Please correct the spelling in this paragraph","Kannst du meine Einladung freundlicher schreiben","Explain the difference between nouns and verbs","What does a quadratic equation look like","Warum ist der Himmel blau","Wie funktioniert ein Regenbogen","Bitte ändere die Überschrift meiner Nachricht","Can you shorten my email to three sentences","Wie addiere ich zwei Brüche","Was bedeutet die römische Zahl XV","Please continue with the next task","Nein ich hatte etwas anderes gemeint","Das passt so mach bitte weiter","Tell me a joke about a penguin","Was bedeutet Photosynthese"];
const SHORT = ["bitte so lassen","nein das nicht","mach bitte weiter","das ist gut","ich will das","wie gesagt bitte","bitte denk daran","ja genau so","das stimmt nicht","kannst du das","please continue","that is fine","I want that","no not that","as I said","please remember","keep it short","change it please","yes that works","do it again","okay then","is that right","tell me more","and what now","leave it there"];
export function independentDraftCorpus(now=Date.now()) {
 const rows:Draft[]=[],topicOf=new Map<string,string>(),queries:{text:string;kind:"topical"|"unrelated"|"short";topic?:string}[]=[];
 FACTS.forEach(([de,en,dq,eq],topic)=>{
  const key=String(topic);
  for(const [language,fact] of [["de",de],["en",en]]) for(const prefix of ["",language==="de"?"Merke für später: ":"Remember for later: "]) {
   const quote=prefix+fact,fp=draftFingerprint(quote),session=`independent-${topic}-${language}-${prefix.length}`;
   const draft:Draft={id:draftId(session,0,fp),fp,quote,kind:"typed",evidence:[{session_id:session,turn:0,ts:now}],created:now,last_touched:now,surfaced:[],state:"open",situation:{before:[],after:[],reads:[],lits:[]}};
   rows.push(draft);topicOf.set(draft.id,key);
  }
  queries.push({text:dq,kind:"topical",topic:key},{text:eq,kind:"topical",topic:key});
 });
 for(const suffix of [""," Please explain briefly."]) {
  for(const text of UNRELATED)queries.push({text:text+suffix,kind:"unrelated"});
  for(const text of SHORT)queries.push({text:text+suffix,kind:"short"});
 }
 return {rows,topicOf,queries};
}
