/** Frozen invented language-practice vault: 150 short notes, 75 DE / 75 EN.
 * Topics differ from both draft corpora; everyday phrasing is represented by
 * complete prose, not an algorithmic stopword list. No draft-topic anchors are
 * deliberately taught to this vault. */
import { tokens } from "../../src/save-similarity.js";
import type { DraftNote } from "../../src/draft-search.js";
const THEMES = [
 ["Bruchrechnung","fraction arithmetic"], ["Wortarten","parts of speech"],
 ["Schachnotation","chess notation"], ["Kombinatorik","combinatorics"], ["Versmaß","poetic metre"],
];
const DE = [
 "Wenn ich THEMA übe, lese ich zuerst drei kurze Beispiele und schreibe danach meine Antwort auf.",
 "Bitte erkläre mir THEMA mit einfachen Worten und sag kurz, was der Unterschied zwischen den beiden Antworten ist.",
 "Ich will bei THEMA die Reihenfolge ändern und die nächste Aufgabe erst morgen machen.",
 "Wie gesagt bleibt die Aufgabe zu THEMA so; das hatte ich schon geprüft und möchte es nicht wieder ändern.",
 "Bitte denk bei THEMA daran, dass ich die neue Frage auf Deutsch beantworten will.",
 "Für THEMA fasse ich den langen Absatz in drei Sätzen zusammen und mache den Text kürzer und freundlicher.",
 "Die Überschrift zu THEMA soll größer sein, aber der Text darunter bleibt wie vorher.",
 "Ich habe dir zu THEMA schon gesagt, dass die Summe höher sein muss; bitte berechne sie noch einmal.",
 "Bei THEMA ist das gut so, mach bitte mit dem nächsten Schritt weiter und sag Bescheid, wenn es fertig ist.",
 "Nein, bei THEMA hatte ich etwas anderes gemeint; bitte fange noch einmal von vorne an.",
 "Im Unterricht zu THEMA werden kurze Tests mit drei Fragen geschrieben; die Lösung wird erst danach erklärt.",
 "Ich möchte für THEMA einen kurzen Brief schreiben und diesen anschließend ins Englische übersetzen.",
 "Beim Üben von THEMA frage ich, welche Antwort am schnellsten gefunden wurde und warum sie falsch war.",
 "Bitte erinnere mich an THEMA, denn ich muss die Aufgabe heute abholen und morgen die Ergebnisse erklären.",
 "Bei THEMA prüfen wir jeden neuen Absatz und ändern nur die falschen Wörter; das bleibt immer so.",
];
const EN = [
 "When I practise THEME I first read three short examples and then write down my answer.",
 "Please explain THEME in simple words and tell me briefly what the difference between both answers is.",
 "I want to change the order for THEME and do the next exercise tomorrow instead of today.",
 "As I said, the THEME exercise stays the same; I already checked it and do not want to change it again.",
 "Please remember that I want to answer the new THEME question in German before reading the English version.",
 "For THEME I summarise the long paragraph in three sentences and make the text shorter and friendlier.",
 "The headline for THEME should be bigger, but the text below it stays as it was before.",
 "I told you that the total for THEME has to be higher; please calculate it once more.",
 "That is fine for THEME, please continue with the next step and tell me when it is finished.",
 "No, I meant something different for THEME; please start again from the beginning.",
 "Language tests about THEME have three short questions; the answer is explained only afterwards.",
 "I want to write a short letter about THEME and then translate the paragraph into English.",
 "While practising THEME I ask which answer was found fastest and why the other answer was wrong.",
 "Please remind me about THEME because I pick up the exercise today and explain the results tomorrow.",
 "For THEME we check every new paragraph and change only incorrect words; the rule always stays the same.",
];
export function syntheticDraftLanguageVault() {
 const notes:DraftNote[]=[];
 for(const [de,en] of THEMES)for(const [language,theme,texts] of [["de",de,DE],["en",en,EN]] as const) {
  texts.forEach((text,index)=>notes.push({id:`language-${notes.length}`,title:`${theme}: ${index+1}`,body:text.replace(language==="de"?"THEMA":"THEME",theme)}));
 }
 const df=new Map<string,number>();
 for(const note of notes)for(const word of new Set(tokens([note.title,note.body].join("\n"))))df.set(word,(df.get(word)??0)+1);
 return {notes,vocabulary:{count:notes.length,df}};
}
