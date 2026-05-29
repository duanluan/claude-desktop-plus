fn main() {
    if let Err(error) = claude_desktop_plus_lib::run_entrypoint() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
