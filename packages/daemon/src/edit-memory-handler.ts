/**
 * #519 — `edit_memory`: eine TEILÄNDERUNG an einem bestehenden Memory, die
 * durch denselben Save-Pfad läuft wie ein vollständiges `save_memory`.
 *
 * ## Warum es das gibt
 *
 * Wer bisher eine Zeile an ein bestehendes Memory anhängen wollte, musste
 * `save_memory(overwrite: true)` rufen und dabei den KOMPLETTEN Body plus alle
 * Pflichtfelder neu schicken. Für einen Einzeiler an einem 20-KB-Memory ist
 * das teuer und riskant — jedes neu abgetippte Zeichen kann bestehenden Inhalt
 * beschädigen. Also nahmen Agenten die Abkürzung und editierten die `.md`-Datei
 * im Vault direkt (beobachtet am 11.09.2026). Ein Direkt-Edit umgeht ALLES, was
 * der Save-Pfad garantiert:
 *
 *   - den Audit-Eintrag (`audit-log.ndjson`) — die Änderung ist hinterher von
 *     niemandem mehr rekonstruierbar;
 *   - den `updated`-Stempel (musste von Hand gesetzt werden);
 *   - den id-Lock und das atomare temp+rename (ein direkter Write kollidiert
 *     mit Watcher, Cloud-Sync und parallelen Writern);
 *   - die Index-Aktualisierung über den Save-Pfad statt über den Datei-Watcher,
 *     der auf dem Google-Drive-Vault bekanntermaßen unzuverlässig ist;
 *   - und die Sensitivitäts-/Identitätsgrenze: ein Dateipfad beweist nicht,
 *     welches Memory dort liegt, und ein Editor fragt nicht, ob der Caller
 *     `sensitivity: private` überhaupt sehen darf.
 *
 * Solange der richtige Weg teurer ist als der falsche, nehmen Agenten den
 * falschen. Dieses Tool macht den richtigen Weg zum billigsten.
 *
 * ## Was es NICHT tut
 *
 * Es ist ausdrücklich kein zweiter Save-Pfad. `id`, `scope`, `type`,
 * `write_origin`, `sensitivity`, die Valenzfelder und jede Ortsveränderung
 * bleiben `save_memory` bzw. den eigenen Tools vorbehalten — deshalb ist der
 * Frontmatter-Patch eine `.strict()`-Whitelist: ein nicht aufgeführtes Feld
 * wird LAUT abgelehnt, nicht still verworfen.
 *
 * ## Wo die Schreibgarantien herkommen
 *
 * Alle aus `mutateMemoryFile` (`packages/core/src/memory-mutate.ts`), genau wie
 * beim Conflict-Marking (`conflict-marking.ts`): id-Lock über dieselbe
 * ID-Transaktion wie `saveMemory`, Identitätsprüfung gegen die Bytes auf der
 * Platte, atomares temp+rename und der Vergleich vor dem Commit (`raced`).
 * Nichts Drittes.
 *
 * Und: Der Patch wird auf DIE BYTES angewandt, die unter dem Claim gelesen
 * wurden. Ein `old_str`, das dort fehlt oder mehrdeutig ist, wirft aus dem
 * Mutations-Callback heraus — also bevor auch nur eine Tempdatei entsteht.
 * Ein nicht zutreffendes Suchmuster schreibt deshalb NICHTS und sagt warum,
 * statt still zu tun, als wäre etwas passiert.
 */
import { z } from "zod";
import {
  AUTO_RELATED_START,
  memoryRevision,
  mutateMemoryFile,
  type Memory,
  type SaveMemoryInput,
} from "@bastra-recall/core";
import { recordAudit } from "./audit-trail.js";
import { claimGateResult, unansweredClaims, GENERATED_TRIGGER_TYPES, type ClaimGateResult } from "./claim-gate.js";
import { hiddenFromCaller, type PrivateAccess } from "./private-access.js";
import { scoreSaveQuality, type SaveQualityResult } from "./save-quality.js";
import type { ToolDeps } from "./tool-deps.js";

/**
 * Der Frontmatter-Patch — eine geschlossene Whitelist.
 *
 * `.strict()` ist hier die eigentliche Sicherung: Zod verwirft unbekannte
 * Felder sonst STILL, und ein `scope: "anderes-regal"` im Patch sähe für den
 * Caller nach Erfolg aus, während nichts davon passiert ist. Ein Feld, das
 * dieses Tool nicht ändern darf, muss der Caller als Fehler zurückbekommen.
 */
const FrontmatterPatch = z
  .object({
    summary: z.string().min(1).optional(),
    recall_when: z.array(z.string().min(1)).min(1).optional(),
    tags: z.array(z.string().min(1)).min(1).optional(),
    issues: z.array(z.string()).optional(),
    related: z.array(z.string()).optional(),
    confidence: z.number().min(0).max(1).optional(),
    valid_until: z.string().min(1).optional(),
  })
  .strict();

export const EditMemoryArgs = z
  .object({
    id: z.string().min(1),
    /** `old_str` muss im authored body GENAU EINMAL vorkommen. */
    str_replace: z
      .object({ old_str: z.string().min(1), new_str: z.string() })
      .strict()
      .optional(),
    /** Text ans Ende des authored body — nie in den Auto-Related-Block. */
    append: z.string().min(1).optional(),
    frontmatter: FrontmatterPatch.optional(),
    /**
     * Optimistische Nebenläufigkeit: die `revision`, die `load_memory` beim
     * Laden geliefert hat. Steht auf der Platte etwas anderes, wird nichts
     * geschrieben. Weglassen heißt „ich nehme den aktuellen Stand".
     *
     * #519: Hier stand der `updated`-Stempel, und der hat Tagesgenauigkeit —
     * zwei Änderungen am selben Tag teilen ihn sich, also hielt die
     * Vorbedingung genau den Fall NICHT, für den es sie gibt. Nachgestellt:
     * `updated: 2026-09-12` geladen, ein Tags-Patch damit angewandt, dann ein
     * zweiter veralteter Tags-Patch mit demselben Wert — beide erfolgreich,
     * `["first"]` wurde still `["second"]`. Die Revision ist ein Digest über
     * die Bytes der Datei: sie ändert sich bei jedem Schreibvorgang und auch
     * dann, wenn jemand die Datei in Obsidian von Hand editiert.
     */
    expected_revision: z.string().min(1).optional(),
  })
  .refine(
    (a) => a.str_replace !== undefined || a.append !== undefined || a.frontmatter !== undefined,
    { message: "edit_memory needs at least one of str_replace, append or frontmatter" },
  );
export type EditMemoryArgs = z.infer<typeof EditMemoryArgs>;

export interface EditMemoryResult {
  id: string;
  file_path: string;
  /** Immer `false` — eine Teiländerung erschafft nichts. */
  created: false;
  /** Der neu gestempelte `updated`-Wert. */
  updated: string;
  /** #519: die Revision NACH diesem Edit — als `expected_revision` des
   *  nächsten Edits verwendbar, ohne neu zu laden. */
  revision: string;
  /** Welche Operationen gelaufen sind — `["str_replace", "frontmatter"]`. */
  operations: string[];
  save_quality: SaveQualityResult;
  note: string;
  warning?: string;
}

/**
 * Eine Vorbedingung des Edits traf nicht zu — nichts wurde geschrieben.
 *
 * Eigener Typ, weil diese Fehler AUS dem Mutations-Callback fliegen, also aus
 * der Tiefe von `mutateMemoryFile`. Ohne ihn wäre an der Aufrufstelle nicht zu
 * unterscheiden, ob der Patch nicht passte oder ob das Schreiben selbst kaputt
 * ging — und nur beim Ersten ist „nichts geschrieben" garantiert.
 */
class EditPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditPreconditionError";
  }
}

/**
 * Body in den vom Menschen geschriebenen Teil und den maschinell angehängten
 * Auto-Related-Block trennen.
 *
 * Beide Body-Operationen fassen ausschließlich den `head` an: Ein `append`
 * landet VOR dem Block (sonst stünde der Nachtrag mitten in einer generierten
 * Wikilink-Liste, die der nächste Background-Pass neu schreibt und damit den
 * Text wieder verlöre), und ein `str_replace` kann eine generierte Kante nicht
 * treffen.
 */
export function splitAuthoredBody(body: string): { head: string; tail: string } {
  const idx = body.indexOf(AUTO_RELATED_START);
  if (idx === -1) return { head: body, tail: "" };
  const lineStart = body.lastIndexOf("\n", idx) + 1;
  return { head: body.slice(0, lineStart), tail: body.slice(lineStart) };
}

/** Alle Vorkommen zählen — `String.split` ist hier der einzige Weg, der auch
 *  bei überlappungsfreien Mehrzeilern stimmt und keine Regex-Escapes braucht. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Die Body-Operationen auf einen konkreten Body anwenden.
 *
 * Exportiert, weil dieselbe Funktion ZWEIMAL läuft: einmal auf dem indexierten
 * Body für die Vorschau (Qualität und Claim-Gate brauchen den Text, den der
 * Edit erzeugen WÜRDE), und einmal verbindlich unter dem id-Claim auf den
 * Bytes von der Platte. Geschrieben wird nur, was der zweite Lauf ergibt.
 */
export function applyBodyOps(body: string, args: EditMemoryArgs): string {
  const { head, tail } = splitAuthoredBody(body);
  let next = head;

  if (args.str_replace) {
    const { old_str, new_str } = args.str_replace;
    const hits = countOccurrences(next, old_str);
    if (hits === 0) {
      throw new EditPreconditionError(
        `str_replace: old_str does not occur in the body of '${args.id}' — NOTHING was written. ` +
          `Load the memory and copy the exact text you want to replace (whitespace and line breaks included).`,
      );
    }
    if (hits > 1) {
      throw new EditPreconditionError(
        `str_replace: old_str occurs ${hits} times in the body of '${args.id}' — NOTHING was written. ` +
          `Extend it with surrounding lines until it is unique.`,
      );
    }
    next = next.replace(old_str, () => new_str);
  }

  if (args.append !== undefined) {
    next = `${next.replace(/\s*$/, "")}\n\n${args.append.replace(/\s*$/, "")}\n`;
  }

  return tail === "" ? next : `${next.replace(/\s*$/, "")}\n\n${tail}`;
}

/**
 * Die Eingabe, die ein gleichwertiges `save_memory` gehabt HÄTTE.
 *
 * Qualitätsprüfung und Claim-Gate sind auf `SaveMemoryInput` geschrieben, und
 * genau das ist der Punkt: Eine Teiländerung wird nach denselben Maßstäben
 * beurteilt wie ein voller Save, nicht nach eigenen.
 */
function asSaveInput(mem: Memory, body: string, patch: EditMemoryArgs["frontmatter"]): SaveMemoryInput {
  return {
    id: mem.fm.id,
    title: mem.fm.title,
    type: mem.fm.type,
    summary: patch?.summary ?? mem.fm.summary,
    body,
    topic_path: mem.fm.topic_path,
    tags: patch?.tags ?? mem.fm.tags,
    scope: mem.fm.scope,
    recall_when: patch?.recall_when ?? mem.fm.recall_when,
    // Die Quittungen, die dieses Memory schon trägt — ohne sie fragte das Gate
    // nach Paaren, für die der Agent längst geantwortet hat.
    ...(mem.fm.replaces ? { replaces: mem.fm.replaces } : {}),
    ...(mem.fm.siblings?.length ? { sibling_of: mem.fm.siblings } : {}),
    overwrite: true,
  } as SaveMemoryInput;
}

export async function editMemoryHandler(
  deps: ToolDeps,
  rawArgs: unknown,
  /** #464: transportgebunden — siehe `private-access.ts`. Die beiden
   *  öffentlichen Transporte (REST-Dispatcher, stdio-MCP-Server) übergeben
   *  NICHTS, und das Fehlen ist die sichere Antwort. */
  access?: PrivateAccess,
): Promise<EditMemoryResult | ClaimGateResult> {
  // #519: Der alte Feldname wird LAUT abgelehnt statt still verworfen. Wer ihn
  // schickt, will genau die Absicherung, die Zod ihm sonst kommentarlos
  // wegnähme — und bekäme dann die verlorene Änderung, gegen die er sich
  // absichern wollte.
  if (typeof rawArgs === "object" && rawArgs !== null && "expected_updated" in rawArgs) {
    throw new Error(
      `invalid edit_memory args: expected_updated is gone — it compared the day-precision ` +
        `\`updated\` stamp, so two edits on the same day shared it and the later one silently won. ` +
        `Pass expected_revision with the \`revision\` load_memory returned instead.`,
    );
  }
  const parsed = EditMemoryArgs.safeParse(rawArgs);
  if (!parsed.success) {
    throw new Error(`invalid edit_memory args: ${parsed.error.issues.map((i) => i.message).join(", ")}`);
  }
  const args = parsed.data;
  const mem = deps.vault.get(args.id);
  // #464: DIESELBE Grenze wie `save_memory(overwrite)` und `load_memory` —
  // eine Teiländerung ist ein Schreibpfad auf einen Datensatz, den der Caller
  // womöglich nicht einmal lesen darf. Wortgleich mit dem Lesepfad, damit eine
  // abgelehnte Änderung nicht verrät, dass die Id existiert. `hiddenFromCaller`
  // ersetzt NUR die Sensitivitätsprüfung, nie die Existenzprüfung.
  if (!mem || hiddenFromCaller(access, mem.fm)) {
    throw new Error(`memory not found: ${args.id}`);
  }

  // ── Vorschau: was dieser Edit ergäbe ─────────────────────────────
  // Auf dem INDEXIERTEN Body, also möglicherweise nicht taufrisch. Das ist für
  // Beratung und Gate genau richtig und für den Schreibvorgang irrelevant:
  // verbindlich ist der zweite Lauf unten, auf den Bytes unter dem Claim.
  const previewBody = applyBodyOps(mem.body, args);
  const preview = asSaveInput(mem, previewBody, args.frontmatter);
  const saveQuality = scoreSaveQuality(deps, preview, mem.fm.id);

  // #360: das Claim-Gate — aber nur für NEU hinzukommende Trigger.
  //
  // Ein voller `save_memory(overwrite)` läuft gar nicht durch das Gate („ein
  // overwrite benennt sein Ziel, und das ist selbst eine Antwort"). Ein Edit,
  // der `recall_when` unverändert lässt, darf deshalb erst recht nicht gehalten
  // werden. Neue Trigger sind aber eine neue Behauptung über eine Situation,
  // und genau die ist die Frage, die das Gate stellt.
  const declaredBefore = new Set(mem.fm.recall_when);
  const addedTriggers = (args.frontmatter?.recall_when ?? []).filter((t) => !declaredBefore.has(t));
  if (addedTriggers.length > 0 && !GENERATED_TRIGGER_TYPES.has(mem.fm.type)) {
    const claimed = unansweredClaims(
      preview,
      saveQuality,
      (id) => {
        const m = deps.vault.get(id);
        return m ? { summary: m.fm.summary, body: m.body } : undefined;
      },
      (start) => chainBelow(deps, start),
    ).filter((c) => addedTriggers.includes(c.trigger));
    if (claimed.length > 0) return claimGateResult(mem.fm.id, claimed, saveQuality);
  }

  // ── Der verbindliche Schreibvorgang ──────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  // Die Größen, die WIRKLICH geschrieben wurden. Sie aus der Vorschau zu
  // nehmen wäre falsch, sobald der Index nicht taufrisch ist — und dann stünde
  // im Beleg eine Zahl, die zu keiner Fassung dieser Datei gehört.
  let bodyBefore = 0;
  let bodyAfter = 0;
  const outcome = await mutateMemoryFile(
    mem.filePath,
    mem.fm.id,
    {
      // #519: auf den BYTES, nicht auf einem Feld. Der `updated`-Stempel, der
      // hier stand, hat Tagesgenauigkeit — zwei Edits am selben Tag teilen ihn
      // sich, und der zweite ersetzte den ersten still. Die Revision ändert
      // sich bei jedem Schreibvorgang, auch bei einem fremden.
      precondition: (raw) => {
        if (args.expected_revision === undefined) return;
        const onDisk = memoryRevision(raw);
        if (onDisk !== args.expected_revision) {
          throw new EditPreconditionError(
            `expected_revision: '${mem.fm.id}' is at revision ${onDisk}, ` +
              `you expected ${args.expected_revision} — NOTHING was written. ` +
              `Load the memory again and re-apply your change to the current text.`,
          );
        }
      },
      frontmatter: (fm) => {
        // `write_origin`, `sensitivity`, Valenz, `created` und alles andere
        // bleiben unangetastet: gepatcht wird über den Bestand, nicht neu
        // gebaut. Das ist der ganze Unterschied zum vollen Save.
        return { ...fm, ...(args.frontmatter ?? {}), updated: today };
      },
      body: (body) => {
        const next = applyBodyOps(body, args);
        bodyBefore = body.length;
        bodyAfter = next.length;
        return next;
      },
    },
    { vaultRoot: deps.vaultPath, op: "save_memory_edit" },
  );

  if (outcome.kind === "identity-mismatch") {
    throw new Error(
      `edit_memory: ${mem.filePath} does not hold memory '${mem.fm.id}' ` +
        `(found ${outcome.found ?? "no memory"}) — NOTHING was written. The index is stale; recall the memory again.`,
    );
  }
  if (outcome.kind === "raced") {
    throw new Error(
      `edit_memory: '${mem.fm.id}' changed while the edit was being written — NOTHING was written. ` +
        `Load it again and re-apply your change to the current text.`,
    );
  }
  if (outcome.kind !== "written") {
    // Erreichbar nur, wenn der Frontmatter-Callback `null` zurückgäbe — tut er
    // nie. Ein Beleg wird ausschließlich aus einem WRITTEN gebildet; etwas
    // anderes zu protokollieren wäre ein Audit-Eintrag über einen
    // Schreibvorgang, den es nicht gab.
    throw new Error(`edit_memory: '${mem.fm.id}' reported '${outcome.kind}' — nothing was modified.`);
  }

  // Dem Watcher auf Cloud-Mounts nicht trauen — der Index wird über den
  // Schreibpfad aktualisiert, genau wie beim Save.
  await deps.vault.reindexFile(mem.filePath);

  const operations = [
    ...(args.str_replace ? ["str_replace"] : []),
    ...(args.append !== undefined ? ["append"] : []),
    ...(args.frontmatter ? ["frontmatter"] : []),
  ];
  // Der Beleg. `operation: "update"`, weil `AuditOperation` eine geschlossene
  // Menge ist und eine Teiländerung nichts anderes ist als eine Änderung; WAS
  // geändert wurde, trägt `reason` — inklusive der Body-Größe vorher/nachher,
  // damit ein Frontmatter-Diff, der bei einem reinen Body-Edit nur `updated`
  // zeigt, nicht die einzige Spur ist. Vor- und Nachbild kommen aus der
  // Mutation selbst, gelesen unter demselben Claim aus denselben Bytes.
  const auditWarning = await recordAudit({
    vaultRoot: deps.vaultPath,
    memoryId: mem.fm.id,
    operation: "update",
    actor: "assistant",
    actorDetail: "mcp:edit_memory",
    diffBefore: outcome.before,
    diffAfter: outcome.after,
    filePath: mem.filePath,
    reason: `edit_memory: ${operations.join(" + ")} (body ${bodyBefore} → ${bodyAfter} chars)`,
    sessionId: deps.telemetry.runId(),
  });

  return {
    id: mem.fm.id,
    file_path: mem.filePath,
    created: false,
    updated: today,
    revision: outcome.revision,
    operations,
    save_quality: saveQuality,
    note: "Edit complete — do not repeat this edit_memory call.",
    ...(auditWarning ? { warning: auditWarning } : {}),
  };
}

/** Die Versionskette unter `start`, `start` selbst eingeschlossen — dieselbe
 *  Auskunft, die `saveMemoryInner` dem Gate gibt. Ohne sie hielte das Gate
 *  jedes neue Glied einer laufenden Kette gegen dessen Vorfahren. */
function chainBelow(deps: ToolDeps, start: string): Set<string> {
  const out = new Set<string>();
  let cursor: string | undefined = start;
  while (cursor !== undefined && !out.has(cursor)) {
    out.add(cursor);
    const predecessor: unknown = deps.vault.get(cursor)?.fm.replaces;
    cursor = typeof predecessor === "string" ? predecessor : undefined;
  }
  return out;
}
