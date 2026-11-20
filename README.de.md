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

Verbindet WhatsApp über WhatsApp Web (Baileys) mit omadia. Es koppelt sich per QR-Code als verknüpftes Gerät, ein WhatsApp-Business-API-Konto ist also nicht nötig. Einzelchats werden in den omadia-Orchestrator geleitet, und die Antwort kommt im selben Chat zurück. Du kannst Gruppen ignorieren und den Zugriff mit einer Nummern-Allowlist begrenzen. Der Chat liest sich wie ein Gespräch mit einer Kollegin: Klartext, keine Status-Reaktionen, Fußzeilen oder Buttons. Längere Arbeit zeigt den Schreibindikator und nach etwa acht Sekunden eine kurze Bestätigung.

## So funktioniert es in omadia

Ein Channel-Plugin (`kind: channel`). Der omadia-Kernel aktiviert es aus der `manifest.yaml`. Das Plugin öffnet eine WhatsApp-Web-Session, leitet jeden eingehenden Chat an den Orchestrator-Chat-Agenten weiter und sendet die Antwort zurück. Es braucht zuerst einen LLM-Provider, der dem Orchestrator zugewiesen ist.

## Einen Agenten ansprechen

**Eine eigene Identität pro Agent wird nicht unterstützt.** Eine Installation ist eine verknüpfte WhatsApp-Nummer (eine Baileys-Session, eine QR-Kopplung), also sind alle Agenten über diese eine Nummer erreichbar. Eine eigene Nummer je Agent bräuchte eine Session je Agent: eigener Auth-State, eigene Kopplung, eigene Zuordnung von Nummer zu Agent. Das Plugin macht das nicht. Für den Betreiber hieße das außerdem eine Nummer und ein Telefon mit WhatsApp pro Agent, und jedes weitere inoffiziell verknüpfte Gerät erhöht das Risiko, dass WhatsApp es einschränkt.

Stattdessen wählst du den Agenten im Chat:

- `/agent` listet die Agenten, die dir in diesem Channel zur Verfügung stehen.
- `/agent Mira` wählt Mira für dich in dieser Unterhaltung. Der omadia-Kernel speichert die Auswahl und bestätigt sie einmal mit einer Systemnachricht. Auswählbar sind nur Agenten, die der Betreiber dir in WhatsApp freigegeben hat.
- Das Plugin parst den Befehl nicht. WhatsApp kennt keine nativen Bot-Befehle, der Text geht als normale Nachricht an den Kernel.

Wer spricht: Bei einem Agenten in einer Unterhaltung gibt es keine Namenszeile. Sprechen mehrere Agenten in einer Unterhaltung, oder ist es die erste Antwort nach einem Wechsel, beginnt die Antwort mit einer schlichten Namenszeile (`Mira: ...`). Der Beitrag einer Kollegin zu einer Antwort steht als einfache Zuordnung im Text (`Jonas: ...`), und Nachrichten des Systems selbst (zum Beispiel „dieser Agent steht dir nicht zur Verfügung“) sind Klartext ohne Agentennamen.

## Gruppen

Gruppen werden standardmäßig ignoriert (**Ignore groups** an). Ist das aus:

- Der Bot antwortet nur, wenn er @erwähnt wird, jemand auf eine seiner Nachrichten antwortet oder eine Nachricht mit `/agent` beginnt. Er antwortet nie auf jede Nachricht.
- Er antwortet nur, solange WhatsApp ihm die Mitgliederliste der Gruppe liefert. Sonst sagt er das einmal (höchstens alle 10 Minuten je Gruppe) und bleibt still. Das Plugin meldet dem Kernel die Mitgliederliste (`complete`, `partial` oder `unknown`); der Kernel entscheidet damit, was eine Antwort vor diesem Publikum enthalten darf.
- WhatsApp kann Mitglieder über eine Datenschutz-ID (`@lid`) statt der Telefonnummer ansprechen. Die Liste trägt dann diese ID, mit der Telefonnummer als `externalId`, wenn WhatsApp sie liefert.

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
npm run build   # bündelt dist/plugin.js und das Upload-ZIP
npm test        # node:test-Suiten (Sprecher, Klartext, Dekorationen, Gruppen)
```

`@omadia/channel-sdk` und `@omadia/plugin-api` stellt der omadia-Host zur Laufzeit bereit. Zum Typprüfen und Testen baust du sie in einem lokalen omadia-Checkout und zeigst die Tests darauf: `OMADIA_CHANNEL_SDK_DIST` und `OMADIA_PLUGIN_API_DIST` (Standard: `../middleware/packages/harness-channel-sdk/dist/index.js` und `../middleware/packages/plugin-api/dist/index.js`). Aufbau siehe [byte5ai/omadia](https://github.com/byte5ai/omadia).

## Lizenz

[MIT](LICENSE), byte5 GmbH