use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::Manager;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendConfigResponse {
    pub activo: bool,
    pub base_url: Option<String>,
    pub boot_token: Option<String>,
    pub data_dir: Option<String>,
    pub error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MensajeListoBackend {
    pos_backend_ready: Option<bool>,
    port: Option<u16>,
}

struct BackendState {
    proceso: Mutex<Option<Child>>,
    stdin_pipe: Mutex<Option<ChildStdin>>,
    port: Option<u16>,
    config: BackendConfigResponse,
}

fn normalizar_ruta_windows(ruta: &Path) -> PathBuf {
    let texto = ruta.to_string_lossy();
    if let Some(sin_prefijo) = texto.strip_prefix(r"\\?\") {
        PathBuf::from(sin_prefijo)
    } else {
        ruta.to_path_buf()
    }
}

fn generar_boot_token_hex() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("No se pudo generar token aleatorio: {e}"))?;
    let mut hex = String::with_capacity(64);
    for b in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{:02x}", b);
    }
    Ok(hex)
}

#[cfg(not(debug_assertions))]
fn probar_directorio_escribible(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let test_file = dir.join(".pos_write_test");
    match fs::write(&test_file, b"ok") {
        Ok(_) => {
            let _ = fs::remove_file(&test_file);
            true
        }
        Err(_) => false,
    }
}

#[cfg(not(debug_assertions))]
fn resolver_directorio_datos_escribible(app: &tauri::App) -> Result<PathBuf, String> {
    let mut candidatos: Vec<PathBuf> = Vec::new();
    if let Ok(local_dir) = app.path().app_local_data_dir() {
        candidatos.push(normalizar_ruta_windows(&local_dir).join("data"));
    }
    if let Ok(roaming_dir) = app.path().app_data_dir() {
        candidatos.push(normalizar_ruta_windows(&roaming_dir).join("data"));
    }
    candidatos.push(
        normalizar_ruta_windows(&std::env::temp_dir())
            .join("ar.com.puntodeventas.pos")
            .join("data"),
    );

    for candidato in candidatos {
        if probar_directorio_escribible(&candidato) {
            return Ok(candidato);
        }
    }

    Err("No se encontró una carpeta con permisos de escritura para la base de datos local.".to_string())
}

#[cfg(not(debug_assertions))]
fn iniciar_sidecar_backend(app: &tauri::App) -> BackendState {
    let resource_dir = match app.path().resource_dir() {
        Ok(dir) => normalizar_ruta_windows(&dir),
        Err(e) => {
            return BackendState {
                proceso: Mutex::new(None),
                stdin_pipe: Mutex::new(None),
                port: None,
                config: BackendConfigResponse {
                    activo: false,
                    base_url: None,
                    boot_token: None,
                    data_dir: None,
                    error: Some(format!(
                        "No se pudo resolver la carpeta de recursos de la aplicación: {e}"
                    )),
                },
            };
        }
    };

    let bundle_dir = resource_dir.join("backend-bundle");
    let nombre_node = if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    };
    let node_bin = bundle_dir.join(nombre_node);
    let server_script = bundle_dir.join("server.mjs");

    if !node_bin.exists() || !server_script.exists() {
        return BackendState {
            proceso: Mutex::new(None),
            stdin_pipe: Mutex::new(None),
            port: None,
            config: BackendConfigResponse {
                activo: false,
                base_url: None,
                boot_token: None,
                data_dir: None,
                error: Some(format!(
                    "Falta el motor de base de datos local en {}",
                    bundle_dir.display()
                )),
            },
        };
    }

    let data_dir = match resolver_directorio_datos_escribible(app) {
        Ok(dir) => dir,
        Err(e) => {
            return BackendState {
                proceso: Mutex::new(None),
                stdin_pipe: Mutex::new(None),
                port: None,
                config: BackendConfigResponse {
                    activo: false,
                    base_url: None,
                    boot_token: None,
                    data_dir: None,
                    error: Some(e),
                },
            };
        }
    };

    let boot_token = match generar_boot_token_hex() {
        Ok(t) => t,
        Err(e) => {
            return BackendState {
                proceso: Mutex::new(None),
                stdin_pipe: Mutex::new(None),
                port: None,
                config: BackendConfigResponse {
                    activo: false,
                    base_url: None,
                    boot_token: None,
                    data_dir: Some(data_dir.to_string_lossy().to_string()),
                    error: Some(e),
                },
            };
        }
    };

    let mut cmd = Command::new(&node_bin);
    cmd.arg("--no-warnings")
        .arg(&server_script)
        .current_dir(&bundle_dir)
        .env("POS_DATA_DIR", &data_dir)
        .env("POS_RESOURCES_DIR", &bundle_dir)
        .env("POS_BOOT_TOKEN", &boot_token)
        .env("POS_PORT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return BackendState {
                proceso: Mutex::new(None),
                stdin_pipe: Mutex::new(None),
                port: None,
                config: BackendConfigResponse {
                    activo: false,
                    base_url: None,
                    boot_token: None,
                    data_dir: Some(data_dir.to_string_lossy().to_string()),
                    error: Some(format!(
                        "No se pudo iniciar el servidor local de base de datos: {e}"
                    )),
                },
            };
        }
    };

    let stdin_pipe = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let (tx_err, rx_err) = mpsc::channel::<String>();
    if let Some(err_stream) = stderr {
        std::thread::spawn(move || {
            let reader = BufReader::new(err_stream);
            let mut acumulado = String::new();
            for linea in reader.lines().map_while(Result::ok) {
                if acumulado.len() < 1024 {
                    if !acumulado.is_empty() {
                        acumulado.push('\n');
                    }
                    acumulado.push_str(&linea);
                }
            }
            if !acumulado.is_empty() {
                let _ = tx_err.send(acumulado);
            }
        });
    }

    let (tx_port, rx_port) = mpsc::channel::<Result<u16, String>>();
    if let Some(out_stream) = stdout {
        std::thread::spawn(move || {
            let reader = BufReader::new(out_stream);
            let mut notificado = false;
            for linea in reader.lines().map_while(Result::ok) {
                if !notificado {
                    if let Ok(parsed) = serde_json::from_str::<MensajeListoBackend>(&linea) {
                        if parsed.pos_backend_ready == Some(true) {
                            if let Some(p) = parsed.port {
                                let _ = tx_port.send(Ok(p));
                                notificado = true;
                            }
                        }
                    }
                }
            }
            if !notificado {
                let _ = tx_port.send(Err(
                    "El motor de base de datos local finalizó antes de quedar listo.".to_string(),
                ));
            }
        });
    } else {
        let _ = tx_port.send(Err("No se pudo leer la salida del servidor local.".to_string()));
    }

    match rx_port.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(port)) => BackendState {
            proceso: Mutex::new(Some(child)),
            stdin_pipe: Mutex::new(stdin_pipe),
            port: Some(port),
            config: BackendConfigResponse {
                activo: true,
                base_url: Some(format!("http://127.0.0.1:{port}")),
                boot_token: Some(boot_token),
                data_dir: Some(data_dir.to_string_lossy().to_string()),
                error: None,
            },
        },
        Ok(Err(msg)) => {
            let detalle_err = rx_err.try_recv().ok();
            let _ = child.kill();
            let _ = child.wait();
            let completo = match detalle_err {
                Some(d) => format!("{msg} ({d})"),
                None => msg,
            };
            BackendState {
                proceso: Mutex::new(None),
                stdin_pipe: Mutex::new(None),
                port: None,
                config: BackendConfigResponse {
                    activo: false,
                    base_url: None,
                    boot_token: None,
                    data_dir: Some(data_dir.to_string_lossy().to_string()),
                    error: Some(completo),
                },
            }
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            BackendState {
                proceso: Mutex::new(None),
                stdin_pipe: Mutex::new(None),
                port: None,
                config: BackendConfigResponse {
                    activo: false,
                    base_url: None,
                    boot_token: None,
                    data_dir: Some(data_dir.to_string_lossy().to_string()),
                    error: Some(
                        "Tiempo de espera agotado al iniciar la base de datos local.".to_string(),
                    ),
                },
            }
        }
    }
}

#[cfg(debug_assertions)]
fn iniciar_sidecar_backend(_app: &tauri::App) -> BackendState {
    // En desarrollo (`tauri dev`) el backend corre integrado en Vite (`http://localhost:1420/api/pos`)
    BackendState {
        proceso: Mutex::new(None),
        stdin_pipe: Mutex::new(None),
        port: None,
        config: BackendConfigResponse {
            activo: false,
            base_url: None,
            boot_token: None,
            data_dir: None,
            error: None,
        },
    }
}

#[tauri::command]
fn estado_backend_local() -> &'static str {
    "SQLite local activo (offline-first)"
}

#[tauri::command]
fn obtener_config_backend_local(state: tauri::State<'_, BackendState>) -> BackendConfigResponse {
    state.config.clone()
}

#[tauri::command]
fn invocar_pos_backend_local(
    state: tauri::State<'_, BackendState>,
    accion: String,
    payload: serde_json::Value,
    session_token: Option<String>,
) -> Result<serde_json::Value, String> {
    if let Some(ref err) = state.config.error {
        return Err(err.clone());
    }
    let port = state
        .port
        .ok_or_else(|| "BACKEND_NO_ACTIVO: El servidor local no está activo.".to_string())?;
    let boot_token = state.config.boot_token.clone().unwrap_or_default();

    let body_json = serde_json::json!({
        "accion": accion,
        "payload": payload,
    });
    let body_bytes = serde_json::to_vec(&body_json)
        .map_err(|e| format!("Error serializando solicitud local: {e}"))?;

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5))
        .map_err(|e| format!("No se pudo conectar al motor de base de datos local: {e}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(60)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(15)));

    let mut request_header = format!(
        "POST /api/pos HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nX-POS-Boot-Token: {}\r\n",
        body_bytes.len(),
        boot_token
    );
    if let Some(tok) = session_token {
        let limpio = tok.trim();
        if !limpio.is_empty() {
            request_header.push_str(&format!("X-POS-Session: {limpio}\r\n"));
        }
    }
    request_header.push_str("\r\n");

    stream
        .write_all(request_header.as_bytes())
        .and_then(|_| stream.write_all(&body_bytes))
        .and_then(|_| stream.flush())
        .map_err(|e| format!("Error enviando solicitud al motor de base de datos local: {e}"))?;

    let mut response_bytes = Vec::new();
    stream
        .read_to_end(&mut response_bytes)
        .map_err(|e| format!("Error leyendo respuesta del motor de base de datos local: {e}"))?;

    let sep = b"\r\n\r\n";
    let body_slice = response_bytes
        .windows(sep.len())
        .position(|w| w == sep)
        .map(|idx| &response_bytes[idx + sep.len()..])
        .unwrap_or(&response_bytes[..]);

    serde_json::from_slice::<serde_json::Value>(body_slice)
        .map_err(|e| format!("Respuesta inválida del motor de base de datos local: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let estado = iniciar_sidecar_backend(app);
            app.manage(estado);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            estado_backend_local,
            obtener_config_backend_local,
            invocar_pos_backend_local
        ])
        .build(tauri::generate_context!())
        .expect("Error al construir la aplicación de escritorio Tauri");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<BackendState>() {
                if let Ok(mut guard_stdin) = state.stdin_pipe.lock() {
                    let _ = guard_stdin.take();
                }
                if let Ok(mut guard_proc) = state.proceso.lock() {
                    if let Some(mut child) = guard_proc.take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        }
    });
}
