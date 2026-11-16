// Areas, Import and Onboarding dialogs (js/sections/dialogs.js), English.
export default {
  "dlg.close": "Close",
  "dlg.working": "working…",

  "ar.kicker": "VAULT · AREAS",
  "ar.title": "Vault areas",
  "ar.help":
    "The vault's top-level areas — projects and folders like people. Rename and delete move whole folders; memory ids (and their links) stay intact. Delete moves the area into the vault trash (.bastra/trash/areas/), nothing is destroyed. System areas are locked.",
  "ar.project": "project",
  "ar.folder": "folder",
  "ar.system": "SYSTEM",
  "ar.rename": "RENAME",
  "ar.delete": "DELETE",
  "ar.sure": "SURE? → TRASH",
  "ar.armed": 'Click again to move "{name}" into the vault trash.',
  "ar.placeholder": "new project area…",
  "ar.create": "CREATE",
  "ar.created": "✓ created {name} — it appears on the map with its first memory",
  "ar.renamed": "✓ renamed {from} → {to}",
  "ar.deleted": "✓ {name} moved to trash",
  "ar.empty": "No areas yet.",
  "ar.count": "{n} areas",

  "im.kicker": "VAULT · IMPORT",
  "im.title": "Import memories",
  "im.help":
    "Paste a memory list from another AI tool — one fact per line. Candidates are staged for review in import-review.md; your next AI session distills accepted ones with you. Nothing is saved without your accept.",
  "im.hint.chatgpt":
    "ChatGPT: Settings → Personalization → Manage memories — copy the list and paste it here. Full chat history (conversations.json)? Run bastra import <file> in a terminal instead.",
  "im.hint.claude":
    "Claude: Settings → Memory — copy your memory text and paste it here. Full chat history (conversations.json)? Run bastra import <file> in a terminal instead.",
  "im.hint.gemini": "Gemini: Settings → Saved Info — copy the entries and paste them here.",
  "im.hint.text": "Any plain list works — one fact per line, bullets and numbering are fine.",
  "im.src.text": "Text",
  "im.placeholder": "- Prefers concise replies without preamble\n- Works at a small AI startup in Berlin\n…",
  "im.choose": "…OR CHOOSE A FILE",
  "im.stage": "STAGE FOR REVIEW",
  "im.staging": "staging…",
  "im.staged": "✓ {n} staged",
  "im.dupes": " · {n} duplicate(s) skipped",
  "im.open": " · {n} open",
  "im.loaded": "loaded {name}",
  "im.own": "{name} is written by bastra itself — not an import source",
  "im.next":
    "✓ Staged in import-review.md — nothing is a memory yet. Next: open any AI session and say “work through my import review”; you accept or reject each candidate there. Closing this dialog is safe.",
  "im.waiting":
    "{n} staged candidate(s) wait for review — open any AI session and say “work through my import review”.",
  "im.folder": "Different thing: import a whole folder — direct, isolated, no review",
  "im.folderHelp":
    "Point at a folder of memory files — e.g. a Claude Code memory dir (~/.claude/projects/<repo>/memory). It's converted and imported into its own isolated set under memories/imported/; nothing existing is touched, and no per-item review is needed. Delete or re-import the whole set anytime.",
  "im.dir": "/path/to/a/memory/folder",
  "im.label": "label (optional)",
  "im.browse": "BROWSE…",
  "im.run": "IMPORT FOLDER",
  "im.use": "USE THIS FOLDER",
  "im.importing": "importing…",
  "im.imported": "✓ imported {n}/{m} into {folder}/",
  "im.skipped": " · {n} skipped",
  "im.orphaned": " · {n} orphaned (source gone, kept)",
  "im.md": "{n} md",

  "ob.kicker": "VAULT · ONBOARDING",
  "ob.title": "Make this vault yours",
  "ob.help":
    "Five minutes, a handful of questions — every answer becomes a memory your AI recalls from day one. Skip anything; refine later by simply telling your AI.",
  "ob.persona": "what will your memory mainly hold?",
  "ob.step": "{i} / {n}",
  "ob.optional": " · optional — empty skips it",
  "ob.never": "DON'T ASK AGAIN",
  "ob.later": "LATER",
  "ob.back": "‹ BACK",
  "ob.next": "NEXT",
  "ob.save": "SAVE PROFILE",
  "ob.saving": "SAVING…",
  "ob.done": "DONE",
  "ob.saved":
    "{n} profile memories saved — your AI knows you from the next session on. Refine anytime by simply telling it. Got memories in other AI tools? Import brings them in.",
};
