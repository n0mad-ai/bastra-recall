---
id: tests-vor-dem-commit-laufen-lassen
title: "Tests vor dem Commit laufen lassen, nicht danach"
type: lesson
summary: "Ein roter Test nach dem Commit kostet einen zweiten Commit und macht die Historie unlesbar; der Lauf davor kostet eine Minute."
topic_path: [entwicklung, qualitaet]
tags: [testing, commit, qualitaet]
scope: all-projects
recall_when:
  - bevor ich committe
  - wann soll ich die tests laufen lassen
  - typescript testing vor dem Einchecken
related: []
related_via: []
sensitivity: public
source: "synthetische Testvorlage, gemischter Stil"
confidence: 0.85
created: 2026-01-01
updated: 2026-01-01
---

Ein Commit, der die Suite bricht, wird fast immer von einem zweiten Commit
gefolgt, der ihn repariert. Zwei Einträge für eine Änderung, und die Historie
erzählt eine Geschichte, die niemand lesen will.
