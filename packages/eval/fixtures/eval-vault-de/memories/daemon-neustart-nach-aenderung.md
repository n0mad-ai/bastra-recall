---
id: daemon-neustart-nach-aenderung
title: "Nach einer Änderung am Daemon neu starten"
type: lesson
summary: "Der Daemon lädt seinen Code beim Start; eine Änderung wirkt erst nach einem Neustart, und ein Test gegen den laufenden Prozess misst sonst den alten Stand."
topic_path: [betrieb, daemon]
tags: [daemon, neustart, betrieb]
scope: all-projects
recall_when:
  - nachdem ich am daemon etwas geändert habe
  - warum greift meine Änderung im daemon nicht
  - typescript im daemon neu gebaut
related: []
related_via: []
sensitivity: public
source: "synthetische Testvorlage, gemischter Stil"
confidence: 0.85
created: 2026-01-01
updated: 2026-01-01
---

Der laufende Prozess kennt nur den Stand, mit dem er gestartet ist. Wer nach
einer Änderung gegen ihn testet, misst den alten Code und sucht den Fehler an
der falschen Stelle.
