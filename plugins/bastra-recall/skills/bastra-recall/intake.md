# Intake adoption — imported memories earn their structure on use

*Read this when a recall hit comes from `memories/imported/`, right after a `bastra import vault`, or when an `<adoption-candidate>` block appears.*

Foreign memories imported via `bastra import vault` land in an isolated intake area (`memories/imported/<label>/`, scope = the import label, tag `imported`, `topic_path` starting with `imported`). They are findable, but carry only transcribed metadata — no real `recall_when`, no relations. The missing semantics get minted at the one moment they exist for free: **when the memory is actually used.**

- **Adopt on touch.** When an intake hit genuinely helps the current task, adopt it right then: `save_memory` a full-format version (real `type`, the scope it actually belongs to, `recall_when` built from the trigger that just fired, `[[links]]` to what it connects with, `source: "migrated:<original-id>"`), then `archive_memory({id: <original>, superseded_by: <new-id>})`. Max **one** adoption per turn — never interrupt the task for bulk work.
- **Pre-save duplicate check.** If the near-duplicate recall surfaces before a save is an intake memory, adopt-merge it instead of creating a parallel new memory next to an unadopted twin.
- **Guided import (companion mode).** Right after an import — or whenever the user wants to work through the intake — READ the actual bodies in tranches and adopt them together with the user. Never write adopted metadata for a body you did not read.
- **Bulk on request.** Only when the user explicitly asks, walk the whole intake queue in one sitting; same per-memory rules, user stays in the loop.
- **`<adoption-candidate>` blocks** injected at session start are the curator flagging intake memories with repeated use. Same flow, with the user's ok.

Originals go to the vault trash (recoverable, `superseded_by`-stamped), so every adoption stays auditable from both sides.

`archive_memory` is NOT a general delete: only intake originals you just adopted, or a memory the user explicitly retires.
