<div align="center">

# @omadia/plugin-channel-whatsapp

### Sprich mit deinen omadia-Agenten aus WhatsApp.

Ein signiertes omadia-Plugin, das WhatsApp über WhatsApp Web mit deinem Agenten-Team verbindet. Es koppelt sich per QR-Code als verknüpftes Gerät, ein WhatsApp-Business-API-Konto ist also nicht nötig.

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)
[![Built for omadia](https://img.shields.io/badge/built%20for-omadia-2496ED.svg)](https://github.com/byte5ai/omadia)
[![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[**Haupt-Repo**](https://github.com/byte5ai/omadia) · [**Website**](https://omadia.ai) · [**Plugin-Hub**](https://hub.omadia.ai) · [**Was es kann**](#was-es-kann) · [**Installation**](#installation)

🇬🇧 This guide is also available [in English](./README.md).

</div>

---

omadia ist ein selbst-hostbares agentisches OS: stelle Multi-Agent-Teams aus signierten Plugins zusammen, betreibe sie auf der eigenen Maschine und erhalte für jede Aktion eine nachvollziehbare Spur. Dieses Plugin macht diese Agenten aus WhatsApp erreichbar. Haupt-Repo: [byte5ai/omadia](https://github.com/byte5ai/omadia).

## Was es kann

Verbindet WhatsApp über WhatsApp Web (Baileys) mit omadia. Es koppelt sich per QR-Code als verknüpftes Gerät, ein WhatsApp-Business-API-Konto ist also nicht nötig. Einzelchats werden in den omadia-Orchestrator geleitet, und die Antwort kommt im selben Chat zurück. Du kannst Gruppen ignorieren und den Zugriff mit einer Nummern-Allowlist begrenzen.

## So funktioniert es in omadia

Ein Channel-Plugin (`kind: channel`). Der omadia-Kernel aktiviert es aus der `manifest.yaml`. Das Plugin öffnet eine WhatsApp-Web-Session, leitet jeden eingehenden Chat an den Orchestrator-Chat-Agenten weiter und sendet die Antwort zurück. Es braucht zuerst einen LLM-Provider, der dem Orchestrator zugewiesen ist.

## Installation

1. Installiere über den [Plugin-Hub](https://hub.omadia.ai) in der omadia-Admin-UI (Store, Upload), oder lade das gebaute ZIP direkt hoch.
2. Es gibt keinen API-Key. Fülle die unten stehenden Setup-Felder aus und starte das Plugin.
3. Scanne beim ersten Start den QR-Code mit WhatsApp auf dem Handy (Verknüpfte Geräte), um zu koppeln.

Weise dem Orchestrator zuerst einen LLM-Provider zu, sonst hat der Chat-Agent kein Modell für die Antwort.

## Konfiguration

| Setup-Feld | Hinweis |
| --- | --- |
| Device name | Wird unter Verknüpfte Geräte angezeigt. |
| Ignore groups | Gruppenchats überspringen. |
| Allowed numbers | Optionale Allowlist. |

## Aus dem Quellcode bauen

```bash
npm install
npm run build   # tsc, schreibt dist/
npm test        # prüft manifest.yaml gegen die Core-Invarianten
```

`@omadia/plugin-api` stellt der omadia-Host zur Laufzeit bereit (optionale Peer-Dep). Verlinke es aus einem lokalen omadia-Checkout zum Bauen. Aufbau siehe [byte5ai/omadia](https://github.com/byte5ai/omadia).

## Lizenz

[MIT](LICENSE), byte5 GmbH