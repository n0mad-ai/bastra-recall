---
id: deployment-rollback-fenster
title: "Rollback-Fenster vor dem Deployment festlegen"
type: lesson
summary: "Ein Deployment ohne vorher vereinbartes Rollback-Fenster zwingt im Fehlerfall zu einer Entscheidung unter Zeitdruck; das Fenster gehört vor den Start, nicht in die Störung."
topic_path: [betrieb, ausrollen]
tags: [deployment, rollback, betrieb]
scope: all-projects
recall_when:
  - bevor wir das Deployment starten
  - wenn das Ausrollen schiefgeht
  - wie lange können wir zurückrollen
related: []
related_via: []
sensitivity: public
source: "synthetische Testvorlage, nicht-englischer Vault"
confidence: 0.85
created: 2026-01-01
updated: 2026-01-01
---

Wer das Rollback-Fenster erst dann festlegt, wenn schon etwas kaputt ist, legt es
unter Druck fest. Die Frage lautet vorher: Wie lange dürfen wir zurück, ohne
Daten zu verlieren, und wer entscheidet das? Beides gehört in die Absprache vor
dem Start.
