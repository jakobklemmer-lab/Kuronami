# `mcp.*` — MCP-Server absichern (S27)

Dynamisch entdeckte Tools von fremden MCP-Servern, mit lokal festgelegter Risikostufe je
Server statt einer aus der Fernbeschreibung geratenen.

| Datei | Aufgabe |
| --- | --- |
| `client.ts` | Minimaler MCP-Client über stdio (zeilenweises JSON-RPC 2.0), kein SDK |
| `tools.ts` | `createMcpTools`: macht aus entdeckten Fern-Tools native `ToolDefinition`s |

## Die drei Härtungsachsen (`tools.ts`)

1. **Risikostufe ist eine lokale, pro Server konfigurierte Obergrenze.** `McpServerConfig.risk`
   gilt für jedes Tool des Servers, unabhängig davon, was seine Beschreibung behauptet.
2. **Namensraum-Isolation durch Konstruktion.** Lokaler Name immer
   `mcp.<serverId>__<sanitierter Fernname>` — ein Fern-Tool kann keinen bestehenden Namen
   vortäuschen.
3. **Einmalige Entdeckung.** `tools/list` läuft genau einmal, beim Katalogbau
   (`createMcpTools`, aus `runtime/loop/api.ts`). Kein Weg, mitten in der Session erneut zu
   entdecken.

Eine vierte, kleinere Härtung: ein Fernfeld, das `path`/`url` heißt oder danach aussieht
(`policy/resource.ts`s `assertPolicyFieldNames`), wird vor der Registrierung umbenannt
(`<feld>_arg`) und beim Aufruf zurückübersetzt — sonst bekäme die Policy-Engine eine
Dateizonen-/Domain-Bedeutung vorgespiegelt, die für einen beliebigen MCP-Server nicht gilt.

## Warum kein SDK

Dieselbe Disziplin wie bei der Telegram-Bot-API (S16) und der n8n-Brücke (S13): der Transport
(`McpTransport`) ist vom Client getrennt und injizierbar, damit Tests ihn ohne echten
Kindprozess ersetzen können (`fetchImpl`-Prinzip).

## Bewusst nicht gebaut

Kein produktiv angebundener Server (welcher zuerst, ist weiterhin offen, Abschnitt 17); keine
MCP-Ressourcen/-Prompts, nur `tools/list`/`tools/call`; keine feinere Risikostufe je Fern-Tool
statt je Server; kein zweiter Transport (HTTP+SSE) neben Stdio.

Vollständige Begründung: `docs/ARCHITEKTUR.md`, Abschnitt 9, Unterabschnitt „MCP absichern".
