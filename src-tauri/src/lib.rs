use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{LogicalPosition, LogicalSize, Manager, Position, Size, WebviewWindow};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let region: SharedHitRegion = Arc::new(Mutex::new(HitRegion::default()));

    tauri::Builder::default()
        .manage(region.clone())
        .invoke_handler(tauri::generate_handler![sync_hit_region, read_connector_info])
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

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
