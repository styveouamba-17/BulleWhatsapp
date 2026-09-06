use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    LogicalPosition, LogicalSize, Manager, Position, Size, WebviewWindow,
};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

/// Largeur de la bande ancrée au bord droit de l'écran : assez pour la
/// bulle, le panneau déplié et une marge — voir --panel-w / --bubble-size
/// dans overlay/overlay.css.
const STRIP_WIDTH: f64 = 440.0;

/// Ancre la fenêtre en bande verticale le long du bord droit du moniteur
/// courant. La hauteur pleine écran couvre toute la plage de déplacement
/// vertical gérée côté JS (voir le drag dans overlay/overlay.js).
fn dock_to_screen_edge(window: &WebviewWindow) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let scale = monitor.scale_factor();
    let logical_w = monitor.size().width as f64 / scale;
    let logical_h = monitor.size().height as f64 / scale;
    let x = (logical_w - STRIP_WIDTH).max(0.0);

    let _ = window.set_size(Size::Logical(LogicalSize {
        width: STRIP_WIDTH,
        height: logical_h,
    }));
    let _ = window.set_position(Position::Logical(LogicalPosition { x, y: 0.0 }));
}

/// La bulle ne doit jamais prendre le focus clavier, même sur clic —
/// `focus: false` dans tauri.conf.json ne couvre que l'ouverture. Windows
/// exige le style étendu WS_EX_NOACTIVATE pour bloquer aussi l'activation
/// au clic ; WS_EX_TOOLWINDOW complète skipTaskbar (masque aussi de l'Alt-Tab).
#[cfg(target_os = "windows")]
fn apply_noactivate(window: &WebviewWindow) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    let Ok(handle) = window.window_handle() else {
        return;
    };
    let RawWindowHandle::Win32(win32) = handle.as_raw() else {
        return;
    };
    let hwnd = win32.hwnd.get() as *mut std::ffi::c_void;

    unsafe {
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(
            hwnd,
            GWL_EXSTYLE,
            ex_style | (WS_EX_NOACTIVATE as isize) | (WS_EX_TOOLWINDOW as isize),
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn apply_noactivate(_window: &WebviewWindow) {}

/* -------------------------------------------------------------------
   Click-through
   La bande couvre toute la hauteur de l'écran pour permettre le
   déplacement vertical de la bulle, mais elle est presque entièrement
   transparente : seules la bulle et, quand il est ouvert, le panneau
   doivent capter les clics. Le reste doit atteindre la fenêtre du
   dessous.

   set_ignore_cursor_events() s'applique à toute la fenêtre, pas à une
   région : une fois activé, la fenêtre ne reçoit plus aucun événement
   souris nulle part, donc un simple mousemove JS ne peut pas détecter
   le retour du curseur sur la bulle. On contourne ça par un suivi
   global du curseur côté Rust (GetCursorPos, indépendant de la
   fenêtre) comparé à la zone cliquable rapportée par l'overlay.
   ------------------------------------------------------------------- */

#[derive(Clone, Copy, Default)]
struct HitRegion {
    bubble_cx: f64,
    bubble_cy: f64,
    bubble_r: f64,
    panel_open: bool,
    panel_x: f64,
    panel_y: f64,
    panel_w: f64,
    panel_h: f64,
}

impl HitRegion {
    fn contains(&self, x: f64, y: f64) -> bool {
        let dx = x - self.bubble_cx;
        let dy = y - self.bubble_cy;
        let in_bubble = dx * dx + dy * dy <= self.bubble_r * self.bubble_r;
        let in_panel = self.panel_open
            && x >= self.panel_x
            && x <= self.panel_x + self.panel_w
            && y >= self.panel_y
            && y <= self.panel_y + self.panel_h;
        in_bubble || in_panel
    }
}

type SharedHitRegion = Arc<Mutex<HitRegion>>;

/// Appelé depuis l'overlay (overlay.js) à chaque changement visuel —
/// rendu, ouverture/fermeture du panneau, déplacement — avec les
/// coordonnées CSS (logiques) des zones cliquables actuelles.
#[tauri::command]
fn sync_hit_region(
    state: tauri::State<SharedHitRegion>,
    scale: f64,
    bubble_cx: f64,
    bubble_cy: f64,
    bubble_r: f64,
    panel_open: bool,
    panel_x: f64,
    panel_y: f64,
    panel_w: f64,
    panel_h: f64,
) {
    let mut region = state.lock().expect("hit region mutex empoisonné");
    *region = HitRegion {
        bubble_cx: bubble_cx * scale,
        bubble_cy: bubble_cy * scale,
        bubble_r: bubble_r * scale,
        panel_open,
        panel_x: panel_x * scale,
        panel_y: panel_y * scale,
        panel_w: panel_w * scale,
        panel_h: panel_h * scale,
    };
}

/* ---------------------------------------------------------------
   Découverte du connecteur
   Le connecteur choisit un port libre et un jeton à chaque lancement
   (voir connector/index.js) plutôt que le 8787 fixe d'origine, pour
   qu'un autre process local ne puisse pas s'y connecter à l'aveugle.
   Les deux processus n'ont pas de canal direct : le connecteur dépose
   l'info dans un fichier du dossier temp système, que l'overlay vient
   lire ici avant d'ouvrir le WebSocket.
   --------------------------------------------------------------- */

#[derive(serde::Serialize, serde::Deserialize)]
struct ConnectorInfo {
    port: u16,
    token: String,
}

#[tauri::command]
fn read_connector_info() -> Option<ConnectorInfo> {
    let path = std::env::temp_dir().join("bulle-connector.json");
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

/* ---------------------------------------------------------------
   Ouverture hors WebView
   Un lien reçu ou une image agrandie sortent de la bulle : navigateur
   et visionneuse du système, jamais dans la fenêtre du widget. Bulle
   n'a pas de stockage — le fichier temporaire est éphémère.
   --------------------------------------------------------------- */

const MEDIA_TMP_SUBDIR: &str = "bulle-media";

fn media_tmp_dir() -> std::path::PathBuf {
    std::env::temp_dir().join(MEDIA_TMP_SUBDIR)
}

/// Ouvre une URL dans le navigateur par défaut. http(s) uniquement :
/// l'overlay filtre déjà, on revérifie ici puisque la commande est
/// exposée à la WebView.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("URL refusée".into());
    }
    open::that(&url).map_err(|e| e.to_string())
}

/// Écrit un média (data URL base64) dans un fichier temporaire et l'ouvre
/// dans la visionneuse par défaut. Le dossier est vidé à chaque appel et
/// à la sortie de l'app ; un fichier encore verrouillé par la visionneuse
/// survivra jusqu'au prochain nettoyage — limite assumée.
#[tauri::command]
fn open_media(data_url: String, kind: String) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD, Engine};

    let payload = data_url
        .split_once(";base64,")
        .map(|(_, b64)| b64)
        .ok_or("data URL invalide")?;
    let bytes = STANDARD.decode(payload).map_err(|e| e.to_string())?;

    let ext = match kind.as_str() {
        "video" => "mp4",
        "sticker" => "webp",
        _ => "jpg",
    };

    let dir = media_tmp_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("{stamp}.{ext}"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    open::that(&path).map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
fn spawn_click_through_watcher(window: WebviewWindow, region: SharedHitRegion) {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    std::thread::spawn(move || {
        // La fenêtre part en ignore_cursor_events(true) (voir setup()) ;
        // on garde le même état ici pour ne pas ré-émettre inutilement.
        let mut ignoring = true;

        loop {
            std::thread::sleep(Duration::from_millis(30));

            let mut pt = POINT { x: 0, y: 0 };
            if unsafe { GetCursorPos(&mut pt) } == 0 {
                continue;
            }

            let Ok(win_pos) = window.outer_position() else {
                continue;
            };
            let local_x = (pt.x - win_pos.x) as f64;
            let local_y = (pt.y - win_pos.y) as f64;

            let inside = region
                .lock()
                .expect("hit region mutex empoisonné")
                .contains(local_x, local_y);

            if inside == ignoring {
                ignoring = !inside;
                let _ = window.set_ignore_cursor_events(ignoring);
            }
        }
    });
}

#[cfg(not(target_os = "windows"))]
fn spawn_click_through_watcher(_window: WebviewWindow, _region: SharedHitRegion) {}

/// Sans bordure, sans icône dans la barre des tâches, la bulle n'offre
/// aucun moyen normal de fermer l'app — seule une icône dans la zone de
/// notification permet de quitter proprement (et donc de déclencher
/// RunEvent::Exit, qui tue le sidecar avec elle).
fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&quit])?;

    TrayIconBuilder::new()
        .icon(Image::from_bytes(include_bytes!("../icons/32x32.png"))?)
        .menu(&menu)
        .tooltip("Bulle")
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "quit" {
                app.exit(0);
            }
        })
        .build(app)?;

    Ok(())
}

/* ---------------------------------------------------------------
   Sidecar — le connecteur
   Compilé en exécutable unique par bun (voir scripts/build-sidecar.mjs)
   et déclaré en externalBin dans tauri.conf.json : un seul installeur,
   un process qui meurt avec l'app plutôt qu'un `node index.js` séparé
   à lancer à la main.

   Relancé automatiquement s'il meurt (crash, tué de l'extérieur) —
   c'était le morceau de la phase 3 laissé de côté, plus naturel une
   fois le connecteur géré ici plutôt qu'en process indépendant.
   --------------------------------------------------------------- */

type SharedConnectorChild = Arc<Mutex<Option<CommandChild>>>;

fn spawn_connector_sidecar(app: tauri::AppHandle, child_state: SharedConnectorChild) {
    tauri::async_runtime::spawn(async move {
        loop {
            let sidecar = match app.shell().sidecar("bulle-connector") {
                Ok(cmd) => cmd,
                Err(err) => {
                    eprintln!("Sidecar bulle-connector introuvable : {err}");
                    return;
                }
            };

            let (mut rx, child) = match sidecar.spawn() {
                Ok(pair) => pair,
                Err(err) => {
                    eprintln!("Démarrage du connecteur impossible : {err}");
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    continue;
                }
            };
            *child_state.lock().expect("connector child mutex empoisonné") = Some(child);

            while let Some(event) = rx.recv().await {
                if matches!(event, CommandEvent::Terminated(_)) {
                    break;
                }
            }
            *child_state.lock().expect("connector child mutex empoisonné") = None;

            // Laisse un souffle avant de relancer, pour ne pas boucler à
            // vide si le connecteur meurt immédiatement au démarrage.
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let region: SharedHitRegion = Arc::new(Mutex::new(HitRegion::default()));
    let connector_child: SharedConnectorChild = Arc::new(Mutex::new(None));
    let connector_child_for_exit = connector_child.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_shell::init())
        .manage(region.clone())
        .invoke_handler(tauri::generate_handler![
            sync_hit_region,
            read_connector_info,
            open_url,
            open_media
        ])
        .setup(move |app| {
            let window = app
                .get_webview_window("main")
                .expect("fenêtre principale absente de tauri.conf.json");

            dock_to_screen_edge(&window);
            let _ = window.set_ignore_cursor_events(true);
            spawn_click_through_watcher(window.clone(), region.clone());
            // Après show() : tao réapplique ses propres styles de fenêtre
            // pendant l'affichage initial, ce qui écrase WS_EX_NOACTIVATE
            // si on le pose avant.
            let _ = window.show();
            apply_noactivate(&window);

            setup_tray(app.handle())?;
            spawn_connector_sidecar(app.handle().clone(), connector_child.clone());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |_app_handle, event| {
        // Un kill forcé (Task Manager, taskkill /F) ne passe jamais par
        // ici — même limite que côté connecteur (voir authCrypt.js) : ça
        // laisse le sidecar orphelin. Rien à faire de plus sans détecter
        // ce cas depuis l'extérieur du process lui-même.
        if let tauri::RunEvent::Exit = event {
            if let Some(child) = connector_child_for_exit
                .lock()
                .expect("connector child mutex empoisonné")
                .take()
            {
                let _ = child.kill();
            }
            // Médias temporaires ouverts en visionneuse : rien à en garder.
            let _ = std::fs::remove_dir_all(media_tmp_dir());
        }
    });
}
