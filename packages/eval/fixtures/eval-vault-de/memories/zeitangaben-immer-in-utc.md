---
id: zeitangaben-immer-in-utc
title: "Zeitangaben immer in UTC speichern"
type: lesson
summary: "Gespeicherte Ortszeiten werden mehrdeutig, sobald die Zeitumstellung dazwischenkommt; gespeichert wird UTC, umgerechnet wird erst bei der Anzeige."
topic_path: [datenmodell, zeit]
tags: [zeit, zeitzone, datenmodell]
scope: all-projects
recall_when:
  - wenn ich einen Zeitstempel ablege
  - welche Zeitzone gehört in die Datenbank
  - bei der Umstellung auf Sommerzeit
related: []
related_via: []
sensitivity: public
source: "synthetische Testvorlage, nicht-englischer Vault"
confidence: 0.85
created: 2026-01-01
updated: 2026-01-01
---

Eine Ortszeit ohne Zone ist zweimal im Jahr nicht eindeutig. Wer UTC ablegt,
verschiebt das Problem an die einzige Stelle, an der es hingehört: die Anzeige.
