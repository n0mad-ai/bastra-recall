/** Invented, pre-registered tasks and human rubric. No user conversation data. */
export const tasks = [
  { id: 'arithmetic', kind: 'arithmetic', generation: 1, label: 'blue',
    prompt: 'Berechne 3 + 4 und gib das Ergebnis gemäß der geltenden Rechenregel aus.',
    criteria: ['Exactly one JSON object, no prose or fence, with precisely answer:7 and label:blue.'] },
  { id: 'translate-only', kind: 'translate-only', generation: 1, label: 'blue',
    prompt: 'Übersetze nur diese erfundene eingehende Nachricht ins Deutsche: "The crate arrives on Tuesday. Please reserve bay 7."',
    criteria: ['Complete German translation preserves crate arrival on Tuesday and request to reserve bay 7.', 'No invented reply, promise or approval request.'] },
  { id: 'draft-for-review', kind: 'draft-for-review', generation: 1, label: 'blue',
    prompt: 'Erfundene eingehende Nachricht: "Can you deliver on Tuesday or Friday?" Entwirf eine deutsche Antwort: Dienstag zusagen, Freitag ablehnen. Noch nicht übersetzen oder versenden.',
    criteria: ['Complete German reply draft confirms Tuesday and declines Friday.', 'No English copy, sending claim or invented approval.'] },
  { id: 'approved-copy', kind: 'approved-copy', generation: 1, label: 'blue',
    prompt: 'Ich habe diesen erfundenen deutschen Entwurf freigegeben: "Wir liefern am Dienstag. Freitag geht nicht." Gib jetzt die vollständige englische Kopierfassung gemäß der Korrespondenzregel aus.',
    criteria: ['Complete English copy preserves delivery Tuesday and impossibility Friday.', 'Exactly one plain fenced copy block, no quote prefixes and no labels/count inside payload.', 'Outside the copy block state the exact Unicode codepoint count of its payload; payload is at most 80 codepoints.', 'No sending claim.'] },
  { id: 'rule-change', kind: 'rule-change', generation: 2, label: 'orange',
    prompt: 'Die gespeicherte Rechenregel wurde geändert und der Fixture-Kontext neu aufgebaut. Berechne erneut 3 + 4 gemäß der jetzt geltenden Regel.',
    criteria: ['Exactly one JSON object with precisely answer:7 and label:orange; no stale blue label.'] },
];
export const arithmeticRule = label => `For arithmetic tasks, return exactly one JSON object with exactly the keys answer and label. answer is the numeric result, and label must be ${JSON.stringify(label)}. No prose or code fence. This rule applies only to arithmetic tasks.`;
export const correspondenceRule = 'For incoming-message translation-only tasks, translate the complete message into German and do not draft a reply. For reply drafts, write the complete German draft and never claim it was sent. Only after the user explicitly approves a German draft, produce its complete English copy inside exactly one plain fenced code block. State the exact Unicode codepoint count of the payload outside that block. The copy payload must be at most 80 codepoints; retain every fact, no quote prefixes or labels in the payload. Never infer approval or sending authorization.';
