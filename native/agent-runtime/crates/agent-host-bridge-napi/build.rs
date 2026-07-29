fn main() {
    napi_build::setup();
    let target = std::env::var("TARGET").expect("Cargo always provides TARGET");
    println!("cargo:rustc-env=AGENT_HOST_BRIDGE_TARGET={target}");
}
