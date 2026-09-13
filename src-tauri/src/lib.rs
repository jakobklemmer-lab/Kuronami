use tauri::Manager;

/// Der Desktop-Wrapper (S29): **dieselbe Oberfläche wie im Browser**, nur in einem eigenen
/// Fenster.
///
/// ## Was sich gegenüber S12b geändert hat
///
/// Der Vorgänger dieses Wrappers zeigte die Wegwerf-DevUI (`runtime/devui/server.ts`) und startete
/// dafür einen Node-Kindprozess auf Port 8787. Das ist weggefallen: die Oberfläche aus `ui/` ist
/// seit Phase 6 ein Satz statischer Dateien (`ui/build.ts` → `ui/dist`, kein Bundler, kein
/// Server), und Tauri liefert sie direkt aus. Ein Kindprozess, der nur Dateien ausliefert, wäre
/// eine zweite bewegliche Stelle ohne Gegenwert.
///
/// ## Was die App ausdrücklich **nicht** mitbringt
///
/// Das Backend (Gateway, Runtime, Postgres) läuft weiterhin eigenständig — `pnpm gateway`. Diese
/// App ist das Fenster, nicht der Motor: ein Installer, der Postgres mitbrächte, wäre eine
/// Entscheidung über Betrieb und Datenhaltung, die S29 nicht trifft. Die Oberfläche spricht wie
/// im Browser über HTTP/WebSocket mit `localhost` (siehe die CSP in `tauri.conf.json`), und wenn
/// dort nichts läuft, sagt sie das genauso ehrlich wie im Browser.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            // Ohne diese Zeile startet das Fenster auf manchen Systemen hinter anderen Fenstern.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Fehler beim Start der Tauri-Anwendung");
}
