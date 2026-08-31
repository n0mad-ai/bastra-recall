---
id: migration-vorher-sichern
title: "Vor einer Schemaänderung eine Sicherung ziehen"
type: lesson
summary: "Eine Schemaänderung lässt sich selten sauber zurücknehmen; die Sicherung davor ist billiger als jeder Rettungsversuch danach."
topic_path: [datenbank, wartung]
tags: [datenbank, sicherung, schema]
scope: all-projects
recall_when:
  - bevor ich das Schema ändere
  - vor einer Wanderung der Datenbank
  - wenn Spalten umbenannt werden
related: []
related_via: []
sensitivity: public
source: "synthetische Testvorlage, nicht-englischer Vault"
confidence: 0.85
created: 2026-01-01
updated: 2026-01-01
---

Eine geänderte Spalte lässt sich zurückbenennen, verlorene Werte nicht. Die
Sicherung kostet Minuten, der Rettungsversuch einen Abend.
