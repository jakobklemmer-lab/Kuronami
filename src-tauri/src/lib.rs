use std::net::TcpStream;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, RunEvent};

const DEVUI_ADDR: &str = "127.0.0.1:8787";

/// Der DevUI-Server (`runtime/devui/server.ts`) läuft als Kindprozess dieser App. Er hält
/// keinen eigenen Zustand — das Fenster zeigt nur `http://localhost:8787`, und beim Beenden
/// der App wird der Prozess mitgenommen.
struct DevuiServer(Mutex<Option<Child>>);

/// Startet den Express-Server aus dem Projektbaum. Bei `tauri dev` ist das Arbeitsverzeichnis
/// `src-tauri/`; die Quelle liegt eine Ebene höher.
fn spawn_server() -> Option<Child> {
  let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
    .parent()?
    .to_path_buf();

  let mut cmd = Command::new("node");
  cmd
    .args(["--env-file=.env", "--import", "tsx", "runtime/devui/server.ts"])
    .current_dir(&root)
    .env("DEVUI_PORT", "8787");

  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW — kein aufblitzendes Konsolenfenster neben der App.
    cmd.creation_flags(0x0800_0000);
  }

  match cmd.spawn() {
    Ok(child) => {
      println!("[tauri] devui-Server gestartet (pid {})", child.id());
      Some(child)
    }
    Err(err) => {
      eprintln!("[tauri] devui-Server nicht gestartet: {err}. `pnpm devui` von Hand starten.");
      None
    }
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(
      tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        .build(),
    )
    .setup(|app| {
      app.manage(DevuiServer(Mutex::new(spawn_server())));
      // Das Fenster zeigt http://localhost:8787. Kurz warten, bis der Server antwortet,
      // sonst lädt die Webview einmal ins Leere und der Nutzer muss neu laden.
      for _ in 0..50 {
        if TcpStream::connect(DEVUI_ADDR).is_ok() {
          break;
        }
        std::thread::sleep(Duration::from_millis(100));
      }
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("Fehler beim Start der Tauri-Anwendung")
    .run(|app, event| {
      if let RunEvent::Exit = event {
        if let Some(state) = app.try_state::<DevuiServer>() {
          if let Ok(mut guard) = state.0.lock() {
            if let Some(mut child) = guard.take() {
              let _ = child.kill();
            }
          }
        }
      }
    });
}
