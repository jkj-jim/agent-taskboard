// 单实例通道，键为 {bundleIdentifier}:{profile}（document/design/desktop-app-packaging.md §4）。
// 同一 profile 的第二个实例把 focus 请求发给已在运行的那个然后退出；
// production、beta 和开发服务用不同的 socket，互不前置窗口。

use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;

const FOCUS_REQUEST: &[u8] = b"focus\n";

pub enum Acquired {
    Owner(UnixListener),
    AlreadyRunning,
}

// macOS 的 sun_path 只有 104 字节，而 App Data 下的 profile 目录本身就接近 100 字节，
// 所以 socket 放在按用户隔离的 TMPDIR 里，只用 profile 区分。
pub fn socket_path(profile: &str) -> PathBuf {
    std::env::temp_dir().join(format!("agent-taskboard-{profile}.sock"))
}

pub fn acquire(profile: &str) -> Result<Acquired, String> {
    let path = socket_path(profile);

    if path.exists() {
        match UnixStream::connect(&path) {
            Ok(mut stream) => {
                let _ = stream.write_all(FOCUS_REQUEST);
                return Ok(Acquired::AlreadyRunning);
            }
            // 连不上说明上一次是崩溃退出，socket 文件是残留物，可以安全接管。
            Err(_) => {
                let _ = std::fs::remove_file(&path);
            }
        }
    }

    let listener = UnixListener::bind(&path)
        .map_err(|error| format!("failed to claim the single-instance socket {path:?}: {error}"))?;
    Ok(Acquired::Owner(listener))
}

pub fn serve<F>(listener: UnixListener, on_focus: F)
where
    F: Fn() + Send + 'static,
{
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut request = [0_u8; FOCUS_REQUEST.len()];
            if stream.read_exact(&mut request).is_ok() && request == FOCUS_REQUEST {
                on_focus();
            }
        }
    });
}

pub fn release(profile: &str) {
    let _ = std::fs::remove_file(socket_path(profile));
}
