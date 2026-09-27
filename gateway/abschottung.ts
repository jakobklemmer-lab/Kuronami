/**
 * Nur die eigenen MCP-Server — keine aus Jakobs claude.ai-Konto (2026-09-27).
 *
 * Claude Code lädt die Connectoren des angemeldeten Kontos von selbst dazu, unabhängig von
 * `settingSources`: in jedem Lauf dieses Hauses hingen **artlist, Atlassian Rovo und Claude Docs**
 * mit 152 Werkzeugen. Gefunden beim Messen der Übergabe: dieselben 10.000 Zeichen kosteten einmal
 * 7.700 Token, einmal 50.700 und einmal 7.700 plus 124.100 aus dem Cache — je nachdem, ob die
 * Connectoren schon verbunden waren, als die Anfrage hinausging. Mit diesem Schalter: 5.670, jedes
 * Mal. Kuros Sitzung trug ihre Anweisungen seit Wochen im Kontext, und Kuro hätte über artlist
 * Videos erzeugen oder in Atlassian schreiben können — mit Jakobs Guthaben und ohne dass es
 * irgendwo im Haus vorgesehen war.
 *
 * Zwei Riegel, weil einer nicht sicher alles trifft: `ENABLE_CLAUDEAI_MCP_SERVERS=false` schaltet
 * die Konto-Connectoren ab, `strictMcpConfig` alles außer dem, was der Lauf selbst übergibt
 * (`.mcp.json`, Nutzereinstellungen, Plugins). `env` ersetzt die Umgebung des Unterprozesses
 * ganz, daher die ganze `process.env` davor.
 */
export function nurEigeneServer(): {
  strictMcpConfig: true;
  env: Record<string, string | undefined>;
} {
  return { strictMcpConfig: true, env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" } };
}
