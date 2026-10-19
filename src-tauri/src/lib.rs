#[tauri::command]
fn estado_backend_local() -> &'static str {
    "SQLite local activo (offline-first)"
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![estado_backend_local])
        .run(tauri::generate_context!())
        .expect("Error al iniciar la aplicación de escritorio Tauri");
}
