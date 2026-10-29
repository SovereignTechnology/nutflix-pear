//! `nutflix-iroh-helper --state <dir>`: the thin iroh process the desktop worker spawns
//! (ADR 0021; nfx ADR 0103 §2). It speaks framed messages on stdin/stdout and opens no socket
//! besides iroh's own. It moves bytes and decides nothing: README.md has the protocol and the
//! rules it keeps.

mod frames;
mod node;
mod ops;

use std::path::PathBuf;
use std::process::ExitCode;

/// Exit codes (README.md, "Exit codes").
pub const EXIT_USAGE: u8 = 2;
pub const EXIT_PROTOCOL: u8 = 65;
pub const EXIT_INTERNAL: u8 = 70;
pub const EXIT_IO: u8 = 74;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let state = match args.as_slice() {
        [flag, dir] if flag == "--state" => PathBuf::from(dir),
        _ => {
            eprintln!("usage: nutflix-iroh-helper --state <absolute dir>");
            return ExitCode::from(EXIT_USAGE);
        }
    };
    if !state.is_absolute() {
        eprintln!("nutflix-iroh-helper: --state must be an absolute path");
        return ExitCode::from(EXIT_USAGE);
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("nutflix-iroh-helper: runtime: {e}");
            return ExitCode::from(EXIT_INTERNAL);
        }
    };
    ExitCode::from(runtime.block_on(ops::serve(&state)))
}
