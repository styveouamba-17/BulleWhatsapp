fn main() {
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(&["sync_hit_region", "read_connector_info"]));
    tauri_build::try_build(attributes).expect("échec de la génération Tauri");
}
